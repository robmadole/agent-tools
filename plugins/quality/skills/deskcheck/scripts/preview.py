#!/usr/bin/env python3
"""Static state-preview harness for the deskcheck review UI.

Renders template.html against hand-authored DATA fixtures — no git, no server,
no PR — so you can iterate on the look-and-feel of each UI state in isolation.
Writes an HTML file you open in a browser.

    preview.py                     # -> preview.html  (state: in-review)
    preview.py fully-reviewed      # -> preview.html  (that state)
    preview.py --all               # -> preview-<state>.html for both states
    preview.py in-review --open    # render and open in the browser
    preview.py --check             # self-test: both states render

Two states, each a full page: `in-review` carries every in-progress state at
once (partial/stale/wip/binary/unsectioned/done section); `fully-reviewed` is
the completion state.

Deferred: real diff bodies. The hunk *code* lazy-loads from /api/filediff, which
needs a live server + git, so here each hunk renders as a correctly-sized blank
box (the client reserves min-height from the @@ header). That's fine for chrome
work; snapshot real filediff output into a fixture only if you need to style the
code rows themselves.

Adding a state: add a `def _name(d): ...; return d` that mutates the deep-copied
BASE, then register it in STATES. Keys the client reads:
    section:<id>            file:<path>:<hash>            hunk:<path>:<id>
"""
import argparse
import copy
import json
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from server import render_template  # noqa: E402


def _f(h, *headers):
    """A file entry: content hash + hunk headers only (no code bodies)."""
    return {'hash': h, 'wip': None,
            'hunks': [{'index': i, 'id': 'h%d' % i, 'header': hdr}
                      for i, hdr in enumerate(headers)]}


