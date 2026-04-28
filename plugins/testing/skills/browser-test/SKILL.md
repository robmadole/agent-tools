---
name: browser-test
description: "Orchestrate QA browser testing via Gherkin specs and Playwright."
version: 2.0.0
---

# Browser Test — QA Testing with Gherkin Specs

You orchestrate a multi-phase QA browser testing workflow. You generate Gherkin specs from code changes, execute them against a running application via Playwright MCP tools, and produce a comprehensive test report.

You perform all roles directly — spec generation, reporting, gap analysis — and use **subagents only for concurrent test execution** (up to 3 Playwright instances in parallel).

## Modes of operation

Determine from $ARGUMENTS what mode of operation we'll be in. If you cannot deduce this ask the user directly: "Would you like to create or run existing tests?"

### "Create"

The operator is asking you to generate new Gherkin specs by analyzing a PR, a feature area, or description — then execute them.

### "Run"

The operator is asking to run tests that already exist in the `.browser-tests.json` `directory` attribute.

## Prerequisites

Before proceeding, verify all of the following. If any check fails, stop immediately with the corresponding message.

1. **Playwright MCP** — Verify that Playwright MCP tools are available by checking that tools prefixed with `mcp__playwright-1__`, `mcp__playwright-2__`, and `mcp__playwright-3__` exist. All three instances must be present.

   > This skill requires 3 Playwright MCP server instances (playwright-1, playwright-2, playwright-3) configured in `.mcp.json`. Ensure the `@playwright/mcp` package is available and all three servers are running.

2. **Bun** — Verify that `bun` is available by running `bun --version`.

   > This skill requires Bun to run the validation script. Install it from https://bun.sh before running `/browser-test`.

3. **`@playwright/test`** — Verify it resolves by running `bunx playwright --version`. This is required for the **scripted-test cache** (a fast path that runs `@playwright/test` files directly instead of dispatching an LLM subagent — see Phase 2).

   > If `@playwright/test` is not installed, **do not hard-fail**. Warn the operator that scripted-mode optimization is unavailable and that the run will use agentic execution for everything. Skip the script-generation offer at the end of the run. Continue otherwise.

4. **Agent tool** — Verify that the `Agent` tool is available (used for concurrent test execution and audit subagents).

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

If it exists, load `directory`, `baseURL`, and `furtherSetup` from it.

If `furtherSetup` is set, read that file (it is a path relative to the repository root). This provides project-specific testing context (test credentials, seed data, application quirks) that should be substituted into the runner subagent prompt and referenced during spec generation.

### 1. What to test

If we are in "Run" mode and we weren't given the tests to run in $ARGUMENTS, ask the operator now.

If we are in "Create" mode and we weren't given the subject to test in $ARGUMENTS, ask the operator what they want to test. Accept one of:

- **PR diff** — You will run `git diff` to identify changed files and features
- **Feature area** — The operator names a feature (e.g., "reservation calendar", "sign-in flow")
- **Description** — The operator provides a free-text description of what to test

### 2. Initialize directories

Create the following directories at the project root if they don't exist. Per the Bash discipline rules, issue these as **four separate Bash calls** (in parallel, in a single message) — do not combine them into one `mkdir` invocation:

```bash
mkdir -p {directory}/specs
```

```bash
mkdir -p {directory}/tests
```

```bash
mkdir -p {directory}/results
```

```bash
mkdir -p /tmp/browser-tests
```

Where `{directory}` comes from `.browser-tests.json`. The `tests/` directory mirrors `specs/` and holds the optional `@playwright/test` script cache (see Phase 2).

**Important**: The `/tmp/browser-tests/` directory is for temporary files created during test execution (screenshots for verification, dummy test fixtures for upload testing, etc.). Never save temporary files into the project directory — only `.md` report files and `.feature` spec files belong in `{directory}/`.

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

Read `references/gherkin-guide.md` before generating any specs.

