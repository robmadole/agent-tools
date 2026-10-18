---
name: browser-test
description: "Orchestrate QA browser testing via Gherkin specs and Playwright, with two-actor scenarios for shared pages, opt-in focus checks (accessibility, responsive design), an optional fast Jev runner, and project step helpers that run without a model request."
version: 2.6.0
---

# Browser Test — QA Testing with Gherkin Specs

You orchestrate a multi-phase QA browser testing workflow. You generate Gherkin specs from code changes, execute them against a running application via Playwright MCP tools, and produce a comprehensive test report.

You perform all roles directly — spec generation, reporting, gap analysis — and use **subagents only for concurrent test execution** (up to 3 Playwright instances in parallel).

When `.browser-tests.json` sets `"runner": "jev"`, execution starts with `scripts/jev-run.js`, a script that drives the browser with TypeSafe's Jev model instead of a Claude subagent. It is several times faster and uses no Claude tokens. Scenarios it can't settle fall back to the Claude subagents.

Before any test runs, the operator can opt into **foci**: extra disciplines, such as accessibility or responsive design, checked by replaying every scenario after the functional run. Each focus is a file in `foci/`. The replay also gives every scenario a second attempt, and scenarios whose attempts disagree for no reason anyone found are marked **flaky**. See Setup step 0c, Phase 2d and Phase 2e.

Underneath both runners sits `{directory}/playwright-helpers.js`: step phrasings mapped to Playwright code that runs with no model request at all. The Jev runner loads it with `--helpers`, the Claude runner calls it through `page.__runStep`, and it is the same function in both. A helper that can't settle a step defers to the model rather than failing it, so the file is only ever an optimization — see Phase 2c, which grows it from what a run actually spent requests on.

## Modes of operation

Determine from $ARGUMENTS what mode of operation we'll be in. If you cannot deduce this ask the user directly: "Would you like to create or run existing tests?"

### "Create"

The operator is asking you to generate new Gherkin specs by analyzing a PR, a feature area, or description — then execute them.

### "Run"

The operator is asking to run tests that already exist in the `.browser-tests.json` `directory` attribute.

## Prerequisites

Before proceeding, verify all of the following. If any check fails, stop immediately with the corresponding message.

