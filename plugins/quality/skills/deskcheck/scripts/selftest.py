#!/usr/bin/env python3
"""End-to-end smoke test: throwaway repo -> render -> serve -> toggle -> persist."""
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server as srv
from render_diff import render_file


def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


def main():
    tmp = Path(tempfile.mkdtemp(prefix='deskcheck-selftest-'))
    repo, ws = tmp / 'repo', tmp / 'ws'
    repo.mkdir(), ws.mkdir()
    sh(repo, 'git', 'init', '-q', '-b', 'main')
    sh(repo, 'git', 'config', 'user.email', 't@t')
    sh(repo, 'git', 'config', 'user.name', 't')
    (repo / 'app.py').write_text('def add(a, b):\n    return a + b\n')
    sh(repo, 'git', 'add', '.')
    sh(repo, 'git', 'commit', '-qm', 'init')
    sh(repo, 'git', 'checkout', '-qb', 'feature')
    (repo / 'app.py').write_text(
        'def add(a, b):\n    return a + b  # sum\n\n\ndef sub(a, b):\n    return a - b\n')
    sh(repo, 'git', 'add', '.')
    sh(repo, 'git', 'commit', '-qm', 'add sub')

    hunks = render_file(str(repo), 'main', 'app.py')
    assert hunks and '<table class="diff">' in hunks[0]['html'], hunks
    assert 'class="emph"' in hunks[0]['html'], 'intra-line emphasis missing'
    assert len(hunks[0]['id']) == 12, hunks[0]
    hunk_key = f"hunk:app.py:{hunks[0]['id']}"

    (ws / 'sections.json').write_text(json.dumps({
        'title': 'selftest', 'branch': 'feature',
        'sections': [{'id': 'core', 'title': 'Core change', 'difficulty': 3,
                      'summary': 'adds sub()', 'files': ['app.py']}],
    }))

    import argparse
    srv.Handler.args = argparse.Namespace(
        workspace=str(ws), repo=str(repo), target='main')
    srv.Handler.con = srv.open_db(ws)
    srv.Handler.base = srv.merge_base(str(repo), 'main')
    httpd = srv.ThreadingHTTPServer(('127.0.0.1', 0), srv.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    page = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert 'Core change' in page and '__DATA__' not in page
    assert '<table class="diff">' not in page, 'page should not inline diff HTML'

    fd = json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/filediff?path=app.py').read())
    assert fd['hunks'] and '<table class="diff">' in fd['hunks'][0]['html'], fd
    assert fd['hunks'][0]['id'] == hunks[0]['id'], fd
    cached = sqlite3.connect(ws / 'review.db').execute(
        'SELECT count(*) FROM render_cache').fetchone()
    assert cached[0] >= 1, 'render cache not populated'

    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/api/toggle',
        data=json.dumps({'key': hunk_key}).encode(),
        headers={'Content-Type': 'application/json'})
    res = json.loads(urllib.request.urlopen(req).read())
    assert res == {'key': hunk_key, 'reviewed': True}, res

    state = json.loads(
        urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state').read())
    assert state[hunk_key] is True, state

    row = sqlite3.connect(ws / 'review.db').execute(
        'SELECT reviewed FROM reviews WHERE item_key=?', (hunk_key,)).fetchone()
    assert row == (1,), row

    # files changed after sectioning surface as an "Unsectioned changes" section
    assert 'Unsectioned changes' not in page
    (repo / 'extra.py').write_text('x = 1\n')
    sh(repo, 'git', 'add', 'extra.py')
    page2 = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert 'Unsectioned changes' in page2 and 'extra.py' in page2
    assert srv.unsectioned_now(srv.Handler.args) == ['extra.py']

    # comments.json (from fetch_comments.py) is embedded into the page
    (ws / 'comments.json').write_text(json.dumps({
        'pr': 1, 'title': 't', 'url': 'u',
        'conversation': [{'author': 'alice', 'created_at': '2026-01-01T00:00:00Z',
                          'body': 'looks good overall', 'url': 'u'}],
        'inline': [{'path': 'app.py', 'line': 2, 'side': 'RIGHT', 'author': 'bob',
                    'created_at': '2026-01-01T00:00:00Z', 'body': 'nit here',
                    'url': 'u'}],
    }))
    page3 = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert 'looks good overall' in page3 and 'nit here' in page3

    # legacy positional keys migrate to content-hash form
    con = srv.open_db(ws)
    con.execute("INSERT INTO reviews(item_key, reviewed) VALUES('hunk:app.py:0', 1)")
    con.execute("INSERT INTO reviews(item_key, reviewed) VALUES('file:app.py', 1)")
    con.commit()
    srv.migrate_legacy_keys(con, str(repo), 'main', srv.merge_base(str(repo), 'main'))
    migrated = {k for (k,) in con.execute('SELECT item_key FROM reviews')}
    assert hunk_key in migrated and f"file:app.py:{srv.file_hash(hunks)}" in migrated, migrated
    assert 'hunk:app.py:0' not in migrated and 'file:app.py' not in migrated, migrated

    # review-delta: mark a file (snapshot), change it, expect only the delta
    file_key = f'file:app.py:{srv.file_hash(hunks)}'

    def toggle_key(k):
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/toggle',
            data=json.dumps({'key': k}).encode(),
            headers={'Content-Type': 'application/json'})
        return json.loads(urllib.request.urlopen(req).read())

    if not toggle_key(file_key)['reviewed']:
        toggle_key(file_key)
    snap = sqlite3.connect(ws / 'review.db').execute(
        'SELECT content FROM snapshots WHERE path=?', ('app.py',)).fetchone()
    assert snap and 'def sub(a, b):' in snap[0], 'snapshot not captured'

    with open(repo / 'app.py', 'a') as f:
        f.write('\n\ndef mul(a, b):\n    return a * b\n')
    delta = json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/reviewdelta?path=app.py').read())
    assert delta['available'] and len(delta['hunks']) == 1, delta
    assert 'mul' in delta['hunks'][0]['html'], 'delta missing new function'
    assert 'def add' not in delta['hunks'][0]['html'], \
        'delta should not re-show already-reviewed lines'
    unmarked = json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/reviewdelta?path=nope.py').read())
    assert unmarked == {'available': False, 'hunks': []}, unmarked

    # backfill: a pre-snapshot-era mark is reconstructed from git history
    sh(repo, 'git', 'commit', '-aqm', 'add mul')
    hunks2 = render_file(str(repo), 'main', 'app.py')
    file_key2 = f'file:app.py:{srv.file_hash(hunks2)}'
    if not toggle_key(file_key2)['reviewed']:
        toggle_key(file_key2)
    con2 = srv.open_db(ws)
    con2.execute('DELETE FROM snapshots')
    con2.commit()
    with open(repo / 'app.py', 'a') as f:
        f.write('\n\ndef div(a, b):\n    return a / b\n')
    delta2 = json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/reviewdelta?path=app.py').read())
    assert delta2['available'], 'backfill from history failed'
    assert 'div' in delta2['hunks'][0]['html'], delta2
    assert 'def add' not in delta2['hunks'][0]['html'], \
        'backfilled delta re-shows content reviewed at mark time'
    resnap = con2.execute('SELECT count(*) FROM snapshots').fetchone()
    assert resnap[0] == 1, 'backfill should persist the reconstructed snapshot'

    # uncommitted-state badge: app.py currently has unstaged edits, then staged
    page4 = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert '"wip": "edited"' in page4, 'unstaged edit not flagged'
    sh(repo, 'git', 'add', 'app.py')
    page5 = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert '"wip": "staged"' in page5, 'staged change not flagged'

    # binary files decline to render a diff
    (repo / 'blob.bin').write_bytes(bytes(range(256)) * 16)
    sh(repo, 'git', 'add', 'blob.bin')
    sdata = json.loads((ws / 'sections.json').read_text())
    sdata['sections'][0]['files'].append('blob.bin')
    (ws / 'sections.json').write_text(json.dumps(sdata))
    fdb = json.loads(urllib.request.urlopen(
        f'http://127.0.0.1:{port}/api/filediff?path=blob.bin').read())
    assert 'no diff to display' in fdb['hunks'][0]['html'], fdb
    page6 = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode()
    assert '"binary": true' in page6, 'binary flag missing from page metadata'

    # sections.py CLI round-trip
    cli = Path(__file__).resolve().parent / 'sections.py'

    def cli_run(*cmd):
        return subprocess.run([sys.executable, str(cli), '--workspace', str(ws),
                               *cmd], capture_output=True, text=True)

    assert cli_run('add-section', 'extras', '--title', 'Extras',
                   '--difficulty', '1', '--summary', 's').returncode == 0
    assert cli_run('add-files', 'extras', 'extra.py').returncode == 0
    assert cli_run('add-hunk', 'extras', 'app.py', '0').returncode == 0
    data = json.loads((ws / 'sections.json').read_text())
    assert data['sections'][-1]['files'] == ['extra.py']
    assert data['sections'][-1]['extra_hunks'] == [{'file': 'app.py', 'index': 0}]
    assert 'extras' in cli_run('list').stdout
    assert cli_run('remove-files', 'extras', 'nope.py').returncode != 0
    assert cli_run('remove-section', 'extras').returncode == 0
    assert 'extras' not in cli_run('list').stdout

    httpd.shutdown()
    shutil.rmtree(tmp)
    print('PASS')


if __name__ == '__main__':
    main()
