# deskcheck — feature inventory

Local, interactive PR review: GitHub's review flow running on your machine,
with an LLM doing the sectioning and a dumb stdlib server doing the serving.
Built 2026-07-22 → 2026-07-24.

## Review model
- **LLM-authored sections** — the diff is split into conceptual review units
  (feature + its tests, security surfaces, mechanical rename/generated chaff),
  each rated 1–5 for *review difficulty* and ordered hardest-first, so reviewer
  energy goes where it matters. Sections may overlap; single hunks can be
  pulled into a section via `extra_hunks`.
- **Three independent mark levels** — hunk, file, section. Marking collapses
  that level only; nothing cascades. Anything collapsed reopens by clicking
  its header.
- **Content-addressed marks** — hunk keys hash the hunk's content; file keys
  hash the file's patch. Marks survive re-sectioning and hunk reshuffling, and
  auto-invalidate when content actually changes. (Legacy positional keys are
  migrated on server start.)
- **Coverage counting** — a hunk counts as covered when it *or its file* is
  marked. Per-section progress bars + overall counter.
- **Fully Reviewed / In Review badge** — green only when every changed file is
  sectioned (no drift) and every hunk is covered.
- **New-file collapse** — a brand-new single-hunk file shows one button (file
  and hunk are the same review unit) and a new-file icon.
- **Changes since your review** — marking a file snapshots its content
  *as git's diff presents it* (clean filters/staging-proof). When the file
  later changes, the UI shows only the delta since your snapshot (with a
  toggle to the full diff). Marks that predate snapshots are reconstructed
  from git history by matching the mark's content-hash fingerprint against
  branch commits. Byte-identical content that merely moved says so.
- **Persistence & resume** — everything lives in
  `~/.deskcheck/<repo>/<branch>/` (sqlite + sections.json + comments.json).
  Kill anything, rerun the skill, resume with all marks intact.

## Diff rendering
- GitHub-style tables: line numbers, add/del tinting, horizontal scroll
  (no wrapping).
- Syntax highlighting via pygments (`uv run --with pygments`, plain-text
  fallback), plus **word-level intra-line emphasis** — changed characters
  within modified line pairs get the darker tint, via difflib +
  token-offset splitting.
- Sticky file headers while scrolling a long file.
- Renders working tree + staged changes (diff vs merge-base, re-anchored per
  page load).

## Performance
- **Lazy diffs** — the page ships structure only (~80 KB); hunk bodies load
  via IntersectionObserver as they approach the viewport. Placeholders are
  sized from hunk line counts so the scrollbar and jumps are accurate.
- **Render cache** — hunk HTML cached in sqlite keyed by path + content hash
  (invalidation is free). Page build uses one bulk `git diff`. ~0.08s loads.

## Navigation & UI
- Left nav: sections with difficulty dots, progress bars, and **collapsible
  per-section file lists** (folder open/closed icons, left-side ellipsis so
  filenames stay readable, click to jump to the file in that section).
- In-content "N files" disclosure chip per section with jump links.
- Copy-path button and **GitHub deep link** (`#diff-<sha256>`) beside every
  file name.
- Marking a file scrolls the viewport to its collapsed header (no stranding).
- Constant-width mark buttons with level-specific labels ("File reviewed" …).
- Consistent 16px Font Awesome icon system (check, copy, arrow-up-right,
  file-circle-plus, folder, folder-open, rotate).

## Live repo awareness
- **Drift detection** — files changed-but-unsectioned are collected into a
  synthetic "Unsectioned changes" section on every load; nothing escapes
  review. With `--exit-on-drift`, the server *is* the monitor: it exits with
  code 42 (debounced) and the harness wakes Claude to fold the new files into
  sections via the CLI and relaunch.
- **Retired files** — a sectioned file that stops differing renders as a
  grayed "no longer in diff" row; `sections.py prune` cleans them.
- **Uncommitted-state badges** — blue `staged` / `edited` / `staged + edited`
  pills from `git status --porcelain`, so you know what might still move.
- **Reconnecting overlay** — any failed XHR shows a centered spinner overlay,
  probes every 2s, and reloads when the server returns (restarts are routine:
  drift exits on purpose).

## GitHub integration
- **PR comments** — `fetch_comments.py` pulls inline + conversation comments;
  bodies rendered to HTML by GitHub's own `/markdown` API (GFM, mentions).
  Inline comments are spliced into the diff directly under their line;
  out-of-diff anchors fall back to the file with a note. Conversation lives
  in a collapsed panel up top.
- **Comment subscription** — ETag-conditional polling (304s are rate-limit
  free) auto-refreshes comments.json on count changes; the UI shows a
  "New comments — reload" pill. Manual refresh via the rotate icon button.
- **Viewed sync** (`--github-sync`) — local file marks mirror to the PR's
  per-file Viewed checkboxes via the `markFileAsViewed` GraphQL mutation,
  fire-and-forget.
- PR box in the nav with a deep link to the PR.

## Tooling
- `scripts/server.py` — stdlib http + sqlite; flags: `--exit-on-drift`,
  `--github-sync`, `--watch-comments`, `--port`.
- `scripts/render_diff.py` — standalone file→HTML-hunks renderer (composable).
- `scripts/sections.py` — CRUD CLI for sections.json (sections, files,
  extra hunks, prune) so edits cost commands, not JSON rewrites.
- `scripts/fetch_comments.py` — PR comments → comments.json.
- `scripts/selftest.py` — end-to-end smoke test in a throwaway repo (render,
  serve, marks, migration, drift, delta, backfill, badges): prints `PASS`.
