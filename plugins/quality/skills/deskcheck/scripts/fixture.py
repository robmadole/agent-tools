#!/usr/bin/env python3
"""Live fixture driver for iterating on the deskcheck review UI.

Replaces the old static preview: instead of hand-authored DATA dicts rendered
once, this builds a throwaway git repo with a real base..feature diff, which you
serve with the *real* server.py and then drive through named state transitions
("change a reviewed file", "add a binary", "cause drift", …). Because a
transition is just editing code + git, the server reflects it on the next page
load — so you can put the fixture in any state and iterate on the real UI.

    fixture.py build                 # (re)create the fixture repo + workspace
    # launch the real server on it (prints the port), open the browser:
    #   python3 server.py --workspace <ws> --repo <repo> --target main
    fixture.py state                 # where the fixture is + the transition menu
    fixture.py mark-partial --port P # a partial section (so a file is reviewed)
    fixture.py change-reviewed-file  # -> "changed since review" badge + delta
    fixture.py add-unsectioned-file  # -> drift / "Unsectioned changes"
    fixture.py reset                 # back to the freshly-served state, to retry
    fixture.py --check               # build+serve+drive+assert in a temp repo

The fixture lives at ~/.deskcheck/_fixture/{repo,ws} so every command is
path-free. `build` wipes and recreates it. Transitions that mark items reviewed
go through the running server's /api/toggle (the faithful path — it captures the
review snapshot exactly like a real click), so they need --port; edits that just
touch files/git need no server.

The default file contents below make `build`/`--check` runnable standalone. For
a richer preview, generate your own `base/` and `feature/` trees and pass
`build --base <dir> --feature <dir> --sections <sections.json>`.
"""
import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server as srv  # noqa: E402
from render_diff import file_hunks  # noqa: E402

FIXTURE = Path.home() / '.deskcheck' / '_fixture'
SECTIONS_CLI = Path(__file__).resolve().parent / 'sections.py'
# durable throwaway GitHub repo for exercising the real-PR write features
# (comment posting, Viewed sync) that the local fixture can't reach on its own
FIXTURE_REMOTE = 'robmadole/agent-tools-deskcheck-fixture'