Analyze the gathered context and generate Gherkin `.feature` files:

1. Identify all testable behaviors from the context
2. Group tests by category using the directory naming from the guide (sign-in/, navigation/, reservations/, etc.)
3. Write `.feature` files following the step phrasing conventions exactly
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

### Cache invalidation on write

Whenever you write or overwrite a `.feature` file in this phase (or in Phase 2b — Spec Repair), immediately delete its sibling script if one exists at the mirrored path under `{directory}/tests/`. The script is a disposable cache; the feature file is the source of truth.

For each feature file you wrote at `{directory}/specs/<relative-path>.feature`, check whether `{directory}/tests/<relative-path>.js` exists, and if so issue:

```bash
rm -f {directory}/tests/<relative-path>.js
```

One `rm -f` per file, one Bash call per `rm -f` (no chaining, no `for` loops, no globs that span multiple deletions). Issue them in parallel in a single message when there are several. The same rule applies any time the skill modifies a `.feature` later in the run.

---

## Phase 2 — Test Execution

Execute the spec files using one of two paths per file: a fast **scripted** path (direct `@playwright/test` invocation) when a sibling script exists, or the flexible **agentic** path (concurrent subagents with Playwright MCP) otherwise.

### Determine files to run

- **Create mode**: All `.feature` files just written to `{directory}/specs/`
- **Run mode**: Files identified in setup phase
- **Re-run** (from Phase 2b or Phase 4): Only the specific files passed back

### Partition by execution mode

For each feature file in the run set, derive the mirrored script path: `{directory}/specs/<relative-path>.feature` → `{directory}/tests/<relative-path>.js`.

- **Scripted set**: feature files whose mirrored script exists. (Skip this set entirely if the `@playwright/test` prereq check failed — treat every file as agentic in that case.)
- **Agentic set**: every other feature file.

Both sets process testdata directives identically (next section). They differ only in dispatch.

### Process testdata directives

Before dispatching feature files to runners, check each file for `testdata:` directives. These are lines starting with `testdata:` (with leading whitespace) in the feature description block (between the `Feature:` line and the first `Background:` or `Scenario:`).

If any `testdata:` lines are found:

1. **Consult the furtherSetup file** for instructions on how to execute testdata commands. The furtherSetup file (from `.browser-tests.json`) contains project-specific details: what tool to run, how to invoke it, and where it executes (e.g., inside a container).
2. **Execute each `testdata:` line in order** using the Bash tool, following the instructions from the furtherSetup file. Each line's content (after the `testdata: ` prefix, trimmed) is the command arguments.

   **Strictly one testdata command per Bash call.** Do not batch them with `&&`, do not loop with `for`, do not write a Python/Bun/Node helper that runs them all, and do not pipe one's output into the next. The operator allowlists the testdata tool by its verb (e.g. `Bash(<your-testdata-tool>:*)`); chaining or scripting around it forces a permission prompt and stalls the run. If two testdata lines have no dependency on each other, you may issue them as parallel Bash calls in a single message — but each one is still its own call.
