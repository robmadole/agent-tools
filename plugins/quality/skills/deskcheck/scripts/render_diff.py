#!/usr/bin/env python3
"""Render a file's diff against a merge target as syntax-highlighted HTML hunks.

CLI:
    render_diff.py --repo /path/to/repo --target main --file lib/foo.ex [--json]

Prints composable HTML fragments (one per hunk), or with --json a list of
{"index", "header", "html"} objects. Importable as a module: render_file().

The diff base is always `git merge-base <target> HEAD`, so uncommitted working
tree changes are included and commits on the target after branching are not.
Syntax highlighting uses pygments when importable; otherwise plain escaped text.
"""
import argparse
import difflib
import hashlib
import html
import json
import mimetypes
import re
import subprocess

try:
    from pygments.lexers import get_lexer_for_filename
    from pygments.token import STANDARD_TYPES
except ImportError:
    get_lexer_for_filename = None

HUNK_RE = re.compile(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@')


def _git(repo, *args):
    return subprocess.run(
        ['git', '-C', repo, *args], capture_output=True, text=True, check=True
    ).stdout


def merge_base(repo, target):
    return _git(repo, 'merge-base', target, 'HEAD').strip()


def _lexer_for(path):
    if get_lexer_for_filename is None:
        return None
    try:
        return get_lexer_for_filename(path, stripnl=False)
    except Exception:
        return None


def _css_class(ttype):
    while ttype not in STANDARD_TYPES:
        ttype = ttype.parent
    return STANDARD_TYPES[ttype]


def _render_line(text, lexer, ranges=()):
    """Escape + syntax-highlight one line, wrapping changed char ranges in .emph."""
    if not text:
        return ''

    def in_emph(pos):
        return any(s <= pos < e for s, e in ranges)

    pts = sorted({p for r in ranges for p in r if 0 < p < len(text)})

    def piece(chunk, css, emph):
        out = html.escape(chunk)
        if css:
            out = f'<span class="{css}">{out}</span>'
        if emph:
            out = f'<span class="emph">{out}</span>'
        return out

    def cuts(start, end):
        edges = [start] + [p for p in pts if start < p < end] + [end]
        return zip(edges, edges[1:])

    if lexer is not None:
        try:
            return ''.join(
                piece(val[a - idx:b - idx], _css_class(ttype), in_emph(a))
                for idx, ttype, val in lexer.get_tokens_unprocessed(text)
                for a, b in cuts(idx, idx + len(val)))
        except Exception:
            pass
    return ''.join(piece(text[a:b], '', in_emph(a)) for a, b in cuts(0, len(text)))


def _pair_ranges(lines):
    """Char ranges that changed between paired -/+ lines, keyed by line position.

    Pairs the k-th line of a removal run with the k-th line of the addition run
    that immediately follows it (GitHub-style), and only emphasizes pairs that
    are mostly the same line (ratio >= 0.5) — wholly rewritten lines read
    better as plain add/del.
    """
    ranges = {}
    i = 0
    while i < len(lines):
        if lines[i][:1] != '-':
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j][:1] == '-':
            j += 1
        k = j
        while k < len(lines) and lines[k][:1] == '+':
            k += 1
        for d, a in zip(range(i, j), range(j, k)):
            old, new = lines[d][1:], lines[a][1:]
            sm = difflib.SequenceMatcher(None, old, new, autojunk=False)
            if sm.ratio() < 0.5:
                continue
            old_r, new_r = [], []
            for op, i1, i2, j1, j2 in sm.get_opcodes():
                if op != 'equal':
                    if i2 > i1:
                        old_r.append((i1, i2))
                    if j2 > j1:
                        new_r.append((j1, j2))
            ranges[d], ranges[a] = old_r, new_r
        i = k
    return ranges


def parse_hunks(diff_text):
    hunks = []
    cur = None
    for line in diff_text.splitlines():
        m = HUNK_RE.match(line)
        if m:
            cur = {'header': line, 'old': int(m.group(1)),
                   'new': int(m.group(2)), 'lines': []}
            hunks.append(cur)
        elif line.startswith('diff --git'):
            cur = None
        elif cur is not None and line[:1] in ('+', '-', ' ', '\\'):
            cur['lines'].append(line)
    return hunks


def render_hunk(hunk, lexer):
    rows = []
    old_ln, new_ln = hunk['old'], hunk['new']
    emph = _pair_ranges(hunk['lines'])
    for pos, line in enumerate(hunk['lines']):
        tag, text = line[0], line[1:]
        if tag == '\\':
            rows.append('<tr class="meta"><td class="ln"></td><td class="ln"></td>'
                        f'<td class="sign"></td><td class="code">{html.escape(line)}</td></tr>')
            continue
        code = _render_line(text, lexer, emph.get(pos, ())) or '&nbsp;'
        if tag == '+':
            rows.append(f'<tr class="add"><td class="ln"></td><td class="ln">{new_ln}</td>'
                        f'<td class="sign">+</td><td class="code">{code}</td></tr>')
            new_ln += 1
        elif tag == '-':
            rows.append(f'<tr class="del"><td class="ln">{old_ln}</td><td class="ln"></td>'
                        f'<td class="sign">-</td><td class="code">{code}</td></tr>')
            old_ln += 1
        else:
            rows.append(f'<tr><td class="ln">{old_ln}</td><td class="ln">{new_ln}</td>'
                        f'<td class="sign"></td><td class="code">{code}</td></tr>')
            old_ln += 1
            new_ln += 1
    return '<table class="diff"><tbody>' + ''.join(rows) + '</tbody></table>'


