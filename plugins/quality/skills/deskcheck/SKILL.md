---
name: deskcheck
description: >-
  Local, interactive PR review — GitHub's PR review flow running on the user's
  machine. Splits the branch diff into conceptual review sections ordered
  hardest-first, serves a web UI with syntax-highlighted collapsible diffs, and
  persists per-section/file/hunk "reviewed" state in sqlite so a review can be
  paused and resumed. Use whenever the user wants to review a pull request,
  branch, or set of changes themselves — "review this PR with me", "help me
  review these changes", "start a review of this branch", "set up a review",
  "/deskcheck" — even if they don't mention a UI or sections. Not for reviews
  where Claude is the reviewer; this skill sets up a review for a human.
compatibility: python3 (stdlib only). Optional pygments for syntax colors — prefer `uv run --with pygments` when uv is installed.
---

# Local PR Review

You do the understanding (split the diff into review sections, hardest first).
The bundled scripts do the rendering and serving. The human does the reviewing
in their browser. Your output is a `sections.json` file plus a running server —
never hand-write the UI; the template in `assets/` is the UI.

## 1. Resolve what to review

- **Target**: the merge target. Default: the repo's default *remote-tracking*
  branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, e.g.
  `origin/main`; fall back to `origin/main`). Use the `origin/` ref, **not** the
  local branch — a local `main` that's behind `origin/main` produces a much
  larger, misleading diff. If the remote-tracking ref may be stale, `git fetch`
  first (or tell the user to). If the user names a different ref ("against
  develop", "vs release/2.0"), use that.
- **Scope**: the whole diff by default. If the user names files, directories,
  subjects, or features, build sections only from those.
- **Diff base**: always the merge base. The scripts run
  `git merge-base <target> HEAD` themselves — pass `--target <branch>` and
  don't worry about two-dot vs three-dot. Uncommitted changes are included.

If `git diff --stat $(git merge-base <target> HEAD)` is empty, tell the user
there's nothing to review and stop.

## 2. Workspace (this is what makes resume work)

```
WS=~/.deskcheck/<repo-dir-name>/<branch-with-/-as-->
mkdir -p "$WS"
```

If `$WS/sections.json` already exists, this is a **resume**: skip section
generation entirely (their progress lives in `$WS/review.db` and shows up
automatically) and go straight to step 4. Only regenerate sections if the user
explicitly asks. Review marks are content-addressed (hunk marks key on a hash
of the hunk's content, file marks on the file's patch hash), so they survive
regeneration and hunk reshuffling, and automatically invalidate when the
underlying change actually changes — a file whose mark went stale shows a
"changed since review" badge.

## 3. Build sections.json — the actual thinking

This is the step where you earn your keep, so read the diff for real:
`git diff --stat` for the shape, then the full diff (file by file for big
branches). The mission is to shorten the review and save the human energy — a
flat alphabetical file list hides the connections; your sections reveal them.

A good section is a reviewable unit of *meaning*:

- a feature or concept **plus its tests** (reviewing code next to its tests is
  cheaper than meeting them 40 files later)
- a security- or money-relevant surface that deserves undivided attention
- a batch of similar mechanical changes (renames, import moves, formatting,
  generated files, lockfiles) — collapse the boring into one easy section
- sections may overlap: a file or hunk can appear in several sections when it
  genuinely belongs to both (state is global, so marking it reviewed in one
  place marks it everywhere)

Difficulty is *review effort*, not code size — rate 1–5 and **order the
sections array hardest first** (the server renders in array order; reviewer
energy is highest at the start):

- 5 — novel/complex logic, security surfaces, migrations, concurrency
- 4 — substantial features with cross-module interplay
- 3 — straightforward new code and its tests
- 2 — simple additive changes, config, templates
- 1 — mechanical: renames, formatting, lockfiles, generated output

Aim for 3–10 sections. **Coverage check**: every file in `git diff --stat`
must land in at least one section (unless the user narrowed scope) — add a
final low-difficulty "Everything else" section rather than silently dropping
files.

Write `$WS/sections.json`:

```json
{
  "title": "Short human title for the PR",
  "branch": "feature-branch-name",
  "sections": [
    {
      "id": "kebab-slug",
      "title": "Human title",
      "difficulty": 5,
      "summary": "2–3 sentences: what this is and what to scrutinize while reviewing it.",
      "files": ["lib/foo.ex", "test/foo_test.exs"],
      "extra_hunks": [{"file": "lib/router.ex", "index": 2}]
    }
  ]
}
```

`files` pulls in every hunk of those files. `extra_hunks` pulls single hunks
from files that mostly belong to another section (e.g. the one route added in
a router file). Hunk `index` is 0-based in diff order — check with
`scripts/render_diff.py --repo <repo> --target <target> --file <path> --json`
or by counting `@@` blocks in `git diff <merge-base> -- <path>`.

For a **scoped review** (user named a subset), also set a top-level
`"scope": ["path/prefix", ...]` (git pathspecs). The server uses it to limit
drift detection (below) to the reviewed area — without it, every out-of-scope
changed file would be flagged as unsectioned.

## Drift: new commits and working-tree edits mid-review

The server re-resolves the merge base and re-diffs on every page load, so
content changes to sectioned files just appear (and content-hash marks
invalidate where the content really changed). Files that change but appear in
no section are collected automatically into a synthetic **"Unsectioned
changes"** section at the bottom — reviewable immediately, so nothing escapes.
With `--exit-on-drift` the server also exits 42 to wake you (see step 4).
When that fires — or the user mentions drift, or you see unsectioned files on
a resume — read the new files' diffs and fold them in **via the CLI, not by
rewriting the JSON**: `scripts/sections.py --workspace "$WS" add-files <id>
<paths…>` (or `add-section` first if none fits). The server picks the edit up
on the next reload, and existing marks survive because keys are
content-addressed. Brand-new files must be `git add`ed (or `git add -N`) to
show up at all — `git diff` can't see untracked files.

The reverse direction needs no signal: a sectioned file that stops differing
from the target (reverted, or its change landed upstream) renders as a grayed
"no longer in diff" row and counts for nothing. Clean these with
`scripts/sections.py --workspace "$WS" prune --repo <repo> --target <target>`
— it removes them and tells you which sections went empty. (A file *deleted
by the branch* is different — that still has a real deletion diff to review.)

## 4. Serve and hand off

```bash
PY="python3"; command -v uv >/dev/null && PY="uv run --with pygments"
$PY <skill-dir>/scripts/server.py --workspace "$WS" --repo <repo-root> \
    --target <target> --exit-on-drift
```

The server binds a free port (no `--port` needed) and prints
`Serving on http://127.0.0.1:<PORT>` to stdout on startup. Read that line
from the background process's output to learn the actual port — use it for the
curl check, the browser open, and the URL you give the user.

When the branch has a PR, add `--github-sync --watch-comments` too:
`--watch-comments` ETag-polls the PR every 60s (304s are rate-limit-free) and
auto-refreshes comments.json when comment counts change; the UI then shows a
"New comments — reload" pill.

Run it in the background. `--exit-on-drift` makes the process itself the drift
monitor: when changed files appear that no section covers (stable across two
30s polls), it prints `DRIFT_DETECTED: … <files>` and **exits with code 42**.
Your background-task notification for that exit is the signal — read the
DRIFT_DETECTED line, fold the listed files into sections.json, and relaunch —
but add `--port <the port from the original "Serving on" line>` so the restart
reuses the same port instead of drifting to a new one (the user's browser tab
is still open on the old URL). Then tell the user what was added. Any other exit code is
not drift (144 ≈ killed). If nobody is listening when it fires, nothing is
lost: the user reruns the skill and the resume flow picks up the drift.

**GitHub sync**: when the branch has a PR (`gh pr view` succeeds), add
`--github-sync` to the server command — local *file* marks then mirror to the
PR's per-file "Viewed" checkboxes on github.com (fire-and-forget; hunk and
section marks stay local since GitHub has no such granularity).