1. **Playwright MCP** — Find the three Playwright MCP instances and note the **full tool prefix of each one**. Don't assume the prefix: it depends on where the servers are configured.
   - From the testing plugin's own `.mcp.json`, tools are named `mcp__plugin_testing_playwright-1__browser_navigate` and so on, so the prefix is `mcp__plugin_testing_playwright-1__`.
   - From the project's `.mcp.json`, they are `mcp__playwright-1__browser_navigate`, so the prefix is `mcp__playwright-1__`.
   - Other hosts may name them differently again.

   Look through the tools you have for names ending in `__browser_navigate`. If none are listed, they may be deferred: find them with ToolSearch, one search per instance (queries `+playwright-1 browser_navigate`, `+playwright-2 browser_navigate`, `+playwright-3 browser_navigate`, `max_results` 3 each), in one turn. A single `+playwright` search fills its result cap with one server's tools and can't show whether the others exist. Any tool returned for an instance proves it exists; its prefix is everything before `browser_`. You need three distinct prefixes, one per instance. Record them in order; they become `{playwright tool prefix}` for the runner subagents.

   **If fewer than three respond**, work with what you have rather than stopping — an instance can drop mid-session. Tell the operator how many you found, and reduce the batch size in Phase 2 to that number, running feature files in sequence on the instances that answer. Stop only when none respond.

   The three instances need distinct command lines. Claude Code drops a plugin MCP server whose command line matches an earlier one ("Suppressing plugin MCP server … duplicates earlier plugin server"), so with identical args only `playwright-1` would come up. That is the only job of `--profile-dir-name=playwright-N` in the plugin's `.mcp.json`: Playwright MCP reads it only with `--extension`, so under `--isolated` it does nothing. Don't remove it.

   **Check the helper bridge** on the first instance, passing the project root (the absolute path of the directory holding `.browser-tests.json`):

   ```
   {prefix}browser_run_code_unsafe with code:
   async (page) => { if (typeof page.__runStep !== "function") return null; await page.__runStep("", { root: "<project root>" }); return page.__helpers; }
   ```

   - `null`: the bridge isn't loaded. The servers in use were started without `--init-page`, usually because another plugin or the project's own `.mcp.json` defines servers with the same names and won. Warn the operator, then carry on: every step goes to the model, so the run costs more and takes longer.
     > The Playwright helper bridge isn't loaded: `page.__runStep` is missing, so every step will go to the model. Check that the Playwright servers in use are the testing plugin's (another plugin or the project's `.mcp.json` may define `playwright-1..3` too).
   - `loaded: false`, or a `reason`: the bridge is there but broken. Show the `reason` to the operator and carry on.
   - `config: false`: no `.browser-tests.json` at that root. Check the path you passed.
   - Otherwise say nothing. `project` is how many project helpers loaded, and 0 is normal for a project that has none yet.

   > This skill requires 3 Playwright MCP server instances (playwright-1, playwright-2, playwright-3), which the testing plugin configures in its `.mcp.json`. Ensure the `@playwright/mcp` package is available and all three servers are running.

2. **Bun** — Verify that `bun` is available by running `bun --version`.

   > This skill requires Bun to run the validation script. Install it from https://bun.sh before running `/browser-test`.

3. **Agent tool** — Verify that the `Agent` tool is available (used for concurrent test execution and audit subagents).

   Both runners are headless: the MCP servers pass `--headless`, and `jev-run.js` launches headless unless given `--headed`. A dozen browser windows opening and stealing focus mid-run is the thing that makes a full suite unpleasant to sit through, and nothing in either runner needs a visible window — screenshots, network capture and the accessibility snapshot all work without one. To watch a run, pass `--headed` to `jev-run.js`; for the Claude runner, drop `--headless` from the plugin's `.mcp.json`.

   The helper bridge needs `--init-page`, which `@playwright/mcp` has had since 0.0.82. The plugin's `.mcp.json` asks for `@latest`, so this is normally a non-issue — but if none of the three Playwright servers came up at all, an unsupported flag is the first thing to suspect, because the server exits on an unknown option rather than ignoring it. Nothing else here depends on the bridge: a run without it is the run you got before it existed.

4. **Jev runner** (only when `runner` is `jev`) — Google Chrome must be installed, since `scripts/jev-run.js` drives it through `playwright-core`. A TypeSafe key must be available, either as `TYPESAFE_API_KEY` in the environment or through `jev.envFile`. The runner reports a missing key on its first invocation; stop there if it does.

   > The Jev runner needs Google Chrome and a TypeSafe API key. Set `TYPESAFE_API_KEY`, or point `jev.envFile` in `.browser-tests.json` at a file that sets it.

---

## Bash discipline

Every Bash call you make in this skill is subject to a permissions check. Operators pre-allowlist commands by their bare verb (e.g. `Bash(mkdir:*)`, `Bash(bun:*)`, `Bash(git diff:*)`). Clever chaining defeats the allowlist and forces the operator to babysit the run.

**Hard rules — apply to every phase, including testdata processing, setup, and validation:**

- **One command per Bash call.** No `&&`, `;`, `||`, pipes (`|`), command substitution (`$(...)`, backticks), or redirects between commands.
- **No `for` / `while` loops, no `xargs`, no inline shell scripts.** If you need to run the same command on N inputs, make N separate Bash calls (in parallel where they're independent).
- **No heredoc Python, Node, or Bun snippets to "speed things up."** Use a plain command, or write a real file and invoke it.
- **No subshells or grouping** (`( ... )`, `{ ... ; }`).
- **Keep arguments surgical.** Prefer `mkdir -p ./a` then `mkdir -p ./b` over `mkdir -p ./a ./b ./c`. The narrower the invocation, the easier it is for the operator to allowlist it once and forget.
- **Variable substitution happens in Claude, not the shell.** When a `testdata:` line references `$something`, replace it with the literal value before issuing the Bash call — never let the shell expand it.

When you need to run several independent commands, make multiple Bash tool calls in a single message so they run in parallel. That's cheap and stays within the rules.

If a command genuinely needs composition (rare), stop and ask the operator rather than chaining.

---

## Setup Phase

### 0. Load configuration

Read `.browser-tests.json` from the repository root. If it does **not** exist, stop and tell the operator:

> No `.browser-tests.json` found.

After informing them of this, proceed to go through `references/setup.md` in order to get this file created.

If it exists, load `directory`, `baseURL`, `furtherSetup`, and the optional `verificationTools`, `runner`, `reports`, and `jev` from it.

`runner` (optional) is `"claude"` (the default) or `"jev"`. `jev` (optional) holds the Jev runner's knowledge of the app, which Claude runners get from reading `furtherSetup`:
- `routes`: page names to paths, e.g. `{"Sign In": "/sessions/sign-in"}`.
- `values`: labeled values steps may refer to, e.g. `{"password": "password", "free account email": "free@example.com"}`.
- `envFile`: a file holding `TYPESAFE_API_KEY`, if it isn't in the environment.

`references/setup.md` covers how to fill these in.

If `furtherSetup` is set, read that file (it is a path relative to the repository root). This provides project-specific testing context (test credentials, seed data, application quirks) that should be substituted into the runner subagent prompt and referenced during spec generation.

`verificationTools` (optional) is an array of MCP tool names (or name prefixes) that runner subagents may use — in addition to Playwright — to verify external system state in `Then` steps (e.g. `["mcp__stripe__stripe_api_read", "mcp__stripe__stripe_api_search"]`). Treat these as **read-only** verification tools. If the key is absent or empty, runners stay Playwright-only. This value is substituted into the runner prompt as `{verification tools}` during agentic dispatch.

### 0b. Choose report formats

`reports` (optional) is an array naming what this run produces: `"markdown"`, `"visual"`, or both.

If the key is absent but the operator's request already names a format — "give me an HTML report",
"visual report", "just the markdown" — take that as the answer and say which you picked. "HTML",
"visual" and "a page I can look at" all mean `"visual"`; "markdown", "md" and "the usual report"
mean `"markdown"`.

If the key is **absent** and they haven't said, use `["visual"]` without asking. Say which you
picked in one line, and offer to persist it to `.browser-tests.json`.

Visual is the default because it is the format people actually read: one self-contained HTML page,
one screenshot per step, grouped into per-scenario filmstrips. It costs a screenshot and a record
call per step, which the Jev runner pays almost nothing for and a Claude runner notices. Markdown is
still there for the appendable textual record across runs — set `"reports": ["markdown"]`, or
`["markdown", "visual"]` for both.

Whatever they pick, **steps are always recorded.** Recording is what makes the pass/fail counts
deterministic rather than something you tally by hand, and `report summary` is the source for both
report formats. The `"visual"` choice only decides whether screenshots are captured alongside.

### 0c. Choose foci

A focus is a discipline the run checks on top of the specs, such as accessibility or responsive design. It
leans on what Chromium and mature tools already do (axe-core, device emulation), driven through Playwright
MCP. Each one is a file in `foci/` in this skill's directory. Adding a focus means adding a file.

Ask on **every** run, Create or Run mode, before any test runs. Never carry an answer over from an earlier run
or infer one from `.browser-tests.json`.

1. List `{absolute path to this skill}/foci/*.md`. The `vendor/` directory under it holds no foci. Read each
   file's frontmatter: `name`, `label`, `description`.
2. Ask with one `AskUserQuestion` call, `multiSelect: true`:
   - question: "Run any focus checks too? They replay every scenario after the functional run, so the run takes longer."
   - header: "Foci"
   - first option: label "Nothing extra", description "Functional run only. No replay, no focus checks."
     The UI warns when a multiSelect is submitted with nothing checked, so the operator needs an explicit way
     to say no.
   - then one option per focus: its `label`, with its `description`
   - Nothing starts checked; that is how multiSelect works, and it is the point. A focus runs only when the
     operator checks it.
   - An `AskUserQuestion` question holds at most 4 options, and "Nothing extra" takes one. With more than 3
     foci, put "Nothing extra" and the first 3 in the first question, and the rest in further questions of up
     to 4 in the same call, each with question "More focus checks?" and header "Foci (cont.)".
3. A dismissed question is not an answer. Ask again, once, with the same `AskUserQuestion`. If it is dismissed
   a second time, stop and ask in plain text which foci to run.
   "Nothing extra", nothing checked, or an "Other" answer that names no focus all mean no foci this run. If
   "Nothing extra" is checked along with a focus, run the checked focus and say so in one line: checking a
   focus is the deliberate act.
4. When **any** focus is checked:
   - **Force the Claude runner for the whole run**, whatever `runner` says. Say so in one line if the config
     says `jev`. Focus checks drive Playwright MCP tools that only the Claude runner has, and a flake
     comparison between two different runners would compare the runners, not the app.
   - Keep the chosen files' `name`s. Phase 2d uses them.

### 1. What to test

If we are in "Run" mode and we weren't given the tests to run in $ARGUMENTS, ask the operator now.

If we are in "Create" mode and we weren't given the subject to test in $ARGUMENTS, ask the operator what they want to test. Accept one of:

- **PR diff** — You will run `git diff` to identify changed files and features
- **Feature area** — The operator names a feature (e.g., "reservation calendar", "sign-in flow")
- **Description** — The operator provides a free-text description of what to test

### 2. Initialize directories

Create the following directories at the project root if they don't exist. Per the Bash discipline rules, issue these as **three separate Bash calls** (in parallel, in a single message) — do not combine them into one `mkdir` invocation:

```bash
mkdir -p {directory}/specs
```

```bash
mkdir -p {directory}/results
```

```bash
mkdir -p {directory}/tmp
```

Where `{directory}` comes from `.browser-tests.json`.

**Important**: `{directory}/tmp/` is for temporary files created during test execution (screenshots for verification, dummy test fixtures for upload testing, etc.). Temporary files go nowhere else — only `.md` report files and `.feature` spec files belong in the rest of `{directory}/`.

It sits inside the project on purpose. Playwright MCP servers refuse to write outside their allowed roots: an absolute `/tmp/...` path fails with "File access denied", and runners then work around it by writing into the repo root — exactly what this rule exists to prevent.

It must be gitignored. Check with `git check-ignore -q {directory}/tmp`; if that exits non-zero, append `{directory}/tmp/` to the project's `.gitignore` and tell the operator you did.

Then claim the run number and the run directory, which every later phase refers to:

```bash
bun {absolute path to this skill}/scripts/report.js claim --dir {directory}
```

It prints `{"n": N, "run": "<run dir>"}`. It takes one past the highest number in `{directory}/results/` and
`{directory}/tmp/`, and creates the run directory in the same step, so a second run started on the same branch
gets its own number. Never pick the number by listing `results/` yourself: reports are written at the end of a
run, so two runs started together used to land on the same `run.db`.
That number `{N}` fixes two paths for the rest of this skill:

- `{run dir}` — `{directory}/tmp/run-{N}`, holding `run.db`, the deterministic record of this run
- the report filenames in Phase 3

One `{run dir}` covers the whole run: the Jev pass, the Claude fallback, Phase 2b re-runs, the Phase 2d focus
pass and Phase 4 gap specs all record into the same database, each under its own `--run-id`.

`run.db` is also where the run's live status is read from, by the operator's status band and anything else
watching. Steps record themselves, but the phases between them don't, so you mark each phase as you enter it:

```bash
bun {absolute path to this skill}/scripts/report.js phase --run {run dir} --name {phase}
```

`{phase}` is one of `specs`, `execute`, `repair`, `helpers`, `focus`, `flaky`, `report`, `gaps`, `done`. Each
phase below opens with its own line saying which. The first one creates `run.db`, so it works before `init`.
Mark a phase only when you actually run it; a skipped phase gets no marker.

Then record the pre-run baseline of untracked files — you will diff against it during Cleanup to catch any temp files that leak into the repo:

```bash
git status --porcelain
```

Keep this list in context.

### 3. Gather context

Based on the operator's choice in step 1:

- **The specs to run**: Read from the `{directory}/specs` directory and find the `*.feature` files that match their request
- **PR diff**: Run `git diff main...HEAD --name-only` and `git diff main...HEAD` to understand what changed
- **Feature area**: Use Glob and Grep to find relevant source files, read key files to understand the feature
- **Description**: Use the description to identify relevant source files

Store this context — in Create mode you will use it for spec generation, in Run mode you will pass the spec file list to the execution phase.

---

## Phase 1 — Spec Generation (Create mode only)

If in "Run" mode, skip to Phase 2.

Mark the phase: `report.js phase --run {run dir} --name specs`.

Read `references/gherkin-guide.md` before generating any specs.

Analyze the gathered context and generate Gherkin `.feature` files:

1. Identify all testable behaviors from the context
2. Group tests by category using the directory naming from the guide (sign-in/, navigation/, reservations/, etc.)
3. Write `.feature` files following the step phrasing conventions exactly. Where two phrasings say the same thing, pick the one already in the guide's vocabulary — those are the phrasings the step helpers settle without a model request, and a new spec written in them is fast from its first run. This is free at generation time and it keeps the long tail of one-off phrasings from growing.
4. Save each file directly to `{directory}/specs/{category}/{filename}` — create category directories as needed
5. Think about edge cases: empty states, validation errors, permission boundaries, navigation flows

### Spec generation guidelines

- Aim for 3-8 feature files depending on scope
- Each feature file should have 2-5 scenarios
- Use Background for shared setup within a file
- Keep scenarios under 10 steps
- Use the exact step phrasing patterns from the guide
- Do NOT include CSS selectors or implementation details in steps
- Think from the user's perspective, not the developer's
- **Every feature file must have `testdata:` directives** — Determine what test data each feature needs and add the appropriate `testdata:` lines in the feature description (after the `Feature:` keyword, indented with 2 spaces). Consult the `testdata:` section of the gherkin guide and the furtherSetup file for available commands. Choose the lightest data setup that satisfies the scenarios (e.g., don't use `exemplar default` when `create location` suffices).
- **Every feature must say what a second viewer sees** — when a feature touches a surface where one person's action changes what another person already has on screen, it either carries an `actors:` directive and a scenario that hands the keyboard over, or states in the Feature description why one viewer is the whole story. See "Assume two people are on the page" in the guide. A suite where every scenario has exactly one viewer tests a product nobody runs, and the gap is invisible in a green report.

---

## Phase 2 — Test Execution

Execute the spec files using concurrent subagents with Playwright MCP. When `runner` is `jev`, run the Jev pass first; only the scenarios it leaves over go to the subagents.

Mark the phase: `report.js phase --run {run dir} --name execute`. Only on the first pass. A re-run from Phase
2b or Phase 4 stays under `repair` or `gaps`; its `--run-id` already says it is executing.

### Determine files to run

- **Create mode**: All `.feature` files just written to `{directory}/specs/`
- **Run mode**: Files identified in setup phase
- **Re-run** (from Phase 2b or Phase 4): Only the specific files passed back

### Write the manifest

Before dispatching anything, record what the specs say *should* happen:

```bash
bun {absolute path to this skill}/scripts/report.js init --run {run dir} {the feature files to run}
```

This parses each spec and stores every expected scenario and step, so that a runner which dies
partway through leaves a visible `incomplete` instead of a short, green-looking scenario. It is
safe to re-run: repaired or regenerated specs overwrite their manifest rows, and files from earlier
phases are left alone.

Run it at the top of **every** Phase 2 execution, including Phase 2b re-runs and Phase 4 gap specs,
with the files about to run.

Pick a `{run-id}` for this dispatch — a short label naming the pass, unique within the run:
`jev-1`, `claude-1`, `repair-1`, `gap-1`. Every record from this dispatch carries it, and a later
pass over the same scenario supersedes an earlier one rather than stacking on top of it. The
runners never invent this; you hand it to them.

### Process testdata directives

Before dispatching feature files to runners, check each file for `testdata:` directives. These are lines starting with `testdata:` (with leading whitespace) in the feature description block (between the `Feature:` line and the first `Background:` or `Scenario:`).

If any `testdata:` lines are found:

1. **Consult the furtherSetup file** for instructions on how to execute testdata commands. The furtherSetup file (from `.browser-tests.json`) contains project-specific details: what tool to run, how to invoke it, and where it executes (e.g., inside a container).
2. **Execute each `testdata:` line in order** using the Bash tool, following the instructions from the furtherSetup file. Each line's content (after the `testdata: ` prefix, trimmed) is the command arguments.

   **Strictly one testdata command per Bash call.** Do not batch them with `&&`, do not loop with `for`, do not write a Python/Bun/Node helper that runs them all, and do not pipe one's output into the next. The operator allowlists the testdata tool by its verb (e.g. `Bash(<your-testdata-tool>:*)`); chaining or scripting around it forces a permission prompt and stalls the run. If two testdata lines have no dependency on each other, you may issue them as parallel Bash calls in a single message — but each one is still its own call.
3. **Capture the JSON output** from each command's stdout.
4. **Build a variable scope** from the JSON output. Top-level keys from each command's JSON become `$key_name` variables. When a later `testdata:` line references `$variable`, **you (Claude) substitute the literal value into the command string before issuing the Bash call.** Do not rely on shell expansion — the call should contain the resolved value, not a `$`-prefixed token.
5. **Build a human-readable testdata context block** for the runner. For each testdata command that was executed, summarize its output in plain language that helps the runner interpret generic steps. Label each entity with its role or purpose, and include credentials where applicable. For example:

   ```
   TEST DATA (created by testdata directives before this feature):

   Command: create location "Test Camp" --with-admin
   - Location name: "Test Camp" (id: abc-123, slug: test-camp)
   - Admin manager: admin-1711234567-1234@test.local, password: "password"

   Command: create guest
   - Guest account: guest-1711234568-5678@test.local, password: "password"
   ```

   The runner uses this context to resolve generic references in steps. For example, when a step says "the admin manager email" or "the guest email", the runner looks up the corresponding value from this block. When a step says "I am signed in as the admin manager", the runner uses the email and password from here.

If a testdata command fails (non-zero exit), stop processing that feature file, report the error, and skip it.

If no `testdata:` lines are present, proceed normally.

### Read the `actors:` directive

A feature file may carry one `actors:` line in the same description block as `testdata:`, naming the people in the scenarios in order — `actors: Dana, Sam`. It is not a testdata command and nothing is executed for it; it says how many browsers that file needs and what each one is called.

A file with an `actors:` line:

- takes **one Playwright instance per actor it names**, which changes how Phase 2 batches it (below),
- skips the Jev runner (above),
- gets `{actors}` in its dispatch, pairing each name with its instance's prefix in the order the directive lists them.

A file with no `actors:` line behaves exactly as it always has: one instance, and `{actors}` is `(none)`.

### Jev pass (when `runner` is `jev`)

Skip this section when `runner` is `claude` or unset, or when the operator chose any focus in Setup step 0c.

Skip it as well for any **individual feature file carrying an `actors:` directive**, whatever `runner` says, and say so in one line. `jev-run.js` drives one browser and has no notion of a second actor, so those files go straight to the Claude runner below. The rest of the run still goes through Jev.

1. **Write the inputs.** Use the Write tool, not the shell.
   - Once per run, when `jev.routes` is set, write `jev.routes` to `{directory}/tmp/jev/routes.json`.
   - For each feature file, write `{directory}/tmp/jev/{feature-slug}.values.json`. It holds `jev.values` merged with the top-level keys of that feature's testdata JSON output. Where both define a key, the testdata output wins.
2. **Run the Jev runner, one Bash call per feature file, up to 4 in parallel per message:**

   ```bash
   bun --env-file={jev.envFile} {absolute path to this skill}/scripts/jev-run.js {file path} --base-url {base URL} --values @{values file} --routes @{routes file} --helpers {directory}/playwright-helpers.js --artifacts {directory}/tmp/jev --report-run {run dir} --report-id {run-id}
   ```

   - When `jev.envFile` is unset, drop `--env-file=…`. The key then comes from `TYPESAFE_API_KEY` in the environment.
   - When there are no routes, drop `--routes`.
   - When `{directory}/playwright-helpers.js` does not exist, drop `--helpers`. The generic helpers still apply; only the project's own are missing.
   - Add `--report-shots` when `reports` includes `"visual"`. Jev screenshots straight to memory, so
     this costs it a few milliseconds per step and no tokens.
   - If the runner exits with `TYPESAFE_API_KEY is not set.`, stop. Tell the operator to export the key or set `jev.envFile`.
3. **Sort each scenario in the JSON it prints** (`features[0].scenarios[]`):
   - **Final:** `status` is `passed` and `escalate` is `false`. Record it with `runner: "jev"`.
   - **Leftover:** everything else, meaning failed or `escalate: true`. Keep Jev's `failure_reason` as `jev_reason` for Phase 2b.

   Jev's passes are trustworthy: when tested against a real app, every Jev pass that Claude re-checked got the same verdict from Claude. Its failures are not: about a third of the ones Claude re-checked were wrong. A failing step is often a spec that is ambiguous or out of date, and Claude can interpret that where Jev can't.
4. **Run each feature's leftovers through the Claude runner below,** with `{scenarios}` set to the leftover scenario names.
   - Run the feature's `testdata:` directives again first, so the Claude runner starts from fresh data rather than whatever the Jev pass changed.
   - Features with no leftovers skip the Claude runner entirely.
5. **Merge the results.** A Claude result replaces the Jev result for the same scenario and is recorded with `runner: "claude"`.
   - Jev's own `difficulties` are tuning notes, not spec feedback. Leave them out of the report.
   - Jev's decision log and failure screenshots stay under `{directory}/tmp/jev/`.

### Concurrent execution via subagents

There are 3 Playwright MCP server instances available, whose tool prefixes you recorded in the Prerequisites. Execute feature files concurrently by spawning one `Agent` subagent per feature file.

1. Batch the files so that each batch uses at most 3 instances. A file with an `actors:` directive needs one instance per actor it names; every other file needs one. So three single-actor files fill a batch, and so do one two-actor file and one single-actor file.
2. For each batch, spawn one `Agent` subagent per **feature file** — not per instance — **concurrently** (in a single message with multiple tool calls)
3. Hand each subagent its own instances, taking prefixes in the order you recorded them and never giving the same prefix to two subagents in one batch. A single-actor file gets one. A two-actor file gets two, paired with its actor names in the order `actors:` lists them.
4. **Write the runner instructions once per pass**, before the first batch, not into every dispatch:

   ```bash
   bun {absolute path to this skill}/scripts/report.js runner --run {run dir} --pass functional --config .browser-tests.json --shots
   ```

   Pass `--shots` only when `reports` includes `"visual"`. It writes `{run dir}/runner-functional.md`, used here
   and by the Phase 2b re-runs and Phase 4, and prints its absolute path as `file`. Phase 2d writes
   `runner-focus.md` the same way. The command fills in everything every runner in the pass shares: the base
   URL, `directory`, the `furtherSetup` file, `verificationTools`, the screenshot instructions
   (`references/screenshot-instructions.md`), and in the focus pass the focus checks. It leaves the per-runner
   placeholders in braces: `{file path}`, `{playwright tool prefix}`, `{scenarios}`, `{testdata context}`,
   `{helper context}`, `{report command}` and `{finding command}`. `unfilled` in its output should be empty.

   Don't write this file yourself. Agents in one message only start once the whole message is written, and
   pasting the template into each of three prompts kept agents from starting for minutes. Copying it through a
   Write call is the same wait once per pass, plus the chance of mangling the template on the way.

5. **Dispatch each runner with a short prompt.** Assign each subagent a distinct instance (the 1st, 2nd and
   3rd tool prefix you recorded) and send only this, filled in:

   ```
   You are a browser test runner. Before doing anything else, read {absolute path of the runner file} in full
   with the Read tool, and follow it. Wherever it has one of the placeholders below in braces, use this
   runner's value:

   - {file path}: <the feature file to execute>
   - {playwright tool prefix}: <the assigned instance's full tool prefix, including the trailing __>
   - {actors}: <see below, or "(none)">
   - {report command}: <see below>
   - {helper context}: <see below>
   - {scenarios}: <see below, or "(empty: run every scenario)">
   - {testdata context}: <see below, or "(none)">
   - {finding command}: <focus pass only, see Phase 2d>
   ```

   The per-runner values:
   - `{playwright tool prefix}` — e.g. `mcp__plugin_testing_playwright-1__`. For a file with `actors:`, this is the **first** actor's instance; the runner reads the rest from `{actors}`.
   - `{actors}` — for a file with an `actors:` directive, one line per actor pairing its name with its instance's full prefix, in the order the directive lists them, e.g. `Dana = mcp__plugin_testing_playwright-1__` then `Sam = mcp__plugin_testing_playwright-2__`. Otherwise `(none)`.
   - `{testdata context}` — if this file had `testdata:` directives, the resolved data (IDs, credentials, etc.) as a "TEST DATA" block the runner can reference when interpreting steps. Otherwise "(none)".
   - `{helper context}` — a JSON object literal the runner pastes into its `page.__runStep` calls: `{"root": "<project root>", "base": "<base URL>", "values": {<this feature's resolved testdata, flattened>}}`. Use the values from the testdata pass that ran **for this dispatch** — on a Jev run the testdata was re-run before the fallback, so the Jev pass's values are stale and would point the runner at records that no longer exist. With no testdata, `{"root": "<project root>", "base": "<base URL>", "values": {}}`. `root` is the absolute path of the directory holding `.browser-tests.json`: each runner gets a fresh tab, and the bridge in that tab finds the project's helpers from the server's working directory, which isn't always the project.
   - `{scenarios}` — in a Jev run, the leftover scenario names from that file, one bullet each. Otherwise empty, which runs every scenario.
   - `{report command}` — the record command with everything the runner doesn't vary already baked in:

     ```
     bun {absolute path to this skill}/scripts/report.js record --run {run dir} --run-id {run-id} --feature {file path}
     ```

     The runner appends `--scenario`, `--step`, `--status`, `--lane` and (on failure) `--reason`. Keeping the
     paths out of the runner's hands is what stops it from inventing them.

   Spawn the batch's subagents in one message, so they run concurrently.
6. Wait for all subagents in the batch to complete before starting the next batch
7. Collect JSON results from all subagents

### Result assembly

After all subagents complete, get the authoritative results from the database — do **not** tally
them yourself from the subagents' JSON:

```bash
bun {absolute path to this skill}/scripts/report.js summary --run {run dir}
```

This returns per-scenario verdicts and `totals` (`total`, `passed`, `failed`, `incomplete`,
`not_run`, `pass_rate`, `settled_by`). Those numbers are reconciled against the manifest, so they
account for scenarios a runner never finished. Use them everywhere a count is needed. The only
figure not in there is the Jev cost, which is still the sum of each Jev runner's `jev.cost_usd`.

It omits the per-step arrays by default, since everything you act on — `failed_step`,
`failure_reason`, `recorded_steps` vs `expected_steps`, `drifted_steps` — is on the scenario. Add
`--steps` only if you need step-level detail; it makes the output about 4.5x bigger.

A scenario's verdict is derived, never reported by a runner:

| Verdict | Meaning |
|---|---|
| `passed` | every step in the spec has a record, and all of them passed |
| `failed` | some step recorded a failure |
| `incomplete` | records stop partway with no failure — the runner died, timed out, or lost track |
| `not_run` | the runner never reached this scenario at all |

`incomplete` and `not_run` are **not passes**. Treat them as needing attention.

Still collect from the subagents' JSON the things the database does not hold: `difficulties` and
`interpretations`, each with `feature_file` added.

The summary also lists `inconsistent` scenarios: ones where two attempts at the same spec got different
verdicts. Phase 2e deals with them; nothing here does.

If there are **any** failures, `incomplete` or `not_run` scenarios, or any `interpretations` or Jev
leftovers to clarify, proceed to Phase 2b. Otherwise continue with Phases 2c, 2d and 2e in order. Each one opens by saying when it applies; skip any that doesn't. Then Phase 3.

---

## Phase 2b — Spec Repair

Mark the phase: `report.js phase --run {run dir} --name repair`.

### Repair analysis

For each failed scenario:

1. Read the original `.feature` file from `{directory}/specs/{category}/{filename}`
2. **Look at the screenshot of the failing step.** It is a PNG on disk and the `Read` tool displays
   it. Do this before reading any source — the picture usually settles which of the three causes
   below it is in one look, and reading source first to explain a failure the screenshot explains
   immediately is the most common way this phase wastes time.
   - Jev failures: `{artifacts}/<scenario name with every run of non-alphanumerics replaced by a
     hyphen>.png`, where `{artifacts}` is the `artifacts` path in that runner's JSON output. Written
     for every failed scenario whether or not reports include `"visual"`.
   - Claude failures: `{run dir}/shots/<slug>-<n>.png`, the file the runner passed to
     `--screenshot`. Present whenever reports include `"visual"`, which is the default.

   What it tells you, from real runs: a page that is an unbuilt placeholder, an error page, or a
   sign-in form you did not expect means the step never reached the page the spec is about, and the
   assertion that "failed" was never really evaluated. An expected string genuinely absent from a
   page that is otherwise correct is a stale spec. A half-rendered page points at timing.
3. Read the relevant source code to understand the current application behavior — guided by what the
   screenshot showed, not instead of it.
4. Determine the cause:
   - **STALE SPEC**: The application behavior changed legitimately and the spec needs updating
   - **POSSIBLE BUG**: The application behavior seems wrong — the spec's expectation looks correct
   - **ENVIRONMENT ISSUE**: Timing, missing data, or test environment problems

### Scenarios that did not finish

Work `incomplete` and `not_run` scenarios here too. The summary says exactly where each one
stopped, and the step it stopped on is the evidence:

- **A step that hangs the app** — the last recorded step is the one before a page that never
  settled. This is the common case and usually a real bug worth reporting, not a spec problem. Its
  screenshot is worth a look for the same reason as above: a half-rendered page, a spinner, or an
  error says which.
- **A runner that ran out of room** — a long scenario under the Claude runner. Splitting the
  scenario is the fix.
- **A whole feature that is `not_run`** — the subagent failed before starting. Re-dispatch that
  file before concluding anything about it.

Do not repair the spec of an `incomplete` scenario on the strength of a guess about what the
un-run steps would have done. Re-run it first. A scenario that completes on the second attempt shows up
as `inconsistent` in the summary, and Phase 2e decides whether it is flaky.

### Background failures

The summary's `background_failures` groups scenarios that died on the same `Background` step. Treat
each group as **one** investigation, not one per scenario — a shared setup step breaking takes down
every scenario in the feature, and reading the source five times for the same root cause wastes the
run.

For each **STALE SPEC**:
- Update the file in-place at `{directory}/specs/{category}/{filename}`
- Record what changed and why (original expectation, new expectation, evidence from source code)

For each **POSSIBLE BUG**:
- Do NOT update the spec
- Collect for operator presentation

For **ENVIRONMENT ISSUES**: Note them but take no action.

### Clarify specs for the Jev runner

Do this on every run, whichever runner ran. Claude runs clarified specs the same way, and Jev can then settle them without falling back to Claude.

Look at every scenario that either:
- reported `interpretations` (Claude had to decide what the spec meant), or
- was a Jev leftover whose `jev_reason` points at the spec rather than the app, such as `BLOCKED` on a vague step, a value it had no candidate for, or a repeated action.

For each one, make explicit in the `.feature` file what the runner had to work out:
- **Values:** replace a described value with the concrete, quoted value the runner used.
  - `with valid credentials` becomes separate steps with the quoted email and password of the seeded account from `furtherSetup`.
  - For an input meant to be invalid, quote an invalid value, e.g. `"nobody@example.com"` and `"wrong-password"`.
  - Leave a reference to `testdata:` output alone (`the test identity email`, `the listed address`). Its value
    is new on every run, so quoting this run's value would break the next one. If the runner resolved it
    unaided, nothing needs clarifying. If it needed a model request to resolve it, note the step as a Phase 2c
    helper candidate instead.
- **Elements:** name them by their current accessible name, quoted. `When I click the search box` becomes `When I click the "Search the v7 Icons" field`.
  - If the element no longer exists (the UI changed), that is a STALE SPEC, not a clarification.
- **Compound steps:** split them so each step is one action. `Given I am on the "Sign In" page and enter invalid credentials` becomes two or more steps.
- **Deep links:** quote the path for a page with no obvious name, e.g. `Given I am on the "/search?q=coffee" page`.
- **Implicit submits:** make them explicit. When a field only takes effect on submit, add `And I press the "Enter" key` after filling it.
- **Phrasing:** use the phrasings the Jev runner checks in code when they mean the same thing: `I should see "X"`, `I should not see "X"`, `the URL should contain "X"`, `the page title should be "X"`, `the "X" button should be enabled` / `disabled`, `the "X" checkbox should be checked` / `unchecked`, `I wait for N seconds`, `I scroll to the "X" section`. These are settled by code with no Jev request, and they work mid-scenario as an `And` after a `When`, not only as a `Then`.

A clarification must not change what the scenario tests:
- No removed or loosened assertions.
- No accounts or data other than what the runner actually used.
- No new expectations.

Record each clarification the same way as a repair, labeled `clarification`.

### Independent audit

After completing all repairs and clarifications, spawn a single `Agent` subagent to audit your changes. Read `references/auditor-prompt.md` and substitute the `{repairs}` template variable with the list of changes you made. For each change, include:
- The spec file path (original location)
- The scenario name
- Whether it is a `repair` or a `clarification`
- What you changed and why
- The source code evidence you cited, or for a clarification, the runner interpretation or Jev reason it came from
- The path to the failing step's screenshot, if there is one. Hand over the path, not your reading of it — the auditor looking at the same page and disagreeing with you is the entire point of the audit, and a page that turns out to be an error or placeholder is how a repair you called legitimate gets caught as a real bug

Wait for the auditor's JSON findings before proceeding.

### Operator decision point

After receiving audit findings:

1. **If the auditor found suspected bugs or needs-operator-input items**: Present them to the operator:

> The spec repairs were audited and {M} potential issues were flagged:
>
> {For each suspected_bug or needs_operator_input finding, show the scenario, the repair, and the auditor's reasoning}
>
> For each flagged item, would you like to:
> a) **Accept the update** — the behavior change is intentional
> b) **Keep the original spec** — this is a bug that should be fixed
> c) **Skip this scenario** — remove it from testing for now

2. **If you found possible bugs during repair**: Present them to the operator:

> {N} scenarios appear to be application bugs rather than stale specs:
>
> {For each possible bug, show the scenario, expected vs. actual behavior, and evidence}
>
> These specs were NOT updated. Would you like to:
> a) **Continue testing** — proceed with remaining passing specs and repaired specs
> b) **Stop here** — investigate the bugs before continuing