# --- default fixture: a small but real multi-section diff -------------------
DEFAULT_BASE = {
    'src/auth/tokens.py':
        'import time\n\n\n'
        'def issue_token(user_id):\n'
        '    return {\n'
        '        "user": user_id,\n'
        '        "issued_at": time.time(),\n'
        '        "value": _random_value(),\n'
        '    }\n\n\n'
        'def _random_value():\n'
        '    return "tok_" + str(int(time.time() * 1000))\n\n\n'
        'def validate(token):\n'
        '    if token["issued_at"] + 3600 < time.time():\n'
        '        return False\n'
        '    return True\n\n\n'
        'def revoke(token):\n'
        '    token["revoked"] = True\n'
        '    return token\n',
    'src/auth/session.py':
        'def login(request, credentials):\n'
        '    user = authenticate(credentials)\n'
        '    if user is None:\n'
        '        return None\n'
        '    request.session["user_id"] = user.id\n'
        '    return user\n\n\n'
        'def authenticate(credentials):\n'
        '    return lookup_user(credentials["email"])\n',
    'src/api/handlers.py':
        'def handle_webhook(request):\n'
        '    payload = request.json()\n'
        '    process(payload)\n'
        '    return {"ok": True}\n',
}
DEFAULT_FEATURE = {
    'src/auth/tokens.py':
        'import time\n\n\n'
        'def issue_token(user_id, rotate_from=None):\n'
        '    token = {\n'
        '        "user": user_id,\n'
        '        "issued_at": time.time(),\n'
        '        "value": _random_value(),\n'
        '    }\n'
        '    if rotate_from is not None:\n'
        '        revoke(rotate_from)\n'
        '        token["rotated_from"] = rotate_from["value"]\n'
        '    return token\n\n\n'
        'def _random_value():\n'
        '    return "tok_" + str(int(time.time() * 1000))\n\n\n'
        'def validate(token):\n'
        '    if token.get("revoked"):\n'
        '        return False\n'
        '    if token["issued_at"] + 3600 < time.time():\n'
        '        return False\n'
        '    return True\n\n\n'
        'def revoke(token):\n'
        '    token["revoked"] = True\n'
        '    return token\n',
    'src/auth/session.py':
        'def login(request, credentials):\n'
        '    user = authenticate(credentials)\n'
        '    if user is None:\n'
        '        return None\n'
        '    request.session["user_id"] = user.id\n'
        '    request.session["token"] = issue_token(user.id)\n'
        '    return user\n\n\n'
        'def authenticate(credentials):\n'
        '    return lookup_user(credentials["email"])\n',
    'src/api/handlers.py':
        'def handle_webhook(request):\n'
        '    payload = request.json()\n'
        '    if payload.get("id") in _seen:\n'
        '        return {"ok": True, "duplicate": True}\n'
        '    _seen.add(payload.get("id"))\n'
        '    process(payload)\n'
        '    return {"ok": True}\n\n\n'
        '_seen = set()\n',
    'web/components/navigation/UserMenu.jsx':
        'export function UserMenu({ user }) {\n'
        '  if (!user) return null;\n'
        '  return (\n'
        '    <div className="user-menu">\n'
        '      <img src={user.avatar} alt="" />\n'
        '      <span>{user.name}</span>\n'
        '    </div>\n'
        '  );\n'
        '}\n',
    # new test file, so the module map shows tokens.py "tested by" this and
    # leaves session.py untested (⚠)
    'src/auth/test_tokens.py':
        'from src.auth.tokens import issue_token\n\n\n'
        'def test_rotation_revokes_prior():\n'
        '    first = issue_token("u1")\n'
        '    second = issue_token("u1", rotate_from=first)\n'
        '    assert first["revoked"] is True\n'
        '    assert second["rotated_from"] == first["value"]\n',
}
DEFAULT_SECTIONS = {
    'title': 'Refresh-token rotation + webhook idempotency',
    'branch': 'feature',
    'sections': [
        {'id': 'auth', 'title': 'Token rotation & session', 'difficulty': 5,
         'summary': 'Rotate the refresh token on every use and revoke the prior '
                    'one; issue a token on login. Read this first.',
         'files': ['src/auth/tokens.py', 'src/auth/test_tokens.py',
                   'src/auth/session.py']},
        {'id': 'api', 'title': 'Webhook idempotency', 'difficulty': 3,
         'summary': 'Guard the webhook handler against duplicate deliveries.',
         'files': ['src/api/handlers.py']},
        {'id': 'ui', 'title': 'Nav signed-in state', 'difficulty': 2,
         'summary': 'Show the signed-in user in the top nav.',
         'files': ['web/components/navigation/UserMenu.jsx']},
    ],
}

# name -> one-line help; the single source of truth for the menu and argparse
TRANSITIONS = [
    ('mark-partial', 'mark one section’s first file reviewed (partial nav bar)'),
    ('mark-section', 'mark a whole section reviewed (green) — [id], default first'),
    ('mark-all', 'mark everything reviewed (the "Fully Reviewed" banner)'),
    ('unmark', 'clear all review marks (keep the repo as-is)'),
    ('change-reviewed-file', 'edit an already-reviewed file (stale badge + review-delta)'),
    ('edit-file', 'unstaged edit to a sectioned file (wip: edited)'),
    ('stage-file', 'staged edit to a sectioned file (wip: staged)'),
    ('add-binary', 'add a binary file to a section (renders "no diff to display")'),
    ('add-unsectioned-file', 'add a changed file in no section (drift / Unsectioned)'),
    ('revert-file', 'restore a sectioned file to target (grayed "no longer in diff")'),
    ('add-comment', 'append a PR comment to comments.json (comment + "New comments" pill)'),
    ('add-note', 'jot a private line-anchored note (purple "Private note" card, local only)'),
    ('reset', 'marks + worktree + comments + notes back to the freshly-served state'),
    ('push-remote', 'publish the fixture to GitHub + ensure its PR — [slug], for real-PR tests'),
    ('reset-comments', 'delete all comments on the fixture PR (remote half of reset)'),
    ('build', '(re)create the fixture repo + workspace from scratch'),
    ('state', 'print where the fixture is, its marks, and this transition menu'),
]


