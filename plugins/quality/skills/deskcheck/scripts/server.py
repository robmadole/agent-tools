#!/usr/bin/env python3
"""Local PR review server.

Serves the review UI (assets/template.html) for the sections defined in
<workspace>/sections.json and persists reviewed-state per section/file/hunk
to <workspace>/review.db (sqlite). Stdlib only.

    server.py --workspace ~/.deskcheck/myrepo/my-branch --repo /path/to/repo \
              --target main

Binds a free OS-assigned port by default and prints
"Serving on http://127.0.0.1:<PORT>" to stdout; pass --port to pin one.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_diff import (_diff_entries, _git, _lexer_for, context_rows,
                         file_hunks, hunk_html, merge_base, multi_file_hunks,
                         new_side)
from fetch_comments import render_md  # GFM → HTML via GitHub's /markdown endpoint

SKILL_DIR = Path(__file__).resolve().parent.parent
ASSET_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
}
LOCK = threading.Lock()
# bump when render output changes for the same content, so cached hunk HTML
# from an older renderer can't be served
RENDER_VERSION = 2


def open_db(workspace):
    con = sqlite3.connect(str(Path(workspace) / 'review.db'), check_same_thread=False)
    con.execute(
        'CREATE TABLE IF NOT EXISTS reviews ('
        ' item_key TEXT PRIMARY KEY,'
        ' reviewed INTEGER NOT NULL DEFAULT 0,'
        " updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    # ponytail: stale cache rows just accumulate (KBs); add pruning if it ever matters
    con.execute(
        'CREATE TABLE IF NOT EXISTS render_cache ('
        ' cache_key TEXT PRIMARY KEY,'
        ' html TEXT NOT NULL)'
    )
    con.execute(
        'CREATE TABLE IF NOT EXISTS snapshots ('
        ' path TEXT PRIMARY KEY,'
        ' content TEXT NOT NULL,'
        " taken_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    # local review notes — private to the reviewer, never sent to GitHub.
    # Line-anchored like inline comments (path+line+side), but stored here so
    # they work with no PR and the agent can read them straight from the db.
    con.execute(
        'CREATE TABLE IF NOT EXISTS notes ('
        ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
        ' path TEXT NOT NULL,'
        ' line INTEGER NOT NULL,'
        " side TEXT NOT NULL DEFAULT 'RIGHT',"
        ' body TEXT NOT NULL,'
        " created_at TEXT NOT NULL DEFAULT (datetime('now')),"
        " updated_at TEXT NOT NULL DEFAULT (datetime('now')),"
        ' resolved_at TEXT)'  # NULL = open; set once the agent acts on it
    )
    # migrate note tables created before resolved_at existed
    if not any(r[1] == 'resolved_at' for r in con.execute('PRAGMA table_info(notes)')):
        con.execute('ALTER TABLE notes ADD COLUMN resolved_at TEXT')
    con.commit()
    return con


NOTE_COLS = ('id', 'path', 'line', 'side', 'body', 'created_at', 'updated_at')


def read_notes(con):
    # only open notes reach the UI — resolved ones stay in the db as a record
    with LOCK:
        rows = con.execute(
            'SELECT id, path, line, side, body, created_at, updated_at '
            'FROM notes WHERE resolved_at IS NULL ORDER BY path, line, id').fetchall()
    return [dict(zip(NOTE_COLS, r)) for r in rows]


def _note_row(con, nid):
    row = con.execute('SELECT id, path, line, side, body, created_at, updated_at '
                      'FROM notes WHERE id=?', (nid,)).fetchone()
    return dict(zip(NOTE_COLS, row)) if row else None


def add_note(con, req):
    path = (req.get('path') or '').strip()
    body = (req.get('body') or '').strip()
    line = req.get('line')
    side = 'LEFT' if req.get('side') == 'LEFT' else 'RIGHT'
    if not path or not body or not isinstance(line, int) or isinstance(line, bool):
        return 400, {'ok': False, 'detail': 'note needs path, integer line, and body'}
    with LOCK:
        cur = con.execute('INSERT INTO notes(path, line, side, body) VALUES(?,?,?,?)',
                          (path, line, side, body))
        con.commit()
        note = _note_row(con, cur.lastrowid)
    return 200, {'ok': True, 'note': note}


def edit_note(con, req):
    nid, body = req.get('id'), (req.get('body') or '').strip()
    if not isinstance(nid, int) or not body:
        return 400, {'ok': False, 'detail': 'edit needs id and body'}
    with LOCK:
        cur = con.execute("UPDATE notes SET body=?, updated_at=datetime('now') WHERE id=?",
                          (body, nid))
        con.commit()
        if not cur.rowcount:
            return 404, {'ok': False, 'detail': 'no such note'}
        note = _note_row(con, nid)
    return 200, {'ok': True, 'note': note}


def delete_note(con, req):
    nid = req.get('id')
    if not isinstance(nid, int):
        return 400, {'ok': False, 'detail': 'delete needs id'}
    with LOCK:
        con.execute('DELETE FROM notes WHERE id=?', (nid,))
        con.commit()
    return 200, {'ok': True}


def read_state(con):
    with LOCK:
        return {k: bool(v) for k, v in
                con.execute('SELECT item_key, reviewed FROM reviews')}


def file_hash(hunks):
    return hashlib.sha1(''.join(h['id'] for h in hunks).encode()).hexdigest()[:12]


def migrate_legacy_keys(con, repo, target, base):
    """One-time rewrite of positional keys (hunk:path:N, file:path) to the
    content-hash form, so marks made before content addressing survive."""
    rows = [k for (k,) in con.execute('SELECT item_key FROM reviews')]
    legacy_h = [k for k in rows if re.match(r'^hunk:.+:\d{1,5}$', k)]
    legacy_f = [k for k in rows if k.startswith('file:')
                and not re.search(r':[0-9a-f]{12}(-\d+)?$', k)]
    if not (legacy_h or legacy_f):
        return
    cache = {}

    def hunks_for(path):
        if path not in cache:
            cache[path] = file_hunks(repo, target, path, base=base)
        return cache[path]

    with LOCK:
        for k in legacy_h:
            path, idx = k[5:].rsplit(':', 1)
            entry = next((x for x in hunks_for(path) if x['index'] == int(idx)), None)
            if entry:
                con.execute('UPDATE OR REPLACE reviews SET item_key=? WHERE item_key=?',
                            (f'hunk:{path}:{entry["id"]}', k))
        for k in legacy_f:
            path = k[5:]
            con.execute('UPDATE OR REPLACE reviews SET item_key=? WHERE item_key=?',
                        (f'file:{path}:{file_hash(hunks_for(path))}', k))
        con.commit()


def load_sections(args):
    sections = json.loads((Path(args.workspace) / 'sections.json').read_text())
    paths = []
    for s in sections['sections']:
        for f in s.get('files', []):
            if f not in paths:
                paths.append(f)
        for e in s.get('extra_hunks', []):
            if e['file'] not in paths:
                paths.append(e['file'])
    return sections, paths


def unsectioned_now(args, base=None):
    """Changed files covered by no section — the review's blind spot."""
    base = base or merge_base(args.repo, args.target)
    sections, paths = load_sections(args)
    scope = sections.get('scope') or []
    changed = _git(args.repo, 'diff', '--name-only', base, '--', *scope).splitlines()
    return [f for f in changed if f not in paths]