def _diff_entries(diff, path):
    """Parse one file's diff text into hunk entries WITHOUT rendering HTML.

    Each entry has 'index', 'id', 'header', plus the raw material for
    hunk_html(). `id` is a content hash (12 hex chars, `-N` suffix on
    duplicates), so review marks keyed on it survive hunk reordering and
    invalidate when the content actually changes. `index` remains the
    human-facing 0-based position used when authoring sections.json.
    """
    if not diff.strip():
        return []
    if '@@' not in diff:
        # binary or otherwise undiffable — decline to render rather than
        # parroting git's "Binary files ... differ" plumbing message.
        # Hash normalized lines: bulk and single-file git output differ only
        # in trailing newlines, and the id must match across both paths.
        digest = hashlib.sha1(
            '\n'.join(diff.splitlines()).encode()).hexdigest()[:12]
        mime = mimetypes.guess_type(path)[0] or 'binary'
        note = html.escape(f'Binary file — no diff to display ({mime}). '
                           'Review it in your editor if needed.')
        return [{'index': 0, 'id': digest, 'header': path,
                 'binary': True, 'binary_note': note}]
    out, seen = [], {}
    for i, h in enumerate(parse_hunks(diff)):
        digest = hashlib.sha1('\n'.join(h['lines']).encode()).hexdigest()[:12]
        n = seen.get(digest, 0)
        seen[digest] = n + 1
        out.append({'index': i, 'id': digest if n == 0 else f'{digest}-{n}',
                    'header': h['header'], 'hunk': h})
    return out


def file_hunks(repo, target, path, base=None):
    base = base or merge_base(repo, target)
    return _diff_entries(_git(repo, 'diff', '--no-color', base, '--', path), path)


def new_side(repo, base, path, ref=None):
    """The file's content exactly as git's diff presents it.

    Extracted from `git diff -U999999` (context + added lines), NOT read from
    disk — so clean filters, CRLF handling, staged-vs-unstaged state, and
    deletions (empty result) all match what the reviewer actually saw.
    With `ref`, extracts the content as of that commit instead of the
    working tree (used to reconstruct historical review snapshots).
    """
    args = ['diff', '--no-color', '-U999999', base] + ([ref] if ref else [])
    diff = _git(repo, *args, '--', path)
    lines = []
    for h in parse_hunks(diff):
        for line in h['lines']:
            if line[:1] in (' ', '+'):
                lines.append(line[1:])
    return '\n'.join(lines)


def multi_file_hunks(repo, target, paths, base=None):
    """file_hunks() for many paths via ONE git subprocess (page-build fast path)."""
    base = base or merge_base(repo, target)
    diff = _git(repo, 'diff', '--no-color', base, '--', *paths)
    chunks, cur = {}, None
    for line in diff.splitlines():
        if line.startswith('diff --git '):
            # ponytail: ' b/' split mishandles paths containing ' b/' — vanishingly rare
            cur = line[line.index(' b/') + 3:]
            chunks[cur] = [line]
        elif cur is not None:
            chunks[cur].append(line)
    return {p: _diff_entries('\n'.join(chunks.get(p, [])), p) for p in paths}


def hunk_html(entry, lexer):
    """Render one file_hunks() entry to HTML (the expensive step)."""
    if 'binary_note' in entry:
        return f'<div class="binary-note">{entry["binary_note"]}</div>'
    return render_hunk(entry['hunk'], lexer)


def context_rows(repo, base, path, new_start, old_start, count):
    """Render `count` unchanged context lines as diff <tr>s — the collapsed
    lines between hunks that GitHub lets you expand.

    Source is `new_side()` (the full file exactly as the diff presents it),
    1-indexed by new-line number. In an unchanged region old and new advance
    together, so `old_start` just tracks alongside. Rows match render_hunk's
    context-row markup so they drop straight into a `<table class="diff">`.
    Returns (html, total_new_lines) — total lets the caller bound the trailing
    (to-EOF) gap it can't size from hunk headers alone.
    """
    content = new_side(repo, base, path)
    lines = content.split('\n') if content else []
    total = len(lines)
    lexer = _lexer_for(path)
    rows, o, n = [], old_start, new_start
    for i in range(new_start - 1, min(new_start - 1 + count, total)):
        code = _render_line(lines[i], lexer) or '&nbsp;'
        rows.append(f'<tr><td class="ln">{o}</td><td class="ln">{n}</td>'
                    f'<td class="sign"></td><td class="code">{code}</td></tr>')
        o += 1
        n += 1
    return ''.join(rows), total


def render_file(repo, target, path, base=None):
    """Parse + render: list of {'index', 'id', 'header', 'html'} for one file."""
    entries = file_hunks(repo, target, path, base=base)
    lexer = _lexer_for(path)
    return [{'index': e['index'], 'id': e['id'], 'header': e['header'],
             'html': hunk_html(e, lexer)} for e in entries]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', default='.')
    ap.add_argument('--target', default='main')
    ap.add_argument('--file', required=True)
    ap.add_argument('--json', action='store_true',
                    help='emit JSON [{index, header, html}] instead of raw HTML')
    a = ap.parse_args()
    hunks = render_file(a.repo, a.target, a.file)
    if a.json:
        print(json.dumps(hunks, indent=2))
    else:
        for h in hunks:
            print(f'<div class="hunk"><div class="hunk-head"><code class="hunk-header">'
                  f'{html.escape(h["header"])}</code></div>{h["html"]}</div>')


if __name__ == '__main__':
    main()