def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True)


def gh_out(cwd, *args, check=True):
    """Run `gh` and return stdout; exit with its stderr on failure."""
    r = subprocess.run(['gh', *args], cwd=str(cwd), capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f'gh {" ".join(args[:2])} failed: {r.stderr.strip()}')
    return r.stdout


def write_tree(root, files):
    for rel, content in files.items():
        p = Path(root) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content if isinstance(content, bytes) else content.encode())


def read_tree(root):
    root = Path(root)
    return {str(p.relative_to(root)): p.read_bytes()
            for p in root.rglob('*') if p.is_file()}


# --- server API (transitions mark through the running server) ---------------
def _get_state(port):
    return json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/state').read())


def _toggle(port, key):
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/api/toggle',
        data=json.dumps({'key': key}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req).read())


def mark(port, keys):
    """Ensure every key is reviewed=1, via the real toggle endpoint."""
    if port is None:
        sys.exit('this transition marks items — pass --port <server port>')
    state = _get_state(port)
    for k in keys:
        if not state.get(k):
            _toggle(port, k)


def keys_for(repo, path):
    """(file_key, [hunk_key,...]) for a path, keyed like the server does."""
    entries = file_hunks(str(repo), 'main', path)
    return (f'file:{path}:{srv.file_hash(entries)}',
            [f'hunk:{path}:{e["id"]}' for e in entries])


# --- fixture helpers --------------------------------------------------------
def load_sections(ws):
    return json.loads((Path(ws) / 'sections.json').read_text())


def sectioned_files(ws):
    out = []
    for s in load_sections(ws)['sections']:
        out.extend(s.get('files', []))
    return out


def reviewed_files(ws):
    """Paths currently marked reviewed at the file level, from review.db."""
    con = sqlite3.connect(str(Path(ws) / 'review.db'))
    try:
        rows = con.execute("SELECT item_key FROM reviews WHERE reviewed=1 "
                           "AND item_key LIKE 'file:%'").fetchall()
    finally:
        con.close()
    return [k[5:k.rfind(':')] for (k,) in rows]


def append(repo, path, text):
    p = Path(repo) / path
    p.write_text(p.read_text() + text)


def build(root, base=None, feature=None, sections=None):
    """Wipe root and lay down repo (base..feature diff) + workspace."""
    root = Path(root)
    if root.exists():
        shutil.rmtree(root)
    repo, ws = root / 'repo', root / 'ws'
    repo.mkdir(parents=True), ws.mkdir(parents=True)
    base_files = read_tree(base) if base else DEFAULT_BASE
    feat_files = read_tree(feature) if feature else DEFAULT_FEATURE
    sec = json.loads(Path(sections).read_text()) if sections else DEFAULT_SECTIONS

    sh(repo, 'git', 'init', '-q', '-b', 'main')
    sh(repo, 'git', 'config', 'user.email', 'fixture@deskcheck')
    sh(repo, 'git', 'config', 'user.name', 'deskcheck fixture')
    write_tree(repo, base_files)
    sh(repo, 'git', 'add', '-A')
    sh(repo, 'git', 'commit', '-qm', 'base')
    sh(repo, 'git', 'checkout', '-qb', 'feature')
    write_tree(repo, feat_files)  # overlay: modified files differ, new files appear
    sh(repo, 'git', 'add', '-A')
    sh(repo, 'git', 'commit', '-qm', 'feature work')
    (ws / 'sections.json').write_text(json.dumps(sec, indent=2))
    return repo, ws