**GitHub comments**: if the branch has a PR (`gh pr view` succeeds), also run
`scripts/fetch_comments.py --workspace "$WS" --repo <repo-root>` — it writes
`comments.json`, and the UI shows the PR conversation in a collapsed panel up
top plus inline comments anchored to their hunks (falling back to the file
when the anchor line left the diff). Rerun it whenever the user wants fresh
comments. Skip silently when there's no PR or no `gh`.

Using the port from the server's `Serving on …` line, verify with
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<PORT>/` (expect 200),
then open the browser (`open http://127.0.0.1:<PORT>/` on macOS) and tell the
user:

- the URL, and that the review lives entirely on their machine
- progress saves on every click; killing the server loses nothing — rerun the
  skill on the same branch to resume

Leave the server running; don't kill it when the conversation moves on.

## UI semantics (so you can explain them)

Marks are independent per level, collapse is the shared effect: marking a
**hunk** reviewed collapses that hunk; marking a **file** reviewed collapses
the file but does not mark its hunks; marking a **section** reviewed collapses
the section but does not mark its files or hunks. Anything collapsed can be
reopened by clicking its header. The left nav lists sections with a per-section
progress bar counting hunks *covered* — a hunk counts when it or its whole
file is marked reviewed. When every changed file is sectioned (no drift) and
every hunk is covered, a green "Fully Reviewed" badge appears at the top of
the nav. Marking a file also snapshots its content (as git's diff presents
it — staging-proof); when the file later changes, the UI shows only the
**changes since your review** (with a toggle to the full diff) instead of
resurfacing the whole file. Marks with no stored snapshot are reconstructed
from git history — the mark's content hash fingerprints the reviewed diff, so
the matching commit's content is recovered automatically; only marks made
against never-committed working-tree states fall back to the full diff. Files pulled in via `extra_hunks` show only their
hunk's mark button (the rest of that file belongs to another section), and a
file whose content changed after being marked shows a "changed since review"
badge instead of staying silently green.

## Scripts

- `scripts/server.py` — the review server (stdlib http.server + sqlite)
- `scripts/render_diff.py` — standalone: file + target → syntax-highlighted
  HTML hunks (used by the server, also composable on its own)
- `scripts/sections.py` — CRUD CLI for sections.json (list / show /
  add-section / update-section / remove-section / add-files / remove-files /
  add-hunk / remove-hunk / prune). Author the initial sections.json with one
  Write (rich summaries belong in prose); use this CLI for every edit after
  that — cheaper and safer than rewriting the file
- `scripts/fetch_comments.py` — pull a PR's inline + conversation comments
  from GitHub (via `gh`) into the workspace's comments.json
- `scripts/selftest.py` — end-to-end smoke test in a throwaway repo; run it if
  you suspect the plumbing (prints `PASS`)
- `scripts/fixture.py` — maintainer harness for iterating on the review UI:
  builds a throwaway git repo with a real diff, which you serve with the real
  `server.py`, then drives through named state transitions (`change-reviewed-file`,
  `add-binary`, `add-unsectioned-file`, `mark-all`, `add-comment`, …) so any UI
  state can be reproduced live. `fixture.py state` prints the transition menu;
  `fixture.py --check` self-tests. Not used in the review flow itself. GitHub
  write-back (`--github-sync`, `--watch-comments`) is out of scope for the local
  fixture — point `server.py` at a real PR to exercise those.