def drift_watch(args, interval):
    """Exit the process with code 42 when drift persists across two polls.

    The exit IS the signal: the harness that launched us in the background gets
    a task notification with this code, wakes the LLM, and it re-sections and
    relaunches. Debounced so a mid-pull/rebase transient doesn't fire it.
    """
    prev = None
    while True:
        time.sleep(interval)
        try:
            cur = sorted(unsectioned_now(args))
        except Exception:
            continue
        if cur and cur == prev:
            print('DRIFT_DETECTED: %d unsectioned file(s): %s' %
                  (len(cur), ' '.join(cur)), flush=True)
            os._exit(42)
        prev = cur


def build_page(args, con):
    # Re-anchor per page load so a pull/rebase takes effect on refresh.
    base = merge_base(args.repo, args.target)
    Handler.base = base
    sections, paths = load_sections(args)

    # Anything changed but not sectioned gets a synthetic catch-all section, so
    # working-dir edits and pulled commits can never silently escape review.
    scope = sections.get('scope') or []
    changed = _git(args.repo, 'diff', '--name-only', base, '--', *scope).splitlines()
    unsectioned = [f for f in changed if f not in paths]
    if unsectioned:
        paths.extend(unsectioned)
        sections['sections'] = sections['sections'] + [{
            'id': '_unsectioned',
            'title': 'Unsectioned changes',
            'difficulty': 2,
            'summary': 'Files that changed after sections were generated (new '
                       'commits or working-tree edits). Reviewable now — ask '
                       'Claude to re-section the review to fold them in properly.',
            'files': unsectioned,
        }]
    # per-file uncommitted state: staged (index != HEAD), edited (worktree != index)
    wip = {}
    for line in _git(args.repo, 'status', '--porcelain').splitlines():
        if len(line) < 4 or line[0] == '?':
            continue
        p = line[3:].split(' -> ')[-1].strip().strip('"')
        staged, edited = line[0] != ' ', line[1] != ' '
        wip[p] = ('staged + edited' if staged and edited
                  else 'staged' if staged else 'edited')

    all_entries = multi_file_hunks(args.repo, args.target, paths, base=base)
    files = {p: {'hash': file_hash(entries),
                 'wip': wip.get(p),
                 'hunks': [{'index': e['index'], 'id': e['id'],
                            'header': e['header'],
                            **({'binary': True} if e.get('binary') else {})}
                           for e in entries]}
             for p, entries in all_entries.items()}
    cpath = Path(args.workspace) / 'comments.json'
    data = {
        'title': sections.get('title', 'PR Review'),
        'branch': sections.get('branch', ''),
        'target': args.target,
        'sections': sections['sections'],
        'files': files,
        'state': read_state(con),
        'comments': json.loads(cpath.read_text()) if cpath.exists() else None,
        'comments_rev': cpath.stat().st_mtime if cpath.exists() else 0,
        'notes': read_notes(con),
    }
    return render_template(data).encode()