# --- transitions ------------------------------------------------------------
def t_mark_partial(repo, ws, port):
    path = sectioned_files(ws)[0]
    fk, hks = keys_for(repo, path)
    mark(port, [fk, *hks])  # file + hunks, but NOT the section -> partial
    return f'marked {path} reviewed (partial)'


def t_mark_section(repo, ws, port, sid=None):
    secs = load_sections(ws)['sections']
    sec = next((s for s in secs if s['id'] == sid), None) if sid else secs[0]
    if sec is None:
        sys.exit(f'no section {sid!r}; have: ' + ', '.join(s['id'] for s in secs))
    keys = [f'section:{sec["id"]}']
    for path in sec.get('files', []):
        fk, hks = keys_for(repo, path)
        keys += [fk, *hks]
    mark(port, keys)
    return f'marked section {sec["id"]} reviewed'


def t_mark_all(repo, ws, port):
    keys = [f'section:{s["id"]}' for s in load_sections(ws)['sections']]
    for path in sectioned_files(ws):
        fk, hks = keys_for(repo, path)
        keys += [fk, *hks]
    mark(port, keys)
    return 'marked everything reviewed (Fully Reviewed banner)'


def t_unmark(repo, ws, port):
    con = srv.open_db(ws)
    con.execute('DELETE FROM reviews')
    con.commit()
    con.close()
    return 'cleared all review marks'


def t_change_reviewed_file(repo, ws, port):
    files = reviewed_files(ws)
    if not files:
        sys.exit('no reviewed file yet — run mark-partial or mark-section first')
    path = next((f for f in files if (Path(repo) / f).exists()), None)
    if path is None:
        sys.exit('reviewed files are not present in the repo')
    append(repo, path, f'\n\ndef _touched_after_review_{time.time_ns()}():\n'
                       '    return "changed since you reviewed this"\n')
    return f'edited already-reviewed {path} -> stale badge + review-delta'


def t_edit_file(repo, ws, port):
    path = sectioned_files(ws)[0]
    append(repo, path, f'\n# unstaged edit {time.time_ns()}\n')
    return f'unstaged edit to {path} (wip: edited)'


def t_stage_file(repo, ws, port):
    path = sectioned_files(ws)[1 % len(sectioned_files(ws))]
    append(repo, path, f'\n# staged edit {time.time_ns()}\n')
    sh(repo, 'git', 'add', path)
    return f'staged edit to {path} (wip: staged; edit again for staged + edited)'


def t_add_binary(repo, ws, port):
    rel = 'web/assets/logo.bin'
    (Path(repo) / rel).parent.mkdir(parents=True, exist_ok=True)
    (Path(repo) / rel).write_bytes(bytes(range(256)) * 16)
    sh(repo, 'git', 'add', rel)
    subprocess.run([sys.executable, str(SECTIONS_CLI), '--workspace', str(ws),
                    'add-files', 'ui', rel], check=True, capture_output=True)
    return f'added binary {rel} to section ui (renders "no diff to display")'


def t_add_unsectioned_file(repo, ws, port):
    rel = 'scripts/db/migrate_0042_add_token_rotation_columns.py'
    (Path(repo) / rel).parent.mkdir(parents=True, exist_ok=True)
    (Path(repo) / rel).write_text('def up():\n    add_column("tokens", "rotated_from")\n')
    sh(repo, 'git', 'add', rel)  # git diff can't see untracked files
    return f'added unsectioned {rel} -> "Unsectioned changes" drift section'


def t_revert_file(repo, ws, port):
    path = sectioned_files(ws)[0]
    sh(repo, 'git', 'checkout', 'main', '--', path)
    return f'reverted {path} to target -> grayed "no longer in diff" row'


