#!/usr/bin/env python3
"""CRUD CLI for a review workspace's sections.json.

Edit the review structure without rewriting the whole file:

  sections.py --workspace WS list
  sections.py --workspace WS show ID
  sections.py --workspace WS add-section ID --title T [--difficulty 1-5]
              [--summary S] [--position I]
  sections.py --workspace WS update-section ID [--title T] [--difficulty N]
              [--summary S] [--position I]
  sections.py --workspace WS remove-section ID
  sections.py --workspace WS add-files ID PATH [PATH ...]
  sections.py --workspace WS remove-files ID PATH [PATH ...]
  sections.py --workspace WS add-hunk ID FILE INDEX
  sections.py --workspace WS remove-hunk ID FILE INDEX
  sections.py --workspace WS prune --repo REPO [--target main]

The server re-reads sections.json per page load, so edits are live on the
next browser refresh. Review marks are content-addressed and survive any
restructuring done here.
"""
import argparse
import json
import sys
from pathlib import Path


def load(ws):
    path = Path(ws).expanduser() / 'sections.json'
    if not path.exists():
        sys.exit(f'{path} does not exist')
    return path, json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def find(data, sid):
    sec = next((s for s in data['sections'] if s['id'] == sid), None)
    if sec is None:
        sys.exit(f'no section {sid!r}; have: '
                 + ', '.join(s['id'] for s in data['sections']))
    return sec


def brief(sec):
    n_f = len(sec.get('files', []))
    n_h = len(sec.get('extra_hunks', []))
    extra = f' +{n_h} hunk{"s" if n_h != 1 else ""}' if n_h else ''
    return f'{sec["id"]}  d{sec.get("difficulty", "?")}  {n_f} files{extra}  {sec["title"]}'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--workspace', required=True)
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('list')

    p = sub.add_parser('show')
    p.add_argument('id')

    for name in ('add-section', 'update-section'):
        p = sub.add_parser(name)
        p.add_argument('id')
        p.add_argument('--title', required=(name == 'add-section'))
        p.add_argument('--difficulty', type=int, choices=range(1, 6))
        p.add_argument('--summary')
        p.add_argument('--position', type=int)

    p = sub.add_parser('remove-section')
    p.add_argument('id')

    for name in ('add-files', 'remove-files'):
        p = sub.add_parser(name)
        p.add_argument('id')
        p.add_argument('paths', nargs='+')

    for name in ('add-hunk', 'remove-hunk'):
        p = sub.add_parser(name)
        p.add_argument('id')
        p.add_argument('file')
        p.add_argument('index', type=int)

    p = sub.add_parser('prune')
    p.add_argument('--repo', required=True)
    p.add_argument('--target', default='main')

    a = ap.parse_args()
    path, data = load(a.workspace)
    secs = data['sections']

    if a.cmd == 'list':
        for i, s in enumerate(secs):
            print(f'{i:2}. {brief(s)}')
        return

    if a.cmd == 'show':
        s = find(data, a.id)
        print(brief(s))
        if s.get('summary'):
            print('  ' + s['summary'])
        for f in s.get('files', []):
            print('  ' + f)
        for e in s.get('extra_hunks', []):
            print(f'  {e["file"]} (hunk {e["index"]} only)')
        return

    if a.cmd == 'add-section':
        if any(s['id'] == a.id for s in secs):
            sys.exit(f'section {a.id!r} already exists')
        sec = {'id': a.id, 'title': a.title,
               'difficulty': a.difficulty or 3,
               'summary': a.summary or '', 'files': []}
        secs.insert(a.position if a.position is not None else len(secs), sec)
    elif a.cmd == 'update-section':
        sec = find(data, a.id)
        for field in ('title', 'difficulty', 'summary'):
            val = getattr(a, field)
            if val is not None:
                sec[field] = val
        if a.position is not None:
            secs.remove(sec)
            secs.insert(a.position, sec)
    elif a.cmd == 'remove-section':
        secs.remove(find(data, a.id))
        print(f'removed {a.id}')
    elif a.cmd == 'add-files':
        sec = find(data, a.id)
        files = sec.setdefault('files', [])
        files.extend(p for p in a.paths if p not in files)
    elif a.cmd == 'remove-files':
        sec = find(data, a.id)
        missing = [p for p in a.paths if p not in sec.get('files', [])]
        if missing:
            sys.exit('not in section: ' + ' '.join(missing))
        sec['files'] = [f for f in sec['files'] if f not in a.paths]
    elif a.cmd == 'add-hunk':
        sec = find(data, a.id)
        ref = {'file': a.file, 'index': a.index}
        hunks = sec.setdefault('extra_hunks', [])
        if ref not in hunks:
            hunks.append(ref)
    elif a.cmd == 'remove-hunk':
        sec = find(data, a.id)
        ref = {'file': a.file, 'index': a.index}
        if ref not in sec.get('extra_hunks', []):
            sys.exit(f'no hunk {a.index} of {a.file} in {a.id}')
        sec['extra_hunks'].remove(ref)
    elif a.cmd == 'prune':
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from render_diff import _git, merge_base
        base = merge_base(a.repo, a.target)
        scope = data.get('scope') or []
        changed = set(_git(a.repo, 'diff', '--name-only', base,
                           '--', *scope).splitlines())
        for s in secs:
            dead = [f for f in s.get('files', []) if f not in changed]
            dead_h = [e for e in s.get('extra_hunks', [])
                      if e['file'] not in changed]
            if dead:
                s['files'] = [f for f in s['files'] if f in changed]
                print(f'{s["id"]}: pruned ' + ' '.join(dead))
            for e in dead_h:
                s['extra_hunks'].remove(e)
                print(f'{s["id"]}: pruned hunk {e["index"]} of {e["file"]}')
            if not s.get('files') and not s.get('extra_hunks'):
                print(f'{s["id"]}: now empty — remove-section if unwanted')
        sec = None

    save(path, data)
    if a.cmd not in ('remove-section', 'prune'):
        print(brief(sec))


if __name__ == '__main__':
    main()