def render_template(data):
    """Substitute the DATA blob into template.html. Shared with preview.py so
    the static state-preview harness renders exactly as the live server does."""
    template = (SKILL_DIR / 'assets' / 'template.html').read_text()
    payload = json.dumps(data).replace('<', '\\u003c')
    return template.replace('__DATA__', payload)


def github_sync_init(args):
    """Resolve the PR's GraphQL node id, or None (sync disabled) on failure."""
    r = subprocess.run(['gh', 'pr', 'view', '--json', 'id', '-q', '.id'],
                       cwd=args.repo, capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        print('github-sync disabled: ' + (r.stderr.strip() or 'no PR found'),
              flush=True)
        return None
    return r.stdout.strip()


def github_sync_file(args, pr_id, path, reviewed):
    """Mirror a local file mark to GitHub's per-file Viewed checkbox."""
    mut = 'markFileAsViewed' if reviewed else 'unmarkFileAsViewed'
    query = ('mutation($pr:ID!,$path:String!){%s(input:{pullRequestId:$pr,'
             'path:$path}){clientMutationId}}' % mut)
    r = subprocess.run(['gh', 'api', 'graphql', '-f', f'query={query}',
                        '-f', f'pr={pr_id}', '-f', f'path={path}'],
                       cwd=args.repo, capture_output=True, text=True)
    if r.returncode != 0:
        print(f'github-sync failed ({mut} {path}): {r.stderr.strip()}',
              flush=True)


def refresh_comments(args):
    return subprocess.run(
        [sys.executable, str(SKILL_DIR / 'scripts' / 'fetch_comments.py'),
         '--workspace', args.workspace, '--repo', args.repo],
        capture_output=True, text=True)


def generate_diagrams(args):
    """(Re)build <workspace>/diagrams.json via the standalone diagram.py.

    Fire-and-forget from a daemon thread on startup so the module maps never
    block serving — the client polls /api/diagrams and renders when they land.
    """
    r = subprocess.run(
        [sys.executable, str(SKILL_DIR / 'scripts' / 'diagram.py'),
         '--workspace', args.workspace, '--repo', args.repo,
         '--target', args.target],
        capture_output=True, text=True)
    if r.returncode != 0:
        print('diagram generation failed: '
              + (r.stderr or r.stdout).strip(), flush=True)


def post_comment(args, req):
    """Create a PR review comment via `gh` — a new line comment or a reply.

    New comment needs {path, line, side, body}; reply needs {in_reply_to, body}.
    Uses the line-based comments API, so path+line+side (the values already
    shown in the diff's line-number cells) are all the anchoring GitHub wants —
    no diff-position math. Returns (status_code, response_dict). On success it
    fires a background comments.json refresh so the canonical body_html lands.
    """
    def sh(*cmd):
        return subprocess.run(cmd, cwd=args.repo, capture_output=True, text=True)

    body = (req.get('body') or '').strip()
    if not body:
        return 400, {'ok': False, 'detail': 'empty comment body'}
    slug = sh('gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner')
    if slug.returncode != 0:
        return 500, {'ok': False, 'detail': 'gh repo view failed: ' + slug.stderr.strip()}
    slug_str = slug.stdout.strip()
    prv = sh('gh', 'pr', 'view', '--json', 'number,headRefOid')
    if prv.returncode != 0:
        return 500, {'ok': False, 'detail': 'gh pr view failed: ' + prv.stderr.strip()}
    pr = json.loads(prv.stdout)
    endpoint = f'repos/{slug_str}/pulls/{pr["number"]}/comments'
    if req.get('in_reply_to'):
        cmd = ['gh', 'api', '--method', 'POST', endpoint, '-f', f'body={body}',
               '-F', f'in_reply_to={int(req["in_reply_to"])}']
    else:
        cmd = ['gh', 'api', '--method', 'POST', endpoint, '-f', f'body={body}',
               '-f', f'commit_id={pr["headRefOid"]}', '-f', f'path={req["path"]}',
               '-F', f'line={int(req["line"])}', '-f', f'side={req.get("side") or "RIGHT"}']
    r = sh(*cmd)
    if r.returncode != 0:
        return 500, {'ok': False, 'detail': r.stderr.strip() or r.stdout.strip()}
    c = json.loads(r.stdout)
    threading.Thread(target=refresh_comments, args=(args,), daemon=True).start()
    return 200, {'ok': True, 'comment': {
        'id': c['id'], 'in_reply_to_id': c.get('in_reply_to_id'),
        'path': c.get('path'),
        'line': c.get('line') or c.get('original_line'),
        'side': c.get('side') or 'RIGHT', 'author': c['user']['login'],
        'avatar_url': c['user'].get('avatar_url'),
        'created_at': c['created_at'], 'body': c.get('body') or '',
        # render now so the optimistic card shows GFM without waiting for a reload
        'body_html': render_md(args.repo, slug_str, c.get('body') or ''),
        'url': c['html_url'],
    }}


def _slug(args):
    r = subprocess.run(['gh', 'repo', 'view', '--json', 'nameWithOwner',
                        '-q', '.nameWithOwner'], cwd=args.repo,
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def edit_comment(args, req):
    """PATCH an existing review comment's body (author-only, enforced by GitHub)."""
    body = (req.get('body') or '').strip()
    cid = req.get('id')
    if not body or not cid:
        return 400, {'ok': False, 'detail': 'missing body or id'}
    slug = _slug(args)
    if not slug:
        return 500, {'ok': False, 'detail': 'gh repo view failed'}
    r = subprocess.run(
        ['gh', 'api', '--method', 'PATCH', f'repos/{slug}/pulls/comments/{int(cid)}',
         '-f', f'body={body}'], cwd=args.repo, capture_output=True, text=True)
    if r.returncode != 0:
        return 500, {'ok': False, 'detail': r.stderr.strip() or r.stdout.strip()}
    c = json.loads(r.stdout)
    threading.Thread(target=refresh_comments, args=(args,), daemon=True).start()
    return 200, {'ok': True, 'comment': {
        'id': c['id'], 'body': c.get('body') or '',
        'body_html': render_md(args.repo, slug, c.get('body') or ''),
    }}


def delete_comment(args, req):
    """DELETE a review comment (author-only, enforced by GitHub)."""
    cid = req.get('id')
    if not cid:
        return 400, {'ok': False, 'detail': 'missing id'}
    slug = _slug(args)
    if not slug:
        return 500, {'ok': False, 'detail': 'gh repo view failed'}
    r = subprocess.run(
        ['gh', 'api', '--method', 'DELETE', f'repos/{slug}/pulls/comments/{int(cid)}'],
        cwd=args.repo, capture_output=True, text=True)
    if r.returncode != 0:
        return 500, {'ok': False, 'detail': r.stderr.strip() or r.stdout.strip()}
    threading.Thread(target=refresh_comments, args=(args,), daemon=True).start()
    return 200, {'ok': True}


def comments_watch(args, interval):
    """ETag-conditional poll of the PR: refresh comments.json when the
    comment counts change. 304 responses are free against the rate limit."""
    def sh(*cmd):
        r = subprocess.run(cmd, cwd=args.repo, capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None

    token = sh('gh', 'auth', 'token')
    slug = sh('gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner')
    num = sh('gh', 'pr', 'view', '--json', 'number', '-q', '.number')
    if not (token and slug and num):
        print('comments-watch disabled: gh or PR unavailable', flush=True)
        return
    url = f'https://api.github.com/repos/{slug}/pulls/{num}'
    etag, counts = None, None
    while True:
        try:
            headers = {'Authorization': f'Bearer {token}',
                       'Accept': 'application/vnd.github+json'}
            if etag:
                headers['If-None-Match'] = etag
            with urllib.request.urlopen(
                    urllib.request.Request(url, headers=headers)) as resp:
                etag = resp.headers.get('ETag')
                d = json.loads(resp.read())
                # ponytail: counts miss pure edits; the next count change or a
                # manual refresh picks those up
                cur = (d.get('comments'), d.get('review_comments'))
                if counts is not None and cur != counts:
                    r = refresh_comments(args)
                    print('comments-watch: refreshed — '
                          + (r.stdout or r.stderr).strip(), flush=True)
                counts = cur
        except urllib.error.HTTPError as e:
            if e.code != 304:
                print(f'comments-watch: HTTP {e.code}', flush=True)
        except Exception as e:
            print(f'comments-watch: {type(e).__name__}: {e}', flush=True)
        time.sleep(interval)


def backfill_snapshot(args, con, base, path):
    """Reconstruct a missing snapshot from git history.

    A file mark's content hash fingerprints the exact diff the reviewer saw.
    Walk the branch commits touching the path (newest first); if one's
    diff-vs-base matches a marked hash, that commit's content IS the reviewed
    content — store it as the snapshot. Returns the content, or None when the
    reviewed state was never committed (e.g. marked on uncommitted edits).
    """
    with LOCK:
        marked = [k.rsplit(':', 1)[1] for (k,) in con.execute(
            'SELECT item_key FROM reviews WHERE reviewed=1 AND item_key LIKE ?',
            (f'file:{path}:%',))]
    if not marked:
        return None
    for commit in _git(args.repo, 'rev-list', f'{base}..HEAD', '--',
                       path).split():
        entries = _diff_entries(
            _git(args.repo, 'diff', '--no-color', base, commit, '--', path),
            path)
        if file_hash(entries) in marked:
            content = new_side(args.repo, base, path, ref=commit)
            with LOCK:
                con.execute('INSERT OR REPLACE INTO snapshots(path, content) '
                            'VALUES(?, ?)', (path, content))
                con.commit()
            return content
    return None


def review_delta(args, con, base, path):
    """Diff the reviewer's mark-time snapshot against the current content.

    Returns None when no snapshot exists (and none could be reconstructed),
    [] when the content is unchanged (e.g. only line numbers shifted), else
    rendered hunks of just what changed since the review — through the same
    highlight/emphasis pipeline.
    """
    with LOCK:
        row = con.execute('SELECT content FROM snapshots WHERE path=?',
                          (path,)).fetchone()
    old_content = row[0] if row else backfill_snapshot(args, con, base, path)
    if old_content is None:
        return None
    old = old_content.splitlines()
    cur = new_side(args.repo, base, path).splitlines()
    udiff = '\n'.join(difflib.unified_diff(old, cur, lineterm=''))
    entries = _diff_entries(udiff, path)
    lexer = _lexer_for(path)
    return [{'header': e['header'], 'html': hunk_html(e, lexer)}
            for e in entries]


def rendered_file(args, con, base, path):
    """Render one file's hunks to HTML through the sqlite cache."""
    entries = file_hunks(args.repo, args.target, path, base=base)
    lexer = _lexer_for(path)
    out = []
    for e in entries:
        ck = f'{RENDER_VERSION}:{path}:{e["id"]}'
        with LOCK:
            row = con.execute('SELECT html FROM render_cache WHERE cache_key=?',
                              (ck,)).fetchone()
        if row:
            body = row[0]
        else:
            body = hunk_html(e, lexer)
            with LOCK:
                con.execute('INSERT OR REPLACE INTO render_cache(cache_key, html) '
                            'VALUES(?, ?)', (ck, body))
                con.commit()
        out.append({'index': e['index'], 'id': e['id'],
                    'header': e['header'], 'html': body})
    # new-side line count lets the client add a trailing (last-hunk → EOF) gap
    # only when the last hunk doesn't already reach the end of the file
    content = new_side(args.repo, base, path)
    total_new = len(content.split('\n')) if content else 0
    return {'path': path, 'hunks': out, 'total_new': total_new}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    args = None
    con = None
    base = None
    pr_node_id = None

    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ('/', '/index.html'):
            try:
                body = build_page(self.args, self.con)
            except Exception as e:
                self._send(500, f'<pre>{type(e).__name__}: {e}</pre>'.encode())
                return
            self._send(200, body)
        elif url.path.startswith('/assets/'):
            # static files served from the skill's assets/ dir, so the page
            # needn't inline them (mermaid's 3MB, the fonts' 50KB, …).
            name = url.path[len('/assets/'):]
            ctype = ASSET_TYPES.get(Path(name).suffix)
            # basename-only + known extension: no traversal, no arbitrary reads
            if '/' in name or not ctype:
                self._send(404, b'not found')
                return
            try:
                body = (SKILL_DIR / 'assets' / name).read_bytes()
            except OSError:
                self._send(404, b'not found')
                return
            self._send(200, body, ctype)
        elif url.path == '/api/diagrams':
            dpath = Path(self.args.workspace) / 'diagrams.json'
            body = dpath.read_bytes() if dpath.exists() else b'{"sections":{}}'
            self._send(200, body, 'application/json')
        elif url.path == '/api/state':
            self._send(200, json.dumps(read_state(self.con)).encode(),
                       'application/json')
        elif url.path == '/api/comments-rev':
            cpath = Path(self.args.workspace) / 'comments.json'
            rev = cpath.stat().st_mtime if cpath.exists() else 0
            self._send(200, json.dumps({'rev': rev}).encode(), 'application/json')
        elif url.path == '/api/reviewdelta':
            path = parse_qs(url.query).get('path', [''])[0]
            try:
                hunks = review_delta(self.args, self.con, self.base, path)
            except Exception:
                hunks = None
            self._send(200, json.dumps({'available': hunks is not None,
                                        'hunks': hunks or []}).encode(),
                       'application/json')
        elif url.path == '/api/filediff':
            path = parse_qs(url.query).get('path', [''])[0]
            try:
                payload = rendered_file(self.args, self.con, self.base, path)
            except Exception:
                self._send(404, b'not found')
                return
            self._send(200, json.dumps(payload).encode(), 'application/json')
        elif url.path == '/api/context':
            q = parse_qs(url.query)
            try:
                path = q.get('path', [''])[0]
                new_start = int(q.get('new_start', ['0'])[0])
                old_start = int(q.get('old_start', ['0'])[0])
                count = int(q.get('count', ['20'])[0])
                rows, total = context_rows(self.args.repo, self.base, path,
                                           new_start, old_start, count)
            except Exception:
                self._send(404, b'not found')
                return
            # lines still hidden below what we just returned (bounds the to-EOF gap)
            remaining = max(0, total - (new_start - 1 + count))
            self._send(200, json.dumps({'rows': rows, 'total': total,
                                        'remaining': remaining}).encode(),
                       'application/json')
        else:
            self._send(404, b'not found')

    def do_POST(self):
        if self.path == '/api/refresh-comments':
            r = refresh_comments(self.args)
            body = json.dumps({'ok': r.returncode == 0,
                               'detail': (r.stdout or r.stderr).strip()})
            self._send(200 if r.returncode == 0 else 500, body.encode(),
                       'application/json')
            return
        if self.path in ('/api/add-comment', '/api/edit-comment', '/api/delete-comment'):
            try:
                n = int(self.headers.get('Content-Length', 0))
                req = json.loads(self.rfile.read(n))
            except Exception:
                self._send(400, b'bad request')
                return
            fn = {'/api/add-comment': post_comment, '/api/edit-comment': edit_comment,
                  '/api/delete-comment': delete_comment}[self.path]
            code, resp = fn(self.args, req)
            self._send(code, json.dumps(resp).encode(), 'application/json')
            return
        if self.path in ('/api/add-note', '/api/edit-note', '/api/delete-note'):
            try:
                n = int(self.headers.get('Content-Length', 0))
                req = json.loads(self.rfile.read(n))
            except Exception:
                self._send(400, b'bad request')
                return
            fn = {'/api/add-note': add_note, '/api/edit-note': edit_note,
                  '/api/delete-note': delete_note}[self.path]
            code, resp = fn(self.con, req)
            self._send(code, json.dumps(resp).encode(), 'application/json')
            return
        if self.path != '/api/toggle':
            self._send(404, b'not found')
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            key = json.loads(self.rfile.read(n))['key']
        except Exception:
            self._send(400, b'bad request')
            return
        with LOCK:
            row = self.con.execute(
                'SELECT reviewed FROM reviews WHERE item_key=?', (key,)).fetchone()
            new = 0 if row and row[0] else 1
            self.con.execute(
                'INSERT INTO reviews(item_key, reviewed) VALUES(?, ?) '
                'ON CONFLICT(item_key) DO UPDATE SET reviewed=excluded.reviewed, '
                "updated_at=datetime('now')", (key, new))
            self.con.commit()
        pos = key.rfind(':')
        if key.startswith('file:') and pos > 5:
            path = key[5:pos]
            if new:
                # remember what the reviewer saw, so a later change can be
                # shown as a delta instead of a full re-review
                try:
                    content = new_side(self.args.repo, self.base, path)
                    with LOCK:
                        self.con.execute(
                            'INSERT OR REPLACE INTO snapshots(path, content) '
                            'VALUES(?, ?)', (path, content))
                        self.con.commit()
                except Exception as e:
                    print(f'snapshot failed for {path}: {e}', flush=True)
            if self.pr_node_id:
                threading.Thread(
                    target=github_sync_file,
                    args=(self.args, self.pr_node_id, path, bool(new)),
                    daemon=True).start()
        self._send(200, json.dumps({'key': key, 'reviewed': bool(new)}).encode(),
                   'application/json')

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--target', default='main')
    ap.add_argument('--port', type=int, default=0,
                    help='0 (default) = free OS-assigned port, printed on startup')
    ap.add_argument('--exit-on-drift', action='store_true',
                    help='exit 42 when unsectioned changes appear (the exit is '
                         'the signal for a listening harness to re-section)')
    ap.add_argument('--drift-interval', type=float, default=30.0)
    ap.add_argument('--github-sync', action='store_true',
                    help="mirror local file marks to the PR's Viewed "
                         'checkboxes on GitHub (needs an authenticated gh)')
    ap.add_argument('--watch-comments', action='store_true',
                    help='ETag-poll the PR and auto-refresh comments.json '
                         'when comment counts change')
    ap.add_argument('--comments-interval', type=float, default=60.0)
    args = ap.parse_args()
    args.workspace = str(Path(args.workspace).expanduser())

    Handler.args = args
    if args.github_sync:
        Handler.pr_node_id = github_sync_init(args)
        if Handler.pr_node_id:
            print(f'github-sync: {Handler.pr_node_id}', flush=True)
    Handler.con = open_db(args.workspace)
    Handler.base = merge_base(args.repo, args.target)
    migrate_legacy_keys(Handler.con, args.repo, args.target, Handler.base)

    # Build the per-section module maps off the request path — the page serves
    # immediately and the client polls /api/diagrams for them.
    threading.Thread(target=generate_diagrams, args=(args,), daemon=True).start()

    if args.exit_on_drift:
        threading.Thread(target=drift_watch, args=(args, args.drift_interval),
                         daemon=True).start()
    if args.watch_comments:
        threading.Thread(target=comments_watch,
                         args=(args, args.comments_interval),
                         daemon=True).start()

    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Serving on http://127.0.0.1:{srv.server_address[1]}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