def t_add_comment(repo, ws, port):
    path = sectioned_files(ws)[0]
    cpath = Path(ws) / 'comments.json'
    data = json.loads(cpath.read_text()) if cpath.exists() else {
        'pr': 42, 'title': 'Fixture PR',
        'url': 'https://github.com/acme/webapp/pull/42',
        'conversation': [], 'inline': []}
    url = data['url']
    n = len(data['conversation']) + len(data['inline'])
    data['conversation'].append(
        {'author': 'octocat', 'created_at': '2026-07-28T12:00:00Z', 'url': url,
         'body': f'Comment #{n}: does rotation emit a metric we can alert on?'})
    data['inline'].append(
        {'id': 1000 + n, 'author': 'hubot', 'created_at': '2026-07-28T12:05:00Z',
         'url': url, 'path': path, 'line': 2, 'side': 'RIGHT',
         'body': 'Guard this against an already-revoked token.'})
    cpath.write_text(json.dumps(data))
    return (f'appended a conversation + inline comment on {path} '
            '(reload shows it; the "New comments" pill appears within 30s)')


def t_add_note(repo, ws, port):
    """Jot a private, line-anchored review note into review.db — the local
    annotation the reviewer keeps to themselves (never sent to GitHub)."""
    path = sectioned_files(ws)[0]
    con = srv.open_db(ws)  # creates the notes table if the schema is fresh
    con.execute('INSERT INTO notes(path, line, side, body) VALUES(?,?,?,?)',
                (path, 4, 'RIGHT',
                 'Confirm rotate_from is validated before we revoke() it.'))
    con.commit()
    con.close()
    return f'added a private note on {path}:4 (purple "Private note" card, only you)'


def t_reset(repo, ws, port):
    con = srv.open_db(ws)
    for tbl in ('reviews', 'snapshots', 'render_cache', 'notes'):
        con.execute(f'DELETE FROM {tbl}')
    con.commit()
    con.close()
    sh(repo, 'git', 'reset', '-q', '--hard', 'feature')
    sh(repo, 'git', 'clean', '-qfd')
    # restore sections.json (add-binary edits it) and drop comments
    (Path(ws) / 'sections.json').write_text(json.dumps(DEFAULT_SECTIONS, indent=2))
    (Path(ws) / 'comments.json').unlink(missing_ok=True)
    return 'reset to the freshly-served state (marks, worktree, comments cleared)'


def t_push_remote(repo, ws, port, slug=None):
    """Publish the built fixture to a throwaway GitHub repo + ensure its PR.

    Turns the manual git/gh seeding into one command so the real-PR write
    features have something to point at. Force-pushes because `build` makes
    fresh history each time — guarded so it can only ever target a repo whose
    name marks it a fixture.
    """
    slug = slug or FIXTURE_REMOTE
    if 'deskcheck-fixture' not in slug:
        sys.exit(f'refusing to push to {slug!r}: force-push is destructive, so the '
                 'name must contain "deskcheck-fixture"')
    url = f'git@github.com:{slug}.git'
    remotes = subprocess.run(['git', '-C', str(repo), 'remote'],
                             capture_output=True, text=True).stdout.split()
    sh(repo, 'git', 'remote', *(['set-url'] if 'origin' in remotes else ['add']),
       'origin', url)
    sh(repo, 'git', 'push', '--force', '-u', 'origin', 'main')
    sh(repo, 'git', 'push', '--force', '-u', 'origin', 'feature')
    # reuse only an OPEN PR; a closed/merged one must not be resurrected — make a fresh PR
    view = subprocess.run(['gh', 'pr', 'view', '--json', 'url,state',
                           '-q', 'select(.state=="OPEN") | .url'],
                          cwd=str(repo), capture_output=True, text=True)
    if view.returncode == 0 and view.stdout.strip():
        return f'pushed main+feature to {slug}; reused open PR {view.stdout.strip()}'
    pr_url = gh_out(repo, 'pr', 'create', '--base', 'main', '--head', 'feature',
                    '--title', 'deskcheck fixture PR',
                    '--body', 'Durable test PR for deskcheck real-PR features '
                    '(inline comments, replies, Viewed sync).').strip()
    return f'pushed main+feature to {slug}; created PR {pr_url}'