3. **Capture the JSON output** from each command's stdout.
4. **Build a variable scope** from the JSON output. Top-level keys from each command's JSON become `$key_name` variables. When a later `testdata:` line references `$variable`, **you (Claude) substitute the literal value into the command string before issuing the Bash call.** Do not rely on shell expansion — the call should contain the resolved value, not a `$`-prefixed token.
5. **Build two artifacts from the resolved scope**, one per dispatch path. Run testdata once per feature file and feed both:

   **(a) Human-readable context block** — used by the agentic runner (subagent prompt). For each testdata command that was executed, summarize its output in plain language that helps the runner interpret generic steps. Label each entity with its role or purpose, and include credentials where applicable. For example:

   ```
   TEST DATA (created by testdata directives before this feature):

   Command: create location "Test Camp" --with-admin
   - Location name: "Test Camp" (id: abc-123, slug: test-camp)
   - Admin manager: admin-1711234567-1234@test.local, password: "password"

   Command: create guest
   - Guest account: guest-1711234568-5678@test.local, password: "password"
   ```

   The runner uses this context to resolve generic references in steps. For example, when a step says "the admin manager email" or "the guest email", the runner looks up the corresponding value from this block. When a step says "I am signed in as the admin manager", the runner uses the email and password from here.

   **(b) JSON scope** — used by the scripted runner. Serialize the merged variable scope (every top-level key from every command's JSON output) to a single JSON string. Example: `{"location_id":"abc-123","location_slug":"test-camp","admin_email":"admin-1711234567-1234@test.local","admin_password":"password","guest_email":"guest-1711234568-5678@test.local","guest_password":"password"}`. This gets passed via the `BROWSER_TEST_DATA` environment variable when invoking the script (next subsection).

If a testdata command fails (non-zero exit), stop processing that feature file, report the error, and skip it.

If no `testdata:` lines are present, the JSON scope is `{}` and the prose block is omitted.

### Dispatch the scripted set (fast path)

Read `references/scripted-test-creation.md` once before dispatching scripts so the contract (env vars, scenario-name match, exit codes) is fresh.

For each feature file in the scripted set, run a single Bash call invoking the mirrored script:

```bash
BROWSER_TEST_BASE_URL={baseURL} BROWSER_TEST_DATA={json scope} bunx playwright test {directory}/tests/<relative-path>.js --reporter=json
```

- One Bash call per file. Issue up to 3 in parallel in a single message (matches the agentic concurrency cap and keeps wall time predictable).
- The operator allowlists `Bash(bunx playwright test:*)` once and these calls run unattended. Per the Bash discipline rules, do not chain, loop, or wrap these in a script.
- `{json scope}` is the JSON string from the testdata processing step. Single-quote it on the command line so the shell does not interpret it. If the scope is `{}`, still pass it explicitly.

Parse the JSON reporter output for each call. For each `test` (one per Scenario), produce a result entry with the same shape the agentic runner returns:

```json
{
  "file": "<feature path>",
  "feature": "<Feature name>",
  "scenarios": [
    { "name": "<scenario>", "status": "passed|failed|skipped", "failure_reason": "...", "failed_step": "..." }
  ],
  "execution_mode": "scripted"
}
```

The `difficulties` array is always empty for scripted runs — there is no LLM observer to record friction. Note this in the report.

If the `bunx playwright test` invocation itself errors out (non-zero exit before producing JSON, e.g. file not found, syntax error), treat every scenario in that file as failed and route the file to the fallback step below.

### Failure fallback

For any feature file in the scripted set where one or more scenarios failed (or the script itself errored), move that file into a fallback batch. Re-run the **entire feature file** through the agentic path below, using the agentic result as authoritative.

After the agentic re-run completes for a fallback file:

- **All scenarios green**: the script was stale. Delete the cache:

  ```bash
  rm -f {directory}/tests/<relative-path>.js
  ```

  One Bash call per stale file. Note in the report: "Script was stale; removed. Feature passed agentically."

- **Any scenario still failing**: the failure is real. Carry the agentic result into Phase 2b. Leave the script in place — the next scripted run will fail again and re-fall back, which is fine; we only delete on a confirmed-green agentic re-run.

### Dispatch the agentic set

There are 3 Playwright MCP server instances available: `playwright-1`, `playwright-2`, and `playwright-3`. Execute feature files concurrently by spawning one `Agent` subagent per feature file. The agentic set includes (a) every feature file without a sibling script, plus (b) any fallback files routed here from the scripted set.

1. Batch the files into groups of up to 3
2. For each batch, spawn up to 3 `Agent` subagents **concurrently** (in a single message with multiple tool calls)
3. Assign each subagent a distinct Playwright instance: 1st → `playwright-1`, 2nd → `playwright-2`, 3rd → `playwright-3`
4. For each subagent: read `references/runner-prompt.md` and substitute the template variables:
   - `{base URL}` — from configuration
   - `{file path}` — the feature file to execute
   - `{playwright instance}` — the assigned instance name
   - `{further setup}` — the furtherSetup content (or empty if not set)
   - `{testdata context}` — if this file had `testdata:` directives, include the resolved data (IDs, credentials, etc.) as a "TEST DATA" block the runner can reference when interpreting steps. If no `testdata:` directives were present, substitute with empty string.
5. Wait for all subagents in the batch to complete before starting the next batch
6. Collect JSON results from all subagents and tag each with `"execution_mode": "agentic"`

### Result assembly

After both dispatch paths (and any fallbacks) complete, assemble combined results:

1. Merge all per-file results into a single results object. For files that ran through the scripted path AND a fallback agentic path, the agentic result wins.
2. Calculate summary totals across all features:
   ```json
   { "total": 15, "passed": 12, "failed": 2, "skipped": 1 }
   ```
3. Combine all difficulties into a single array, adding `feature_file` to each entry. (Scripted-only files contribute nothing here.)
4. Track which files ran scripted vs. agentic vs. fallback — Phase 3 surfaces this in the report.

If there are **any failures**, proceed to Phase 2b. Otherwise skip to Phase 3.

---

## Phase 2b — Spec Repair

### Repair analysis

For each failed scenario:

1. Read the original `.feature` file from `{directory}/specs/{category}/{filename}`
2. Read the relevant source code to understand the current application behavior
3. Determine the cause:
   - **STALE SPEC**: The application behavior changed legitimately and the spec needs updating
   - **POSSIBLE BUG**: The application behavior seems wrong — the spec's expectation looks correct
   - **ENVIRONMENT ISSUE**: Timing, missing data, or test environment problems

For each **STALE SPEC**:
- Update the file in-place at `{directory}/specs/{category}/{filename}`
- Record what changed and why (original expectation, new expectation, evidence from source code)
- **Invalidate the cache**: if a sibling script exists at the mirrored path under `{directory}/tests/`, delete it with a single `rm -f {directory}/tests/<relative-path>.js` call (see Phase 1 → "Cache invalidation on write"). The cache will be rebuilt the next time someone accepts a script-generation offer for this file.

For each **POSSIBLE BUG**:
- Do NOT update the spec
- Collect for operator presentation

For **ENVIRONMENT ISSUES**: Note them but take no action.

### Independent audit

After completing all repairs, spawn a single `Agent` subagent to audit your changes. Read `references/auditor-prompt.md` and substitute the `{repairs}` template variable with the list of repairs you made. For each repair, include:
- The spec file path (original location)
- The scenario name
- What you changed and why
- The source code evidence you cited

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
   - After the re-run, proceed to Phase 3

If there were **no suspected bugs** from either the repair analysis or the auditor and all repairs were legitimate, re-run the repaired specs through Phase 2, then proceed to Phase 3.

---

## Phase 3 — Reporting

Read `references/report-template.md` and create (or update) the test report following that format.

- Determine the run number from existing files in `{directory}/results/`
- Create the report at `{directory}/results/{YYYY-MM-DD}-run-{N}.md`
- For subsequent runs (repair re-runs, gap specs), append to the same report file and update the cumulative summary
- **Note execution mode per file** — for each feature file in the run, mark it as `scripted`, `agentic`, or `fallback (script→agentic)`. If any scripts were deleted as stale during the run, list them. This helps the operator understand cache hit rate over time.

---

## Phase 4 — Gap Analysis

Analyze the test results and existing specs to identify testing gaps:

1. Review all results — which behaviors are covered, which are missing?
2. Identify gaps in these priority categories:
   - **Error paths** — network errors, permission denied, session timeout, validation failures
   - **Edge cases** — empty states, boundary values, special characters, long inputs
   - **Related features** — if testing sign-in, what about sign-out? password reset?
   - **Interaction patterns** — keyboard navigation, mobile viewport, rapid actions
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
- **Total Scenarios**: {total across all runs}
- **Passed**: {passed} ✅
- **Failed**: {failed} ❌
- **Skipped**: {skipped} ⏭️
- **Pass Rate**: {percentage}%

### Files
- Specs: `{directory}/specs/` ({N} feature files across {M} categories)
- Report: `{directory}/results/{report filename}`

### Gap Analysis
{Summary of gaps identified and new specs created}

### Difficulties
{If any difficulties were reported, summarize them here:}
- **{N} friction points** encountered during execution
- Top suggestions: {list the most impactful suggestions from difficulties}
- See the full report for details

{If no difficulties were reported, omit this section.}

### Execution Mode
- **Scripted (fast path)**: {N} files
- **Agentic (LLM + Playwright MCP)**: {N} files
- **Fallback (script failed → agentic)**: {N} files
{If any scripts were deleted as stale during the run, list them under a "Stale scripts removed" sub-bullet.}

### Readiness Assessment
{Based on pass rate and gap analysis, provide one of:}
- **Ready for release** — All scenarios pass, good coverage, no critical gaps
- **Needs attention** — Some failures that should be investigated before release
- **Not ready** — Significant failures or critical gaps in test coverage
```

---

## Script Generation Offer

After the Presentation, offer to seed the script cache for files that just ran agentically with no failures.

**Skip this whole section if:**
- The `@playwright/test` prereq check failed (no runner available).
- There are zero candidates (defined below).

**Identify candidates** — feature files where ALL of:
1. The file ran via the **agentic** path in this session (either originally agentic, OR a fallback agentic re-run that passed). A file that ran scripted-only contributes nothing new.
2. Every scenario in the file passed.
3. No script currently exists at `{directory}/tests/<relative-path>.js`. (For fallback files where the stale script was just deleted, the slot is now empty — they ARE candidates.)

**Ask the operator** using `AskUserQuestion`:

- **≤5 candidates**: present them as a per-file selection ("Generate script for `specs/sign-in/manager.feature`?" yes / no per item, plus an "all" / "none" shortcut).
- **>5 candidates**: present three options — "all", "none", "let me name a subset" (followed by a free-text prompt where the operator lists files).

**For each chosen file:**
1. Read `references/scripted-test-creation.md` for the contract (env vars, scenario-name match, allowed APIs).
2. Read the feature file and the testdata context block from this run (you still have the resolved scope in memory).
3. Author the JS file at `{directory}/tests/<relative-path>.js`. Use the `Write` tool — do not shell out.
4. Self-check before finishing each file: scenario names match Gherkin verbatim, only `process.env.BROWSER_TEST_BASE_URL` and `process.env.BROWSER_TEST_DATA` are read for inputs, no hardcoded credentials/IDs/URLs, no writes outside `/tmp/browser-tests`.

Do **not** execute the new scripts in this session — they are exercised on the next run, where any drift surfaces via the fallback path. Acknowledge the count of scripts generated in your final reply to the operator.

---

## Final Validation

After all phases are complete and the Presentation has been shown, validate every spec file in `{directory}/specs/` using the validation script:

```bash
bun {absolute path to this skill}/scripts/validate.js $(find {directory}/specs -name '*.feature')
```

- If any files fail validation, read the file, fix common issues (missing Feature keyword, malformed tables, indentation), and re-validate.
- Only fix parsing errors — do not change test logic.
- Report any files that could not be fixed to the operator.

---

## Error Handling

- If no specs are generated in Phase 1: Ask the operator for more context about what to test
- If all specs fail validation: Check the guide reference path and report the issue to the operator
- If a subagent fails to return results: Report the failure to the operator and offer to retry that feature file individually
- If all scenarios fail: Check if the base URL is accessible, credentials are correct, and the application is in the expected state
- If the application is not accessible: Verify the base URL from `.browser-tests.json` and ask the operator to confirm the application is running
