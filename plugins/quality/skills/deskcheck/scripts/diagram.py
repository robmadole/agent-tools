#!/usr/bin/env python3
"""Generate per-section module maps (Mermaid) for the deskcheck review UI.

Reads <workspace>/sections.json, inspects the branch diff, and writes
<workspace>/diagrams.json: one Mermaid graph per section whose nodes are the
section's files, with source->test pairing edges, an ⚠ on sources that have no
test anywhere, directory grouping, per-file change status, and hunk counts.
Each node carries a click directive that jumps to the file's diff in the UI.

    diagram.py --workspace <ws> --repo <repo> --target <branch>
    diagram.py --check      # self-test, prints PASS

Independent of the server — run it any time; it just (re)writes diagrams.json.
The server spawns it in the background on startup, so generation never blocks
serving. Stdlib only (imports diff helpers from render_diff in this dir).
"""
import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_diff import _git, merge_base, multi_file_hunks

TEST_DIRS = {'test', 'tests', 'spec', 'specs', '__tests__'}
DOC_EXT = {'md', 'rst', 'txt', 'adoc'}
DOC_NAMES = {'README', 'LICENSE', 'CHANGELOG', 'NOTICE', 'AUTHORS'}
CONFIG_EXT = {'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'lock',
              'env', 'xml', 'properties'}
CONFIG_NAMES = {'Dockerfile', 'Makefile', '.gitignore', '.editorconfig'}

# GitHub-ish hexes matching the UI's light theme (template.html :root vars).
CLASSDEFS = [
    '  classDef added fill:#e6ffec,stroke:#1a7f37,color:#1f2328;',
    '  classDef modified fill:#ffffff,stroke:#0969da,color:#1f2328;',
    '  classDef deleted fill:#ffebe9,stroke:#cf222e,color:#1f2328;',
    '  classDef testnode fill:#faf5ff,stroke:#8250df,color:#1f2328;',
    '  classDef untested stroke:#bf8700,stroke-width:3px,stroke-dasharray:4 3;',
]
STATUS_CLASS = {'A': 'added', 'D': 'deleted'}  # everything else -> modified
STATUS_WORD = {'A': 'added', 'M': 'modified', 'D': 'deleted',
               'R': 'renamed', 'C': 'copied'}


# ---- pure classification / pairing (git-free, so --check covers them) -------

def _is_test_name(name):
    low = name.lower()
    base = name.rsplit('.', 1)[0]  # drop the final extension
    lbase = base.lower()
    if low.startswith('test_') or low.startswith('test-'):
        return True
    if any(lbase.endswith(sfx) for sfx in ('_test', '-test', '_spec', '-spec')):
        return True
    if '.test.' in low or '.spec.' in low:
        return True
    if any(base.endswith(sfx) for sfx in ('Test', 'Tests', 'Spec', 'Specs')):
        return True
    return lbase in ('test', 'spec')


def classify(path):
    """test | source | config | doc | other — path/name heuristics only."""
    parts = path.split('/')
    name = parts[-1]
    if any(p.lower() in TEST_DIRS for p in parts[:-1]):
        return 'test'
    if _is_test_name(name):
        return 'test'
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in DOC_EXT or name in DOC_NAMES:
        return 'doc'
    if ext in CONFIG_EXT or name in CONFIG_NAMES or name.endswith('.lock'):
        return 'config'
    return 'source'


def stem_of(path):
    """Module identity used to pair a source with its test (casefolded).

    Strips test affixes so tokens.py, test_tokens.py, tokens_test.py and
    Foo.test.tsx / FooTest.java all reduce to the source's stem.
    """
    name = os.path.basename(path)
    name = re.sub(r'\.(test|spec)\.', '.', name, flags=re.I)  # Foo.test.tsx -> Foo.tsx
    stem = name.split('.')[0]                                 # -> Foo ; tokens.py -> tokens
    stem = re.sub(r'^test[_-]', '', stem, flags=re.I)
    stem = re.sub(r'[_-](test|spec)$', '', stem, flags=re.I)
    stem = re.sub(r'(Tests?|Specs?)$', '', stem)              # PascalCase FooTest -> Foo
    return stem.casefold()