def t_reset_comments(repo, ws, port):
    """Delete every comment on the fixture PR — the remote half of `reset`, so
    the PR is pristine for the next test run (branch + PR stay put)."""
    slug = gh_out(repo, 'repo', 'view', '--json', 'nameWithOwner',
                  '-q', '.nameWithOwner').strip()
    num = gh_out(repo, 'pr', 'view', '--json', 'number', '-q', '.number').strip()
    # ponytail: first 100 only; a fixture never accrues more between resets
    review = json.loads(gh_out(
        repo, 'api', f'repos/{slug}/pulls/{num}/comments?per_page=100', '-q', '[.[].id]'))
    for cid in review:
        gh_out(repo, 'api', '--method', 'DELETE', f'repos/{slug}/pulls/comments/{cid}')
    issue = json.loads(gh_out(
        repo, 'api', f'repos/{slug}/issues/{num}/comments?per_page=100', '-q', '[.[].id]'))
    for cid in issue:
        gh_out(repo, 'api', '--method', 'DELETE', f'repos/{slug}/issues/comments/{cid}')
    return (f'deleted {len(review)} review + {len(issue)} conversation comment(s) '
            f'from {slug} PR #{num}')


TRANSITION_FNS = {
    'mark-partial': t_mark_partial, 'mark-section': t_mark_section,
    'mark-all': t_mark_all, 'unmark': t_unmark,
    'change-reviewed-file': t_change_reviewed_file, 'edit-file': t_edit_file,
    'stage-file': t_stage_file, 'add-binary': t_add_binary,
    'add-unsectioned-file': t_add_unsectioned_file, 'revert-file': t_revert_file,
    'add-comment': t_add_comment, 'add-note': t_add_note, 'reset': t_reset,
    'push-remote': t_push_remote, 'reset-comments': t_reset_comments,
}


# --- CLI --------------------------------------------------------------------
def print_state(repo, ws):
    print(f'fixture: {FIXTURE}')
    if not repo.exists():
        print('  not built yet — run: fixture.py build')
    else:
        status = subprocess.run(['git', '-C', str(repo), 'status', '--porcelain'],
                                capture_output=True, text=True).stdout.strip()
        marks = reviewed_files(ws) if (ws / 'review.db').exists() else []
        args = argparse.Namespace(repo=str(repo), workspace=str(ws), target='main')
        try:
            unsec = srv.unsectioned_now(args)
        except Exception:
            unsec = []
        print(f'  repo={repo}\n  ws={ws}')
        print(f'  reviewed files: {marks or "(none)"}')
        print(f'  unsectioned (drift): {unsec or "(none)"}')
        print(f'  git status:\n{status or "    (clean)"}')
        print('\n  serve it:\n    PY=python3; command -v uv >/dev/null && '
              'PY="uv run --with pygments"\n'
              f'    $PY {Path(__file__).resolve().parent}/server.py '
              f'--workspace {ws} --repo {repo} --target main')
    print('\ntransitions (fixture.py <name>; marking needs --port):')
    for name, help_ in TRANSITIONS:
        print(f'  {name:22} {help_}')


