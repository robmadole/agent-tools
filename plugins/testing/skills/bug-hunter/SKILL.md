---
name: bug-hunter
description: Run a structured, time/count-boxed bug hunt against a feature branch of a web app — combining code reading with live browser verification (Playwright MCP), keeping a running list in persistent memory, and ending with a structured report where every confirmed bug has a LOW/MEDIUM/HIGH impact score, the shortest possible repro steps, and a screenshot of the error state. Use this whenever the user asks to "find bugs", "bug hunt", "QA this branch/feature", "test this feature for bugs", "poke holes in this UI", or sets a goal like "run until N bugs are found or T hours pass" — even if they don't say the word "bug-hunter".
---

# Bug Hunter

You are hunting for real, user-visible bugs — not style nits, not hypotheticals. A bug
counts only when you have reproduced it in the running app (or proven it at the HTTP/DB
layer) and can state exact steps someone else could follow. The deliverable is the report;
the discipline below exists so every entry in it survives scrutiny.

## Session setup (do this first, ~5 minutes)

1. **Record the box.** Note the start time and the stop condition (e.g. "5 bugs or 2 hours").
   Check the clock between phases; when the box closes, stop hunting and write the report.
2. **Scope the change.** `git log main..HEAD --oneline` and `git diff main...HEAD --stat`.
   Identify the feature's surfaces (pages, modals, API endpoints, admin screens) and its
   spec/plan docs if the repo has them.
3. **Verify the environment.** Confirm the dev URL responds before anything else. Find test
   credentials (look for a seed-users doc, spec quickstarts, or seeds scripts — dev password
   conventions are usually documented). Confirm DB access if available; you will want it to
   verify what actually got persisted.
4. **Create the running list** as a memory file immediately (before the first finding), with
   the box parameters and target URL. Update it the moment each bug is confirmed — the
   session can die; the file must not lag behind reality.

## The hunt loop

Alternate between two modes; each feeds the other:

- **Code reading** finds candidates: guards missing modifier-key checks, defaults that
  violate a validator elsewhere, hardcoded values the admin can change, state that survives
  a close/reopen, index-based entitlement seams, pipelines with redirecting error handlers.
  Read the biggest new files line-by-line — the 800-line component hides more than ten
  50-line ones.
- **Browser verification** decides. Drive the real app with Playwright MCP. Read framework
  state directly (e.g. the Vuex/Redux store via `evaluate`) instead of scraping text — it
  tells you what the app *believes*, which is where bugs live. Watch the network panel for
  status codes; check the DB for what persisted.

Rules that keep findings honest:

- **Run a control.** Before blaming the feature, test the same behavior on an unrelated
  route or state. A redirect that happens on every page is environment, not the feature.
  A behavior also present on `main` is pre-existing — note it, don't count it.
- **Suspect your tooling before the app.** Dead clicks, empty snapshots, and stale tabs are
  usually the harness. Reproduce in a fresh tab/context before calling anything a bug.
  A JS `el.click()` succeeding where a real click fails means *something* is intercepting —
  find out what before writing it up.
- **One root cause = one bug.** The same flawed logic copy-pasted into three components is
  one bug with three surfaces. Before counting a new entry, ask whether one fix closes both.
- **Chase the full chain.** A suspicious stored value only becomes a confirmed bug when you
  show where it surfaces to a user (flip the admin switch, approve the submission, load the
  public page). Use the DB directly to set up states the UI makes slow to reach — restore
  anything you change.
- **Test the boundaries the code names.** Every cap, limit, date, and feature flag in the
  diff is an invitation: hit the cap, cross the date, flip the flag, load deep links signed
  out and with stale cookies.

## Confirming a bug

At the moment of confirmation — while the broken state is on screen — do all three:

1. **Screenshot the error state** to a stable path (scratchpad or workspace), named
   `bug<N>-<slug>.png`. Do it now; the state may be expensive to recreate later.
2. **Minimize the repro.** Strip steps until removing one more makes the bug vanish. A curl
   one-liner beats a five-step UI dance when it proves the same defect.
3. **Write the memory entry**: where (file:line of root cause), what, repro, impact, fix
   sketch. Then keep hunting.

## Impact scoring

- **HIGH** — data loss or corruption, broken core flow (the thing the feature exists to do),
  security/entitlement bypass, or silent failure affecting a broad class of users.
- **MEDIUM** — a real flow fails but with a workaround, wrong-but-recoverable output, broken
  deep links, misleading state shown to users.
- **LOW** — cosmetic or edge-case-only, self-healing, or mitigated by an existing safety net
  (e.g. a moderation queue catches it).

Score by *user consequence*, not by how clever the find was.

## Report structure

End the session with this exact template (also mirror it into the memory file):

```
# Bug hunt — <feature> — <date>
Box: <limit> · Elapsed: <time> · Result: <N confirmed bugs>

## Bug <N>: <one-line title> — <LOW|MEDIUM|HIGH>
- Where: <file:line of root cause>
- Repro (shortest): <numbered steps or one-liner>
- Expected / Actual: <one line each>
- Screenshot: <path>
- Fix sketch: <one line>

## Ruled out (with reason)
- <candidate> — <why it's not a bug: control passed / pre-existing / tooling artifact>
```

The "Ruled out" section is not filler — it is what makes the confirmed list credible, and it
saves the next hunter from re-investigating the same ghosts.
