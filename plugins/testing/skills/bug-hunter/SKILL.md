---
name: bug-hunter
description: Run a structured, time/count-boxed bug hunt against a feature branch of a web app — fanning out parallel finders via a Claude Code Workflow, deciding each candidate with live browser verification (Playwright MCP), keeping a running list in persistent memory, and ending with a ReportFindings report where every confirmed bug has a LOW/MEDIUM/HIGH impact score, the shortest possible repro steps, and a screenshot of the error state. Use this whenever the user asks to "find bugs", "bug hunt", "QA this branch/feature", "test this feature for bugs", "poke holes in this UI", or sets a goal like "run until N bugs are found or T hours pass" — even if they don't say the word "bug-hunter".
---

# Bug Hunter

You are hunting for real, user-visible bugs — not style nits, not hypotheticals. A bug
counts only when you have reproduced it in the running app (or proven it at the HTTP/DB
layer) and can state exact steps someone else could follow. The deliverable is the report;
the discipline below exists so every entry in it survives scrutiny.

The shape of the hunt is a fan-out: **scout once to find the work-list, fan out parallel
finders and cheap skeptics over it in a Workflow, then decide the survivors live yourself.**
Reading code and refuting weak candidates parallelize cleanly; the live browser (a shared,
flaky resource) stays sequential and supervised in the main agent, where it belongs.

## 1. Scout inline first (~5 minutes, before the fan-out)

This runs in the main agent and produces the work-list the Workflow fans out over. Do not
skip to the Workflow — it has nothing to fan out over until this is done.

1. **Record the box.** Note the start time and the stop condition (e.g. "5 bugs or 2 hours").
   Check the clock between phases; when the box closes, stop hunting and write the report.
2. **Scope the change into surfaces.** `git log main..HEAD --oneline` and
   `git diff main...HEAD --stat`. Group the changed files into the feature's surfaces (pages,
   modals, API endpoints, admin screens) with their spec/plan docs if the repo has them. This
   list of surfaces — each with its files — is the work-list.
3. **Verify the environment.** Confirm the dev URL responds before anything else. Find test
   credentials (a seed-users doc, spec quickstarts, seeds scripts — dev password conventions
   are usually documented). Confirm DB access if available; you will want it to verify what
   actually got persisted.
4. **Create the running list** as a memory file immediately (before the first finding), with
   the box parameters, target URL, and the surface work-list. Update it the moment each bug is
   confirmed — the session can die; the file must not lag behind reality.

## 2. Fan out the hunt (Workflow)

Author and run **one** Workflow, passing the scouted context as `args`
(`{ surfaces, baseRef, devUrl }`). Three phases:

- **Find** — one finder per surface, in parallel. Each reads its surface's new/changed code
  line-by-line, biggest files first (the 800-line component hides more than ten 50-line
  ones), and returns candidate bugs: root-cause `file:line`, the flawed-logic hypothesis, the
  shortest repro it can propose, suspected impact. Finders may probe read-only via HTTP/DB but
  do **not** reproduce live. Things they look for: guards missing modifier-key checks,
  defaults that violate a validator elsewhere, hardcoded values the admin can change, state
  that survives a close/reopen, index-based entitlement seams, pipelines with redirecting
  error handlers.
- **Dedup** — one merge agent collapses same-root-cause candidates across surfaces (**one root
  cause = one bug**, even when the same flawed logic is copy-pasted into three components) and
  ranks by suspected user impact.
- **Refute** — one adversarial skeptic per deduped candidate, in parallel, each prompted to
  *kill* it cheaply before any live-browser time is spent: **run a control** (does the same
  behavior happen on an unrelated route, or already on `baseRef`? — then it's environment or
  pre-existing, not this feature), **suspect the tooling** before the app, reason from
  code/HTTP/DB/git. It survives only if the skeptic cannot kill it. Live UI repro is *not* the
  skeptic's job — that's the main agent's, next.

Workflow agents reach Playwright/DB MCP tools via ToolSearch; scripts are plain JS (no
`Date.now`/`Math.random`). Scale finders to the surface count; **one** skeptic per candidate.
If deduped candidates exceed ~a dozen, refute the top-by-impact and `log()` what you deferred
— never silently cap. A deeper hunt (user asks to "be thorough") widens the skeptic per
candidate into a 3-vote refuter panel.

Skeleton to adapt:

```js
export const meta = {
  name: 'bug-hunt',
  description: 'Fan out parallel finders across a feature branch, dedup by root cause, adversarially refute candidates',
  phases: [
    { title: 'Find',   detail: 'one finder per surface, read new code' },
    { title: 'Dedup',  detail: 'merge same-root-cause candidates' },
    { title: 'Refute', detail: 'one skeptic per candidate tries to kill it' },
  ],
}
const { surfaces, baseRef, devUrl } = args

const CANDIDATE = { type:'object', required:['candidates'], properties:{ candidates:{ type:'array',
  items:{ type:'object', required:['title','file','hypothesis','repro'], properties:{
    title:{type:'string'}, category:{type:'string'}, file:{type:'string'}, line:{type:'number'},
    hypothesis:{type:'string'}, repro:{type:'string'}, impact:{type:'string'} } } } } }
const VERDICT = { type:'object', required:['survives','reason'], properties:{
  survives:{type:'boolean'}, reason:{type:'string'}, preExisting:{type:'boolean'}, needsLiveRepro:{type:'boolean'} } }

phase('Find')
const found = (await parallel(surfaces.map(s => () =>
  agent(`Hunt bugs in the "${s.name}" surface of this feature branch (diff vs ${baseRef}).
