#!/usr/bin/env python3
"""Read (and resolve) the reviewer's local notes from a deskcheck workspace.

Notes are private, line-anchored annotations the reviewer jots in the web UI;
the server stores them in <workspace>/review.db. They are never sent to GitHub.
This reads them back so the agent can act on them when asked — "write up my
notes", "turn these into PR comments", "start fixing what I flagged" — and then
mark the ones it handled as resolved so they drop out of the UI and don't
resurface on the next pull. Stdlib only; works whether or not the server runs.

    notes.py --workspace ~/.deskcheck/<repo>/<branch> list          # open notes, markdown
    notes.py --workspace ... list --format json
    notes.py --workspace ... list --all                             # include resolved
    notes.py --workspace ... count                                  # open-note count
    notes.py --workspace ... resolve 3 7                            # mark #3 and #7 done
"""
import argparse
import json
import sqlite3
from pathlib import Path

COLS = ('id', 'path', 'line', 'side', 'body', 'created_at', 'updated_at')


def _connect(workspace):
    db = Path(workspace) / 'review.db'
    if not db.exists():
        return None
    con = sqlite3.connect(str(db), timeout=5)
    # older note tables predate resolved_at; add it so our queries work even if
    # the server hasn't restarted with the newer schema yet
    try:
        cols = [r[1] for r in con.execute('PRAGMA table_info(notes)')]
    except sqlite3.OperationalError:
        cols = []
    if cols and 'resolved_at' not in cols:
        con.execute('ALTER TABLE notes ADD COLUMN resolved_at TEXT')
        con.commit()
    return con


def read_notes(workspace, include_resolved=False):
    con = _connect(workspace)
    if con is None:
        return []
    where = '' if include_resolved else ' WHERE resolved_at IS NULL'
    try:
        rows = con.execute(
            'SELECT id, path, line, side, body, created_at, updated_at '
            'FROM notes' + where + ' ORDER BY path, line, id').fetchall()
    except sqlite3.OperationalError:
        return []  # no notes table yet
    finally:
        con.close()
    return [dict(zip(COLS, r)) for r in rows]


def resolve(workspace, ids):
    """Mark notes resolved (processed). Returns how many were newly resolved."""
    con = _connect(workspace)
    if con is None or not ids:
        return 0
    try:
        qs = ','.join('?' * len(ids))
        cur = con.execute(
            "UPDATE notes SET resolved_at=datetime('now') "
            'WHERE resolved_at IS NULL AND id IN (%s)' % qs, list(ids))
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def as_markdown(notes):
    if not notes:
        return '_No open local notes in this review._'
    out, cur = ['# Review notes', ''], None
    for n in notes:
        if n['path'] != cur:
            cur = n['path']
            out.append('## ' + cur)
        loc = '%s:%d%s' % (n['path'], n['line'],
                           ' (old side)' if n['side'] == 'LEFT' else '')
        out.append('- [#%d] **%s** — %s' % (n['id'], loc, n['body']))
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--workspace', required=True)
    ap.add_argument('command', nargs='?', default='list',
                    choices=['list', 'count', 'resolve'])
    ap.add_argument('ids', nargs='*', type=int, help='note ids (for resolve)')
    ap.add_argument('--format', default='md', choices=['md', 'json'])
    ap.add_argument('--all', action='store_true', help='include resolved notes')
    a = ap.parse_args()

    if a.command == 'resolve':
        if not a.ids:
            ap.error('resolve needs one or more note ids (see the #N in `list`)')
        n = resolve(a.workspace, a.ids)
        print('resolved %d note%s' % (n, '' if n == 1 else 's'))
        return

    notes = read_notes(a.workspace, include_resolved=a.all)
    if a.command == 'count':
        print(len(notes))
    elif a.format == 'json':
        print(json.dumps(notes, indent=2))
    else:
        print(as_markdown(notes))


if __name__ == '__main__':
    main()