def _dir_overlap(a, b):
    da, db = os.path.dirname(a).split('/'), os.path.dirname(b).split('/')
    n = 0
    for x, y in zip(da, db):
        if x != y:
            break
        n += 1
    return n


def pair_sources_tests(nodes):
    """[(source_id, test_id)] — each in-section test linked to its source."""
    sources = [n for n in nodes if n['kind'] == 'source']
    tests = [n for n in nodes if n['kind'] == 'test']
    edges = []
    for t in tests:
        ts = stem_of(t['path'])
        cands = [s for s in sources if stem_of(s['path']) == ts]
        if not cands:
            continue
        best = max(cands, key=lambda s: _dir_overlap(s['path'], t['path']))
        edges.append((best['id'], t['id']))
    return edges


def esc_label(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def _node_label(n):
    # No untested glyph here — the client injects a "no test" icon into these
    # nodes (progressive enhancement); the untested class's dashed border is the
    # baseline signal that always shows.
    name = esc_label(os.path.basename(n['path']))
    if n['hunks'] == 0:
        sub = 'not in diff'
    else:
        h = f'{n["hunks"]} hunk' + ('' if n['hunks'] == 1 else 's')
        word = STATUS_WORD.get(n['status'][:1], '')
        sub = f'{word} · {h}' if word else h
    return f'{name}<br/>{sub}'


def _node_classes(n):
    # Returns a list, emitted as one `class` statement each — Mermaid reads a
    # comma in `class X a,b` as *node ids*, not multiple classes, so a combined
    # "a,b" token matches no classDef. Separate statements accumulate correctly.
    c = []
    if n['kind'] == 'test':
        c.append('testnode')
    elif n['status']:
        c.append(STATUS_CLASS.get(n['status'][:1], 'modified'))
    if n.get('untested'):
        c.append('untested')
    return c


def render_mermaid(nodes, edges):
    groups = OrderedDict()
    for n in nodes:
        groups.setdefault(os.path.dirname(n['path']) or '.', []).append(n)
    lines = ['graph LR']
    for gi, (d, gnodes) in enumerate(groups.items()):
        lines.append(f'  subgraph sg{gi}["{esc_label(d if d != "." else "(root)")}"]')
        for n in gnodes:
            lines.append(f'    {n["id"]}["{_node_label(n)}"]')
        lines.append('  end')
    for src, tst in edges:
        lines.append(f'  {src} -.->|tested by| {tst}')
    for n in nodes:
        for cls in _node_classes(n):
            lines.append(f'  class {n["id"]} {cls}')
    lines.extend(CLASSDEFS)
    # Clicks are wired in the client from the node element id, not via
    # `click … call` — that binding is version-fragile and needs securityLevel
    # loose; a plain onclick per node (see the template) is robust.
    return '\n'.join(lines)


def build_model(sec_id, paths, status_map, hunk_counts, repo_test_stems):
    """Pure: (section id, its file paths, and lookups) -> {mermaid, nodes}."""
    nodes = []
    for i, p in enumerate(paths):
        nodes.append({'id': f'n{i}', 'path': p, 'kind': classify(p),
                      'status': status_map.get(p, ''),
                      'hunks': len(hunk_counts.get(p, []))})
    edges = pair_sources_tests(nodes)
    tested = {s for s, _ in edges}
    for n in nodes:
        n['untested'] = (n['kind'] == 'source' and n['id'] not in tested
                         and stem_of(n['path']) not in repo_test_stems)
    return {'mermaid': render_mermaid(nodes, edges),
            'nodes': {n['id']: n['path'] for n in nodes},
            'untested': [n['id'] for n in nodes if n.get('untested')]}


# ---- git IO ----------------------------------------------------------------

def _name_status(repo, base):
    """path -> status letter (A/M/D/R…); rename/copy keyed on the new path."""
    out = {}
    for line in _git(repo, 'diff', '--name-status', base).splitlines():
        cols = line.split('\t')
        if len(cols) >= 2:
            out[cols[-1]] = cols[0][:1]
    return out


def section_paths(sec):
    paths = list(sec.get('files', []))
    for e in sec.get('extra_hunks', []):
        if e['file'] not in paths:
            paths.append(e['file'])
    return paths


def generate(workspace, repo, target):
    sections = json.loads((Path(workspace) / 'sections.json').read_text())
    base = merge_base(repo, target)
    status_map = _name_status(repo, base)
    repo_test_stems = {stem_of(f) for f in _git(repo, 'ls-files').splitlines()
                       if classify(f) == 'test'}
    out = {}
    for sec in sections['sections']:
        paths = section_paths(sec)
        if not paths:
            continue
        hunk_counts = multi_file_hunks(repo, target, paths, base=base)
        out[sec['id']] = build_model(sec['id'], paths, status_map,
                                     hunk_counts, repo_test_stems)
    dest = Path(workspace) / 'diagrams.json'
    tmp = dest.with_suffix('.json.tmp')
    tmp.write_text(json.dumps({'sections': out}))
    os.replace(tmp, dest)  # atomic: the server never reads a half-written file
    return out


# ---- self-test -------------------------------------------------------------

def demo():
    assert classify('src/auth/tokens.py') == 'source'
    assert classify('src/auth/test_tokens.py') == 'test'
    assert classify('tests/auth/tokens.py') == 'test'
    assert classify('web/Foo.test.tsx') == 'test'
    assert classify('lib/foo_test.exs') == 'test'
    assert classify('README.md') == 'doc'
    assert classify('package.json') == 'config'
    assert classify('contest.py') == 'source'  # not a false 'test'
    assert stem_of('src/auth/test_tokens.py') == 'tokens'
    assert stem_of('src/auth/tokens_test.py') == 'tokens'
    assert stem_of('web/Foo.test.tsx') == stem_of('web/Foo.tsx') == 'foo'

    paths = ['src/auth/tokens.py', 'src/auth/test_tokens.py',
             'src/auth/session.py', 'docs/README.md']
    status = {p: 'M' for p in paths}
    status['src/auth/test_tokens.py'] = 'A'
    hunks = {p: [{}] for p in paths}
    m = build_model('auth', paths, status, hunks, repo_test_stems=set())
    mer = m['mermaid']
    assert 'graph LR' in mer
    assert 'n0 -.->|tested by| n1' in mer, 'tokens.py should link to its test'
    assert '⚠' not in mer, 'no glyph in labels — the untested icon is injected client-side'
    assert m['untested'] == ['n2'], 'only session.py (no test) is untested'
    assert m['nodes'] == {'n0': 'src/auth/tokens.py',
                          'n1': 'src/auth/test_tokens.py',
                          'n2': 'src/auth/session.py',
                          'n3': 'docs/README.md'}, 'node->path map for click wiring'
    # each class its own statement — Mermaid mis-parses `class n2 a,b`
    assert 'class n2 modified' in mer and 'class n2 untested' in mer, \
        'untested node keeps both its status and dashed-border class'
    assert 'subgraph sg' in mer and 'classDef added' in mer

    # a repo-wide test presence suppresses the untested mark even when the test
    # isn't in this section's diff
    m2 = build_model('auth', ['src/auth/session.py'], {'src/auth/session.py': 'M'},
                     {'src/auth/session.py': [{}]}, repo_test_stems={'session'})
    assert m2['untested'] == []
    print('PASS')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--workspace')
    ap.add_argument('--repo')
    ap.add_argument('--target', default='main')
    ap.add_argument('--check', action='store_true', help='self-test, prints PASS')
    args = ap.parse_args()
    if args.check:
        demo()
        return
    if not (args.workspace and args.repo):
        ap.error('--workspace and --repo are required (or use --check)')
    out = generate(str(Path(args.workspace).expanduser()), args.repo, args.target)
    print(f'diagram: wrote {len(out)} section map(s)', flush=True)


if __name__ == '__main__':
    main()