3. **After operator decisions**:
   - For accepted repairs: Files are already updated
   - For rejected repairs (keep original): Revert the spec file to its original content
   - Re-run ONLY the repaired spec files through Phase 2 to verify the fixes work
   - In a Jev run, re-run files that were only clarified through the Jev runner alone, with no Claude fallback: Claude already gave their verdicts this run. Report how many of their scenarios Jev now settles.
   - After the re-run, continue with Phases 2c, 2d and 2e in order. Each one opens by saying when it applies; skip any that doesn't. Then Phase 3.

If there were **no suspected bugs** from either the repair analysis or the auditor and all repairs were legitimate, re-run the repaired specs through Phase 2 (and clarified-only files through the Jev runner alone, as above), then continue with Phases 2c, 2d and 2e in order. Each one opens by saying when it applies; skip any that doesn't. Then Phase 3.

---

## Phase 2c — Grow the step helpers

Only when the run is otherwise settled: no `failed`, `incomplete` or `not_run` scenarios left. A helper written
against a broken page bakes in the breakage.

Mark the phase: `report.js phase --run {run dir} --name helpers`.

`{directory}/playwright-helpers.js` maps step phrasings to Playwright code. Both runners load it — the Jev
runner through `--helpers`, the Claude runner through `page.__runStep` — so a helper added here stops costing
a model request in either. It grows from what the run actually spent requests on, never from guesswork.

