# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Claude Code plugin marketplace package (`agent-tools`) by Rob Madole. It provides AI agent tools for testing and quality assurance.

## Architecture

- **`.claude-plugin/marketplace.json`** — Top-level marketplace manifest. Declares the package name, owner, and lists all plugins.
- **`plugins/<name>/`** — Each plugin. Its config lives at `plugins/<name>/.claude-plugin/plugin.json` and its skills under `plugins/<name>/skills/<skill>/`.

The manifest schema follows `https://anthropic.com/claude-code/marketplace.schema.json`.

## Plugins & Skills

- **`testing`** — Testing tools for developing software.
  - `browser-test` — Orchestrate QA browser testing via Gherkin specs and Playwright. With `"runner": "jev"`, `scripts/jev-run.js` runs specs first with TypeSafe's Jev model and only its leftovers go to Claude subagents. Opt-in foci (`foci/*.md`, asked before every run) replay all scenarios on Claude to check accessibility (vendored axe-core) and responsive design; `report.js` records their findings and flags flaky scenarios.
  - `bug-hunter` — Time/count-boxed bug hunt against a feature branch, combining code reading with live browser verification, ending in a scored report.
  - `jit-catch` — Generate catching tests for Elixir code changes to check a diff for bugs.
  - Mod (`hooks/register.tsx`): live status of the newest browser-test run, read only from `{directory}/tmp/run-N/run.db` (no tool-call watching). A band above the prompt and a toast per new failure. Phases come from `report.js phase`, which `SKILL.md` calls at each phase boundary. The query and verdict logic are in `hooks/status.ts`. It needs the `sqlite3` binary.
- **`develop`** — Tools for writing code during development.
  - `hobgoblin` — Examine similar files for consistency violations and produce a list of differences.
- **`quality`** — Tools for reviewing code quality.
  - `deskcheck` — Local, interactive PR review: splits a branch diff into sections and serves a web UI with resumable per-section "reviewed" state.
  - Mod (`hooks/register.tsx`): under the prompt, shows the running deskcheck review's URL as a link and its hunks-reviewed count, polled from `server.py`'s `/api/progress`. Picks the URL up from the `Serving on` line in tool output; hides when the server stops answering.
- **`humanity`** — Agent to human interaction, or dealing with the wetware simians who walk on two legs.
  - `whoa-hang-on` — Stop and re-align a human who has lost the thread: backtrack from the last message and explain in a ladder of short, self-contained rungs, one per message, checking understanding at each rung before continuing.
  - `one-at-a-time` — The human says a list of questions, notes, or decisions is too much. Break it into single items, rewrite each to stand alone (no cross-references, no thread shorthand), and hand them over one per message, waiting for an answer before the next.
  - `explain-it` — `/explain-it setup|new <name>|view [name]`: set a repo up for animated explainers, start one (asks what it explains, then writes an outline for the human to approve), or open one in the browser. A thin wrapper over the `@explain-it/core` CLI run through `npx`; the authoring rules come from `npx @explain-it/core guide`, not this skill.

## Adding a New Skill

1. Create a directory under `plugins/<plugin-name>/skills/<skill-name>/`.
2. Add a `SKILL.md` with YAML frontmatter (`name`, `description`, `user-invokable`, `args`).
3. If it belongs to a new plugin, add the plugin entry to `.claude-plugin/marketplace.json` and create its `plugin.json`.
4. Run `bash scripts/deploy-skills.sh` to create the top-level symlink (or let the pre-commit hook handle it).

## Deployment

The top-level `skills/` directory contains symlinks to the canonical skill directories under `plugins/*/skills/*/`. This is required for `npx skills add` to discover skills.

- **`scripts/deploy-skills.sh`** — Creates and maintains these symlinks. It removes stale symlinks, detects naming collisions across plugins, and creates relative symlinks. Idempotent and safe to run repeatedly.
- **`scripts/bump-plugin-versions.sh`** — Detects which plugins have staged changes and increments their patch version in both `plugins/<name>/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Skips plugins whose `plugin.json` is already staged (assumes a manual version bump).
- **`lefthook.yml`** — Configures pre-commit hooks that run `deploy-skills.sh` and `bump-plugin-versions.sh`, auto-staging any modified files. Run `lefthook install` after cloning to activate the hooks.