def base():
    """A realistic multi-section diff: deep trees, many files, long names.
    Hunks carry headers only (no code)."""
    return {
        'title': 'Add refresh-token rotation and harden the public API',
        'branch': 'feature/token-refresh',
        'target': 'origin/main',
        'sections': [
            {'id': 'auth', 'title': 'Session & refresh-token rotation', 'difficulty': 5,
             'summary': 'Core change: rotate the refresh token on every use and '
                        'revoke the old one. Read this one first.',
             'files': ['src/auth/session.py', 'src/auth/tokens.py',
                       'src/auth/middleware/require_authentication.py']},
            {'id': 'api', 'difficulty': 4,
             'title': 'GraphQL resolver error handling, N+1 query batching, and '
                      'cursor pagination across the entire public API surface',
             'summary': 'Wrap resolvers in a consistent error envelope, batch the '
                        'user/org lookups, and switch list fields to cursor pagination.',
             'files': ['src/api/graphql/resolvers/user_resolver.py',
                       'src/api/graphql/resolvers/organization_resolver.py',
                       'src/api/graphql/resolvers/billing/subscription_resolver.py',
                       'src/api/graphql/schema.py',
                       'src/api/rest/v2/handlers.py']},
            {'id': 'ui', 'title': 'Nav signed-in state & user menu', 'difficulty': 2,
             'summary': 'Show the signed-in user in the top nav with a dropdown.',
             'files': ['web/src/components/navigation/UserMenu.jsx',
                       'web/src/components/navigation/NavBar.jsx',
                       'web/src/components/navigation/dropdown/'
                       'AccountDropdownMenuContainer.jsx',
                       'web/src/styles/navigation.css',
                       'web/src/assets/images/brand/logo-primary-dark.png']},
            {'id': 'tests', 'title': 'Backfill regression tests', 'difficulty': 1,
             'summary': 'Cover the rotation edge cases and resolver pagination.',
             'files': ['tests/unit/auth/'
                       'test_session_rotation_and_token_revocation_behavior.py',
                       'tests/unit/api/graphql/test_user_resolver_pagination.py',
                       'tests/integration/test_end_to_end_sign_in_flow.py',
                       'src/legacy/util/'
                       'deprecated_helpers_pending_removal_in_next_major_version.py']},
        ],
        'files': {
            'src/auth/session.py': _f('a1',
                '@@ -10,6 +10,18 @@ def login(request):',
                '@@ -40,3 +40,12 @@ def logout(request):'),
            'src/auth/tokens.py': _f('a2', '@@ -1,5 +1,20 @@ import time'),
            'src/auth/middleware/require_authentication.py': _f('a3',
                '@@ -12,8 +12,24 @@ class RequireAuth:',
                '@@ -55,2 +71,9 @@ def _unauthorized():'),
            'src/api/graphql/resolvers/user_resolver.py': _f('b1',
                '@@ -30,10 +30,28 @@ async def resolve_user(info, id):',
                '@@ -88,4 +106,15 @@ def _batch_load(ids):'),
            'src/api/graphql/resolvers/organization_resolver.py': _f('b2',
                '@@ -14,6 +14,19 @@ async def resolve_org(info, id):'),
            'src/api/graphql/resolvers/billing/subscription_resolver.py': _f('b3',
                '@@ -8,3 +8,17 @@ async def resolve_subscription(info):'),
            'src/api/graphql/schema.py': _f('b4', '@@ -120,5 +120,22 @@ type Query {'),
            'src/api/rest/v2/handlers.py': _f('b5',
                '@@ -66,7 +66,14 @@ def handle_webhook(req):'),
            'web/src/components/navigation/UserMenu.jsx': _f('c1',
                '@@ -5,12 +5,40 @@ export function UserMenu() {',
                '@@ -60,3 +88,11 @@ function Avatar() {'),
            'web/src/components/navigation/NavBar.jsx': _f('c2',
                '@@ -18,6 +18,15 @@ export function NavBar() {'),
            'web/src/components/navigation/dropdown/AccountDropdownMenuContainer.jsx':
                _f('c3', '@@ -0,0 +1,64 @@'),
            'web/src/styles/navigation.css': _f('c4', '@@ -40,4 +40,18 @@ .nav {'),
            'web/src/assets/images/brand/logo-primary-dark.png':
                {'hash': 'x1', 'wip': None,
                 'hunks': [{'index': 0, 'id': 'b0', 'header': '', 'binary': True}]},
            'tests/unit/auth/test_session_rotation_and_token_revocation_behavior.py':
                _f('d1', '@@ -0,0 +1,120 @@'),
            'tests/unit/api/graphql/test_user_resolver_pagination.py':
                _f('d2', '@@ -0,0 +1,88 @@'),
            'tests/integration/test_end_to_end_sign_in_flow.py':
                _f('d3', '@@ -0,0 +1,54 @@'),
            'src/legacy/util/deprecated_helpers_pending_removal_in_next_major_version.py':
                _f('d4', '@@ -200,12 +200,3 @@ def old_helper():'),
        },
        'state': {},
        'comments': None,
        'comments_rev': 0,
        'preview': True,  # suppresses live-server behaviors (reconnect overlay)
    }


def _mark(d, paths, sections=()):
    st = {}
    for sid in sections:
        st['section:' + sid] = True
    for path in paths:
        st['file:' + path + ':' + d['files'][path]['hash']] = True
        for h in d['files'][path]['hunks']:
            st['hunk:' + path + ':' + h['id']] = True
    return st


def _mark_all(d):
    return _mark(d, d['files'].keys(), [s['id'] for s in d['sections']])


def fully_reviewed(d):
    """Completion state: everything marked → the "Fully Reviewed" banner."""
    d['state'] = _mark_all(d)
    return d