1. **Find what still costs a request.** From `report summary --steps`, take the steps recorded with
   `lane: "model"`, normalize each (replace quoted values with `"X"`, digits with `N`), and count them. Show
   the operator the top ones with their counts, most frequent first, and the current `model_free_rate`:

   ```
   Run 7: 62% of steps ran without a model request.
   The 5 phrasings that cost the most, out of 812 model steps:

     39  I am signed in as the admin for the exemplar
     29  I increase the "X" stepper by one step
     25  I am on the guest-info page for the seeded reservation request
     23  I am on the reservation page for "X" with check-in "X" and check-out "X"
     22  I add the icon "X" to the composition

   Write helpers for these? (all / a subset / none)
   ```

   Offer at most 10. A phrasing used once is not worth a helper; leave it to the model.

   **Rank by how many model requests a phrasing costs, not just how often it appears.** A `Given` that
   describes a situation to reach — signing in, landing on a seeded record — is one step that the model spends
   a whole action loop on, several requests deep. A single `When I click …` is one step and one request. Measured
   on a real suite: the generic table alone took model requests from 300 to 118 and barely moved wall clock,
   because the model's sign-in chain still gated the slowest workers. Adding **one** helper for that chain took
   requests to 47 and wall clock down 31%. A multi-step `Given` is worth more than its step count suggests, and
   is the first helper to write.

