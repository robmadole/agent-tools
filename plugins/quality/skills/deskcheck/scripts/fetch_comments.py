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


# Thread resolution isn't in the REST comments API — only GraphQL exposes it,
# and the resolve/unresolve mutations are keyed by the thread's node id, so we
# capture both isResolved and that id here.
_THREADS_Q = '''query($owner:String!,$name:String!,$num:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$num){
    reviewThreads(first:100, after:$cursor){
      nodes{ id isResolved comments(first:100){ nodes{ databaseId } } }
      pageInfo{ hasNextPage endCursor } } } } }'''


def _index_from_threads(nodes):
    """{ REST comment id -> {resolved, thread_id} } from reviewThreads nodes."""
    out = {}
    for t in nodes:
        info = {'resolved': bool(t.get('isResolved')), 'thread_id': t.get('id')}
        for c in t.get('comments', {}).get('nodes', []):
            if c.get('databaseId') is not None:
                out[c['databaseId']] = info
    return out


def threads_index(repo, slug, n):
    """Map each inline comment id to its thread's {resolved, thread_id}.

    Best-effort: any GraphQL failure (perms, etc.) yields {}, so resolution
    simply doesn't show — the rest of the fetch is unaffected."""
    owner, _, name = slug.partition('/')
    out, cursor = {}, None
    for _ in range(30):  # page guard
        args = ['api', 'graphql', '-f', 'query=' + _THREADS_Q,
                '-F', 'owner=' + owner, '-F', 'name=' + name, '-F', f'num={n}']
        if cursor:
            args += ['-F', 'cursor=' + cursor]
        r = subprocess.run(['gh', *args], cwd=repo, capture_output=True, text=True)
        if r.returncode != 0:
            return {}
        try:
            threads = json.loads(r.stdout)['data']['repository']['pullRequest']['reviewThreads']
        except (KeyError, TypeError, json.JSONDecodeError):
            return out
        out.update(_index_from_threads(threads.get('nodes', [])))
        pi = threads.get('pageInfo', {})
        if not pi.get('hasNextPage'):
            return out
        cursor = pi['endCursor']
    return out


# GitHub's own @-autocomplete pulls from a repo's "mentionable users" (repo
# collaborators + everyone who has participated). This is that same list.
_MENTIONABLES_Q = '''query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    mentionableUsers(first:100){ nodes{ login name avatarUrl } } } }'''


def mentionable_users(repo, slug):
    """Repo's mentionable users — the source for the composer's @-autocomplete.

    Best-effort: any GraphQL failure yields [], and main() still falls back to
    the people already seen on the PR."""
    owner, _, name = slug.partition('/')
    r = subprocess.run(
        ['gh', 'api', 'graphql', '-f', 'query=' + _MENTIONABLES_Q,
         '-F', 'owner=' + owner, '-F', 'name=' + name],
        cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        return []
    try:
        nodes = json.loads(r.stdout)['data']['repository']['mentionableUsers']['nodes']
    except (KeyError, TypeError, json.JSONDecodeError):
        return []
    return [{'login': u['login'], 'name': u.get('name') or '',
             'avatar_url': u.get('avatarUrl') or ''} for u in nodes]


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
    tidx = threads_index(a.repo, slug, n)  # comment id -> {resolved, thread_id}
    # who's viewing — lets the UI offer edit/delete only on their own comments,
    # and gives the reply box the viewer's avatar
    vr = subprocess.run(['gh', 'api', 'user'],
                        cwd=a.repo, capture_output=True, text=True)
    vu = json.loads(vr.stdout) if vr.returncode == 0 else {}
    viewer = vu.get('login', '')

    # @-autocomplete source: the repo's mentionable users, unioned with everyone
    # already on this PR (authors beyond the first 100 mentionables, the viewer)
    # so the menu is never empty even if the GraphQL call is unavailable.
    mentionables = {m['login']: m for m in mentionable_users(a.repo, slug)}
    for c in inline + conv:
        u = c['user']
        mentionables.setdefault(u['login'], {
            'login': u['login'], 'name': '', 'avatar_url': u.get('avatar_url') or ''})
    if viewer:
        mentionables.setdefault(viewer, {
            'login': viewer, 'name': '', 'avatar_url': vu.get('avatar_url', '')})

    data = {
        'pr': n,
        'title': pr['title'],
        'url': pr['url'],
        'viewer': viewer,
        'viewer_avatar': vu.get('avatar_url', ''),
        'conversation': [{
            'author': c['user']['login'], 'avatar_url': c['user'].get('avatar_url'),
            'created_at': c['created_at'],
            'body': c.get('body') or '', 'url': c['html_url'],
            'body_html': render_md(a.repo, slug, c.get('body') or ''),
        } for c in conv],
        'inline': [{
            'id': c['id'],  # parent id for in_reply_to when replying
            'in_reply_to_id': c.get('in_reply_to_id'),  # thread linkage (None on roots)
            'resolved': tidx.get(c['id'], {}).get('resolved', False),  # resolved on GitHub?
            'thread_id': tidx.get(c['id'], {}).get('thread_id'),  # GraphQL id for mutations
            'path': c.get('path'),
            'line': c.get('line') or c.get('original_line'),
            'side': c.get('side') or 'RIGHT',
            'author': c['user']['login'], 'avatar_url': c['user'].get('avatar_url'),
            'created_at': c['created_at'],
            'body': c.get('body') or '', 'url': c['html_url'],
            'body_html': render_md(a.repo, slug, c.get('body') or ''),
        } for c in inline],
        'mentionables': sorted(mentionables.values(),
                               key=lambda m: m['login'].lower()),
    }
    ws = Path(a.workspace).expanduser()
    (ws / 'comments.json').write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    print(f'PR #{n}: {len(data["inline"])} inline, '
          f'{len(data["conversation"])} conversation')


if __name__ == '__main__':
    main()