Read its new/changed code line-by-line, biggest files first. Look for missing modifier-key
guards, defaults that violate a validator elsewhere, hardcoded values an admin can change,
state that survives close/reopen, index-based entitlement seams, error handlers that redirect.
Files: ${s.files.join(', ')}. Return candidate bugs with root-cause file:line, the flawed-logic
hypothesis, the shortest repro you can propose, and suspected impact. Do NOT reproduce live.`,
    { label:`find:${s.name}`, phase:'Find', schema:CANDIDATE })
))).filter(Boolean).flatMap(r => r.candidates)

phase('Dedup')
const deduped = (await agent(`Merge these candidate bugs so one root cause = one entry, even
when the same flawed logic appears in several components. Rank by suspected user impact.
Candidates: ${JSON.stringify(found)}`, { phase:'Dedup', schema:CANDIDATE })).candidates

phase('Refute')
const TOP = deduped.slice(0, 10)
if (deduped.length > TOP.length) log(`Refuting top ${TOP.length}/${deduped.length} by impact; deferred the rest.`)
const judged = await parallel(TOP.map(c => () =>
  agent(`Try to REFUTE this candidate bug. Run a control: does the same behavior happen on an
unrelated route, or already on ${baseRef}? Suspect the tooling before the app. Reason from
code/HTTP/DB/git — do not drive the live browser. If you cannot kill it, it survives.
Candidate: ${JSON.stringify(c)}. Dev URL: ${devUrl}`,
    { label:`refute:${c.title}`, phase:'Refute', schema:VERDICT })
    .then(v => ({ ...c, ...v }))))

return judged.filter(Boolean).filter(v => v.survives && !v.preExisting)
```

## 3. Confirm live (main agent, in the loop)

The Workflow hands you the survivors. Now **you** decide each one in the running app — this is
where a candidate becomes a bug. Work them highest-suspected-impact first, until the box
closes. For each survivor:

1. **Reproduce in the real app** with Playwright MCP. Read framework state directly (e.g. the
   Vuex/Redux store via `evaluate`) instead of scraping text — it tells you what the app
   *believes*, which is where bugs live. Watch the network panel for status codes; check the
   DB for what persisted. **Chase the full chain**: a suspicious stored value is only a bug
   once you show where it surfaces to a user (flip the admin switch, approve the submission,
   load the public page) — use the DB directly to set up states the UI makes slow to reach,
   and restore anything you change. **Test the boundaries the code names**: hit the cap, cross
   the date, flip the flag, load deep links signed out and with stale cookies.
2. **Screenshot the error state** — now, while it's on screen; the state may be expensive to
   recreate — to a stable path named `bug<N>-<slug>.png`.
3. **Minimize the repro.** Strip steps until removing one more makes the bug vanish. A curl
   one-liner beats a five-step UI dance when it proves the same defect.
4. **Update the memory entry**: root-cause `file:line`, what, repro, impact, fix sketch,
   screenshot path.

A survivor you can reproduce live is **CONFIRMED**. One you can only prove at the code/HTTP/DB
layer (not in the UI) is **PLAUSIBLE**. One that won't stand up — a control now passes, it's
pre-existing on `main`, or it was a tooling artifact — moves to **Ruled out** with the reason.

## Impact scoring

- **HIGH** — data loss or corruption, broken core flow (the thing the feature exists to do),
  security/entitlement bypass, or silent failure affecting a broad class of users.
- **MEDIUM** — a real flow fails but with a workaround, wrong-but-recoverable output, broken
  deep links, misleading state shown to users.
- **LOW** — cosmetic or edge-case-only, self-healing, or mitigated by an existing safety net
  (e.g. a moderation queue catches it).

Score by *user consequence*, not by how clever the find was.

## 4. Report with ReportFindings

Collate, then call **ReportFindings once** with the confirmed and plausible bugs, ranked
most-severe first (pass an empty array if nothing survived). The tool renders the list — do
**not** also print the findings as text. Field mapping per finding:

- `category` — bug-type slug, kebab-case (`entitlement-bypass`, `data-loss`, `state-leak`,
  `broken-flow`, `validation-gap`).
- `file` / `line` — the root cause.
- `short_summary` — the claim alone, ≤60 chars.
- `summary` — one sentence stating the defect.
- `failure_scenario` — the minimized repro → wrong result (append `screenshot: bug<N>-<slug>.png`).
- `verdict` — `CONFIRMED` (reproduced live) or `PLAUSIBLE` (proven at code/HTTP/DB only).
- `level` — the hunt's depth, matching the box (small box → `medium`; a thorough sweep → `high`+).

After the tool call, present the negative space as brief text: the **Ruled out (with reason)**
list — each candidate and why it's not a bug (control passed / pre-existing / tooling artifact)
— and point to the memory file, which mirrors everything (full narrative, screenshots, ruled-out)
so the session can die without losing the record. The Ruled-out section is not filler: it is
what makes the confirmed list credible and saves the next hunter from re-investigating ghosts.