2. **Write them**, appending to `{directory}/playwright-helpers.js` (create it if absent — see
   `references/setup.md` for the shape). For each accepted phrasing, base the body on what the runner actually
   did this run: the Jev `decisions.jsonl` records every action it chose, and a Claude runner's transcript shows
   the tools it called. Do not invent a route or a label you did not see work.

   Two rules, both of which produce a helper that passes today and lies tomorrow when broken:

   - **Never hardcode a value that came from `testdata:`.** IDs, emails and slugs differ every run. Read them
     from `ctx.values`. Before re-running, check each new body for a digit run or an email that also appears in
     this run's testdata JSON; if one is there, rewrite it to read `ctx.values` instead.
   - **Write the regex loose.** Prefer `(?:a|the)`, `(?:button|link|control)` and similar alternations over the
     exact phrasing you saw. Measured across the spec corpus, wording drift is a few percent of phrasings, and
     absorbing it in the regex costs nothing — rewriting specs to match a strict regex is churn and an auditor
     round trip for no change in behavior.

3. **Verify by re-running.** Re-run only the scenarios that use those phrasings, through Phase 2, under a fresh
   `{run-id}` (a later `run_id` supersedes the earlier attempt for those scenarios, so the report stays right).

   - All green → keep the helpers. Report the new `model_free_rate` against the old one.
   - Any scenario that did not pass → **remove that helper** and say which one and why. A helper is an
     optimization; one that changes a verdict is a bug, and there is no version of this worth a wrong result.

   This verification is the whole point of the phase. An earlier attempt at this idea generated Playwright for
   every feature file and never ran any of it in the session that wrote it — every artifact was a guess, and it
   was reverted the same day. Ten helpers you re-ran are worth more than three hundred you did not.

   One caution on reading the re-run. A suite driven by a model has a verdict noise floor: on a real 44-scenario
   suite, consecutive runs with no code change between them moved about three verdicts in each direction, all on
   model-lane steps. So a single scenario flipping is not evidence about the helper. Before blaming one, check
   the lane of the step that actually failed — if it is `model` or `literal`, the helper was not involved.

