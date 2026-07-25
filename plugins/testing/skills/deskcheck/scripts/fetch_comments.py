#!/usr/bin/env python3
"""Fetch GitHub PR comments into <workspace>/comments.json via `gh`.

Pulls inline review comments (file+line anchored) and top-level conversation
comments. Rerun any time to refresh — the server reads comments.json on every
page load. Requires an authenticated `gh` and a PR for the branch.

  fetch_comments.py --workspace WS --repo /path/to/repo [--pr N]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def gh(repo, *args):
    r = subprocess.run(['gh', *args], cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'gh {" ".join(args[:2])} failed: {r.stderr.strip()}')
    return r.stdout


def render_md(repo, slug, text):
    """GitHub-flavored markdown → HTML via GitHub's own /markdown endpoint."""
    if not text.strip():
        return ''
    r = subprocess.run(['gh', 'api', 'markdown', '-f', f'text={text}',
                        '-f', 'mode=gfm', '-f', f'context={slug}'],
                       cwd=repo, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ''


def fetch_all(repo, endpoint):
    out, page = [], 1
    while True:
        batch = json.loads(gh(repo, 'api', f'{endpoint}?per_page=100&page={page}'))
        out.extend(batch)
        if len(batch) < 100 or page >= 30:
            return out
        page += 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--pr', type=int)
    a = ap.parse_args()

    pr_args = ['pr', 'view'] + ([str(a.pr)] if a.pr else []) + \
              ['--json', 'number,title,url']
    pr = json.loads(gh(a.repo, *pr_args))
    slug = gh(a.repo, 'repo', 'view', '--json', 'nameWithOwner',
              '-q', '.nameWithOwner').strip()
    n = pr['number']

    inline = fetch_all(a.repo, f'repos/{slug}/pulls/{n}/comments')
    conv = fetch_all(a.repo, f'repos/{slug}/issues/{n}/comments')

    data = {
        'pr': n,
        'title': pr['title'],
        'url': pr['url'],
        'conversation': [{
            'author': c['user']['login'], 'created_at': c['created_at'],
            'body': c.get('body') or '', 'url': c['html_url'],
            'body_html': render_md(a.repo, slug, c.get('body') or ''),
        } for c in conv],
        'inline': [{
            'path': c.get('path'),
            'line': c.get('line') or c.get('original_line'),
            'side': c.get('side') or 'RIGHT',
            'author': c['user']['login'], 'created_at': c['created_at'],
            'body': c.get('body') or '', 'url': c['html_url'],
            'body_html': render_md(a.repo, slug, c.get('body') or ''),
        } for c in inline],
    }
    ws = Path(a.workspace).expanduser()
    (ws / 'comments.json').write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    print(f'PR #{n}: {len(data["inline"])} inline, '
          f'{len(data["conversation"])} conversation')


if __name__ == '__main__':
    main()