def _comments():
    """A PR conversation + a couple of file-level review comments.
    (Line-anchored inline comments render against the live diff, which the static
    preview doesn't load, so these are attached at the file level.)"""
    url = 'https://github.com/acme/webapp/pull/4217'
    def c(author, when, body, path=None):
        e = {'author': author, 'created_at': when, 'body': body, 'url': url,
             'body_html': '<p>' + body + '</p>'}
        if path is not None:
            e.update({'path': path, 'line': None, 'side': 'RIGHT'})
        return e
    return {
        'pr': 4217, 'url': url,
        'conversation': [
            c('octocat', '2026-07-20T14:32:00Z',
              'Rotating on every use closes the replay window — nice. Can we emit a '
              'metric for revocations so we can alert on spikes?'),
            c('hubot', '2026-07-21T09:05:00Z',
              'Added a tokens.revoked counter in the latest push.'),
        ],
        'inline': [
            c('octocat', '2026-07-20T14:40:00Z',
              'Guard this webhook handler against duplicate deliveries.',
              path='src/api/rest/v2/handlers.py'),
            c('hubot', '2026-07-21T10:00:00Z',
              'Add a case here for an already-expired refresh token.',
              path='tests/integration/test_end_to_end_sign_in_flow.py'),
        ],
    }


def in_review(d):
    """One page carrying every in-progress state at once:
    a done section, a partial section with a stale + a wip file, fresh sections,
    a binary, an unsectioned drift section, and a PR with comments."""
    secs = {s['id']: s for s in d['sections']}
    st = {}
    # auth: a fully reviewed section (green in nav + header)
    st.update(_mark(d, secs['auth']['files'], ['auth']))
    # api: partial — files 1,2 reviewed; file 0 stale (marked at an older hash,
    # changed since); file 3 has uncommitted (wip) changes; file 4 untouched
    api = secs['api']['files']
    st.update(_mark(d, api[1:3]))
    st['file:' + api[0] + ':' + d['files'][api[0]]['hash'] + '_old'] = True
    d['files'][api[3]]['wip'] = 'edited'
    # ui: fresh, with a wip file and the binary
    d['files'][secs['ui']['files'][0]]['wip'] = 'staged + edited'
    d['state'] = st
    # a drift section the branch grew after sections were generated
    p = 'scripts/db/migrate_0042_add_token_rotation_columns.py'
    d['files'][p] = _f('u1', '@@ -0,0 +1,40 @@')
    d['files'][p]['wip'] = 'edited'
    d['sections'].append({
        'id': '_unsectioned', 'title': 'Unsectioned changes', 'difficulty': 2,
        'summary': 'Files that changed after sections were generated (new commits '
                   'or working-tree edits).',
        'files': [p]})
    d['comments'] = _comments()
    d['comments_rev'] = 1
    return d


STATES = {
    'in-review': in_review,
    'fully-reviewed': fully_reviewed,
}


def render(name):
    return render_template(STATES[name](copy.deepcopy(base())))


def _check():
    for name in STATES:
        html = render(name)
        assert '__DATA__' not in html, f'{name}: DATA not substituted'
        blob = html.split('const DATA = ', 1)[1].split(';\n', 1)[0]
        json.loads(blob.replace('\\u003c', '<'))  # embedded JSON is valid
    full = fully_reviewed(copy.deepcopy(base()))
    for path, f in full['files'].items():
        assert full['state'].get('file:' + path + ':' + f['hash']), path
    ir = in_review(copy.deepcopy(base()))
    assert any(s['id'] == '_unsectioned' for s in ir['sections'])  # has drift
    print(f'ok: {len(STATES)} states render')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('states', nargs='*', default=['in-review'],
                    help='state name(s); choices: ' + ', '.join(STATES))
    ap.add_argument('--all', action='store_true', help='render every state')
    ap.add_argument('--open', action='store_true', help='open the result in a browser')
    ap.add_argument('--check', action='store_true', help='self-test all states and exit')
    args = ap.parse_args()

    if args.check:
        _check()
        return

    names = list(STATES) if args.all else args.states
    unknown = [n for n in names if n not in STATES]
    if unknown:
        ap.error(f"unknown state(s): {', '.join(unknown)}. choices: {', '.join(STATES)}")

    outputs = []
    for name in names:
        out = Path.cwd() / (f'preview-{name}.html' if len(names) > 1 else 'preview.html')
        out.write_text(render(name))
        outputs.append(out)
        print(out)
    if args.open and outputs:
        webbrowser.open(outputs[0].as_uri())


if __name__ == '__main__':
    main()