---

## Phase 2d — Focus pass

Only when the operator chose at least one focus in Setup step 0c. It runs after Phase 2b and 2c, so it
replays the specs as they ended up after repair.

Mark the phase: `report.js phase --run {run dir} --name focus`.

The pass replays **every** scenario, start to finish, with the chosen foci checked at each transition. It
does two jobs at once: the focus findings, and a second, independent attempt at every scenario with fresh
test data, which is what Phase 2e reads to find flaky ones.

1. **Pick the run-id** `focus-1`. A re-dispatch of a feature that failed to start takes `focus-2`, and so on.
2. **Make the focus directory** where runners write axe results and screenshots:

   ```bash
   mkdir -p {run dir}/focus
   ```

3. **Run the testdata again.** Process every feature's `testdata:` directives exactly as in Phase 2, fresh.
   The functional pass changed the data its scenarios touched. The focus pass starts from new data, as the
   Jev fallback does.
4. **Write the focus pass's runner file** with the chosen foci's `name`s, in the order the operator's answer
   listed them:

   ```bash
   bun {absolute path to this skill}/scripts/report.js runner --run {run dir} --pass focus --config .browser-tests.json --foci {names, comma-separated}
   ```

   It leaves the screenshot instructions out (the focus pass screenshots failed steps only, and
   `references/focus-pass.md` says how). It puts in `references/focus-pass.md` followed by each focus file's
   body, with `{focus dir}` (the absolute path of `{run dir}/focus`, which it creates) and `{axe path}` filled in.