def run_check():
    """Build a temp fixture, serve it in-process, drive every transition, assert."""
    tmp = Path(tempfile.mkdtemp(prefix='deskcheck-fixture-check-'))
    try:
        repo, ws = build(tmp)
        srv.Handler.args = argparse.Namespace(
            workspace=str(ws), repo=str(repo), target='main')
        srv.Handler.con = srv.open_db(ws)
        srv.Handler.base = srv.merge_base(str(repo), 'main')
        httpd = srv.ThreadingHTTPServer(('127.0.0.1', 0), srv.Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        def page():
            return urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()

        assert 'Token rotation' in page(), 'sections not rendered'
        # real hunk bodies render (the whole point of going server-backed)
        fd = json.loads(urllib.request.urlopen(
            f'http://127.0.0.1:{port}/api/filediff?path=src/auth/tokens.py').read())
        assert len(fd['hunks']) >= 2, f'expected multi-hunk tokens.py, got {fd}'
        assert '<table class="diff">' in fd['hunks'][0]['html'], fd

        t_mark_partial(repo, ws, port)
        assert reviewed_files(ws) == ['src/auth/tokens.py'], reviewed_files(ws)

        t_change_reviewed_file(repo, ws, port)
        delta = json.loads(urllib.request.urlopen(
            f'http://127.0.0.1:{port}/api/reviewdelta?path=src/auth/tokens.py').read())
        assert delta['available'] and delta['hunks'], f'no review-delta: {delta}'
        assert '_touched_after_review' in delta['hunks'][0]['html'], delta

        t_add_unsectioned_file(repo, ws, port)
        assert 'Unsectioned changes' in page(), 'drift not surfaced'

        t_add_binary(repo, ws, port)
        fdb = json.loads(urllib.request.urlopen(
            f'http://127.0.0.1:{port}/api/filediff?path=web/assets/logo.bin').read())
        assert 'no diff to display' in fdb['hunks'][0]['html'], fdb

        t_edit_file(repo, ws, port)
        assert '"wip"' in page(), 'wip badge missing'

        t_add_comment(repo, ws, port)
        assert 'does rotation emit a metric' in page(), 'comment not embedded'

        t_mark_all(repo, ws, port)
        st = _get_state(port)
        for path in sectioned_files(ws):
            fk, _ = keys_for(repo, path)
            assert st.get(fk), f'{path} not marked after mark-all'

        t_reset(repo, ws, port)
        assert reviewed_files(ws) == [], 'reset left marks'
        assert 'Unsectioned changes' not in page(), 'reset left drift'

        httpd.shutdown()
        print('PASS')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('transition', nargs='?', default='state',
                    help='one of: ' + ', '.join(n for n, _ in TRANSITIONS))
    ap.add_argument('section_id', nargs='?',
                    help='section id (mark-section) or repo slug (push-remote)')
    ap.add_argument('--port', type=int, help='running server port (marking transitions)')
    ap.add_argument('--base', help='build: dir of "before" files (default: built-in)')
    ap.add_argument('--feature', help='build: dir of "after" files (default: built-in)')
    ap.add_argument('--sections', help='build: sections.json (default: built-in)')
    ap.add_argument('--check', action='store_true', help='self-test in a temp repo')
    args = ap.parse_args()

    if args.check:
        run_check()
        return

    repo, ws = FIXTURE / 'repo', FIXTURE / 'ws'
    name = args.transition
    if name == 'build':
        r, w = build(FIXTURE, args.base, args.feature, args.sections)
        print(f'built {FIXTURE}')
        print_state(r, w)
        return
    if name == 'state':
        print_state(repo, ws)
        return
    if name not in TRANSITION_FNS:
        ap.error(f'unknown transition {name!r}. choices: '
                 + ', '.join(n for n, _ in TRANSITIONS))
    if not repo.exists():
        sys.exit('no fixture — run: fixture.py build')
    fn = TRANSITION_FNS[name]
    # mark-section takes a section id; push-remote takes an optional repo slug
    msg = fn(repo, ws, args.port, args.section_id) \
        if name in ('mark-section', 'push-remote') else fn(repo, ws, args.port)
    print(msg)


if __name__ == '__main__':
    main()