5. **Dispatch** exactly as in "Concurrent execution via subagents", one subagent per feature file, every
   scenario (`{scenarios}` empty), pointing at `runner-focus.md`, with these per-runner values:
   - `{report command}` — the record command with the focus pass marked:

     ```
     bun {absolute path to this skill}/scripts/report.js record --run {run dir} --run-id {run-id} --pass focus --feature {file path}
     ```

   - `{finding command}` — the finding command with everything the runner doesn't vary baked in:

     ```
     bun {absolute path to this skill}/scripts/report.js finding --run {run dir} --run-id {run-id} --feature {file path}
     ```

6. **Collect** the subagents' `difficulties`, labeled as focus pass. A difficulty about a focus check is about
   the focus file, not the spec. Keep those apart from spec difficulties in the report.

Findings never change a verdict, and the focus pass's step records never do either: `report summary` takes
verdicts from functional attempts only.

---

## Phase 2e — Flaky review

Run this whenever `report summary` lists `inconsistent` scenarios with `flaky: null`. That happens after a
Phase 2d focus pass, and also after a Phase 2b or 2c re-run that came out differently with the same spec.

Mark the phase: `report.js phase --run {run dir} --name flaky`.

An inconsistent scenario is one where two attempts at the same spec, by the same runner, got different
verdicts. `report summary` already leaves out the disagreements that are expected: an attempt on step text
the spec no longer has (it was repaired in between), and a Jev leftover that Claude then passed.

Flaky is a call, not arithmetic. It flags a scenario for a person or agent to spend time on, so be reasonably
sure something is off before setting it. It is a signal, never a gate: a flaky scenario keeps its functional
verdict.

For each one:

1. **Look at both attempts.** Every entry carries its `attempts`, each with its `pass`, `verdict`,
   `failed_step` and `failure_reason`. Read the failing attempt's screenshot:
   - functional pass: `{run dir}/shots/<slug>-<n>.png`
   - focus pass: `{run dir}/focus/<slug>-<n>.png`

   Compare it with the same step in the attempt that passed. Don't re-run to break the tie.
2. **Decide**, and record it:

   | What you found | Verdict |
   |---|---|
   | A cause you found and fixed (a testdata collision, a missing wait, a helper Phase 2c removed) | `--flaky false`, with the cause as the reason |
   | A focus check left the page in another state (still emulated, focus moved) | `--flaky false`, with "focus check side effect: …" as the reason. Note it as a difficulty: the focus file has a bug |
   | Anything else: you don't know why, or you know why and didn't fix it (environment, timing in the app) | `--flaky true`, with whatever you do know as the reason |

   ```bash
   bun {absolute path to this skill}/scripts/report.js flag --run {run dir} --feature {file path} --scenario '<scenario>' --flaky true --reason '<why>'
   ```

   One `flag` per Bash call. Single-quote `--scenario` and `--reason`.

A model-driven runner has a verdict noise floor (see Phase 2c): a few flips per run with no code change are
normal. That doesn't make them not flaky. Unexplained is flaky. It does mean one flip isn't evidence about the
app on its own. Say what you saw, not more.

---

## Phase 3 — Reporting

Mark the phase: `report.js phase --run {run dir} --name report`.

Produce whichever reports the operator chose in Setup step 0b. Run `report summary` first and take
every count from it — the totals in both formats must come from the same reconciled source.

### Markdown (when `reports` includes `"markdown"`)

Read `references/report-template.md` and create (or update) the test report following that format.

- Create the report at `{directory}/results/{YYYY-MM-DD}-run-{N}.md`, using the `{N}` fixed in Setup
- For subsequent runs (repair re-runs, gap specs), append to the same report file and update the cumulative summary
- Give `incomplete` and `not_run` scenarios their own section. They are not failures and not passes,
  and a table that only has ✅/❌/⏭️ columns will quietly misfile them
- Flaky scenarios and focus findings get their own sections. Take the findings from `report summary --steps`:
  the default summary trims each finding to its first three occurrences

### Visual (when `reports` includes `"visual"`)

```bash
bun {absolute path to this skill}/scripts/report.js build --run {run dir} --out {directory}/results/{YYYY-MM-DD}-run-{N}.html
```

One self-contained HTML file with every screenshot embedded — nothing beside it to copy around, and
clicking a frame opens it at full resolution. Re-run this after any Phase 2b re-run or Phase 4 gap
cycle; it rebuilds from the database, so it always reflects the whole run.

The command prints the byte size. Mention it to the operator if it is over ~20MB, and offer to gzip
it — `gzip -9` recovers essentially all of the base64 overhead.

---

## Phase 4 — Gap Analysis

Mark the phase: `report.js phase --run {run dir} --name gaps`.

Analyze the test results and existing specs to identify testing gaps:

1. Review all results — which behaviors are covered, which are missing?
2. Identify gaps in these priority categories:
   - **Error paths** — network errors, permission denied, session timeout, validation failures
   - **Edge cases** — empty states, boundary values, special characters, long inputs
   - **Related features** — if testing sign-in, what about sign-out? password reset?
   - **Interaction patterns** — keyboard navigation, mobile viewport, rapid actions
   - **Concurrent sessions** — a second person on the same page: who wins a race, what the loser is told, and what a page owes someone whose data changed underneath them
3. Write up to 4 new `.feature` files directly to `{directory}/specs/{category}/`
4. Follow the same guidelines from Phase 1

### Optional execution

Present gaps to the operator:

> Identified {N} testing gaps and created {M} new spec files:
>
> {For each gap, show category, description, and spec file}
>
> Would you like to run these additional specs? (Maximum 2 gap analysis cycles)

If **yes**:
1. Execute the new spec files through Phase 2
2. Append results to the existing report (Phase 3)
3. If this is cycle 1 of max 2, repeat Phase 4

If **no**: Proceed to presentation.

Track the cycle count. Do not allow more than 2 gap analysis cycles total.

---

## Presentation

After all phases complete, present the final summary to the operator:

```
## QA Browser Test Summary

### Results
{All of these come from `report summary` — do not recount them.}
- **Total Scenarios**: {total}
- **Passed**: {passed} ✅
- **Failed**: {failed} ❌
- **Did not finish**: {incomplete + not_run} ⚠️  {omit this line when both are 0}
- **Pass Rate**: {pass_rate}%
- **Flaky**: {flaky} — omit when 0. Name them, with each reason
{When a focus ran, one line per focus, from `findings.by_focus`:}
- **{Focus}**: {critical} critical · {serious} serious · {moderate} moderate · {minor} minor
{In a Jev run, add:}
- **Settled by Jev**: {n} · **Re-run by Claude**: {m} · **Jev cost**: ${cost}
- **Ran without a model request**: {model_free_rate}% of steps ({steps_by_lane}) — omit this line when `model_free_rate` is null, which means no runner reported a lane
- **Clarified for Jev**: {k} scenarios, of which Jev now settles {j}

### Files
- Specs: `{directory}/specs/` ({N} feature files across {M} categories)
- Report: `{directory}/results/{report filename}`
{When a visual report was built:}
- Visual report: `{directory}/results/{YYYY-MM-DD}-run-{N}.html` ({size}, {n} screenshots)

### Gap Analysis
{Summary of gaps identified and new specs created}

### Difficulties
{If any difficulties were reported, summarize them here:}
- **{N} friction points** encountered during execution
- Top suggestions: {list the most impactful suggestions from difficulties}
- See the full report for details

{If no difficulties were reported, omit this section.}

### Readiness Assessment
{Based on pass rate and gap analysis, provide one of:}
- **Ready for release** — All scenarios pass, good coverage, no critical gaps
- **Needs attention** — Some failures that should be investigated before release
- **Not ready** — Significant failures or critical gaps in test coverage

A run with any `incomplete` or `not_run` scenarios is never "Ready for release", however high the
pass rate looks. You do not know what those scenarios would have done.
```

---

## Final Validation

After all phases are complete and the Presentation has been shown, validate every spec file in `{directory}/specs/` using the validation script:

```bash
bun {absolute path to this skill}/scripts/validate.js {directory}/specs
```

- If any files fail validation, read the file, fix common issues (missing Feature keyword, malformed tables, indentation), and re-validate.
- Only fix parsing errors — do not change test logic.
- Report any files that could not be fixed to the operator.

---

## Cleanup

After Final Validation, verify no temporary files from this run leaked into the repository:

1. Run `git status --porcelain` and compare against the baseline captured during Setup step 2.
2. Any **new** untracked file that is not under `{directory}/` is a stray test artifact (runner screenshots, test fixtures). Delete each one with its own `rm` call, per the Bash discipline rules.
3. Files under `{directory}/` (specs, results) are expected outputs — leave them alone. If a new file outside `{directory}/` doesn't look like a test artifact (not a screenshot/fixture, or you can't explain where it came from), ask the operator instead of deleting it.
4. Tell the operator what was removed, if anything.
5. Mark the run finished: `report.js phase --run {run dir} --name done`. Without it, a finished run and an
   abandoned one look the same to anything reading `run.db`.

---

## Error Handling

- If no specs are generated in Phase 1: Ask the operator for more context about what to test
- If all specs fail validation: Check the guide reference path and report the issue to the operator
- If a subagent fails to return results: Report the failure to the operator and offer to retry that feature file individually
- If all scenarios fail: Check if the base URL is accessible, credentials are correct, and the application is in the expected state
- If the application is not accessible: Verify the base URL from `.browser-tests.json` and ask the operator to confirm the application is running
