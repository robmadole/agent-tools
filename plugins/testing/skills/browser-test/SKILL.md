---
name: browser-test
description: "Orchestrate QA browser testing via Gherkin specs using Claude Agent Teams and Playwright."
version: 1.1.0
---

# Browser Test — QA Testing with Gherkin Specs

You are the **Lead** of a QA browser testing team. You orchestrate a multi-phase workflow that generates Gherkin specs from code changes, executes them against a running application via Playwright MCP tools, and produces a comprehensive test report.

## Modes of operation

Determine from $ARGUMENTS what mode of operation we'll be in. If you cannot deduce this ask the user directly: "Would you like to create or run existing tests?"

### "Create"

The operator is asking for the Hunter to begin this team's work by looking at PR, a feature area, or description. The other teammates are idle until the Hunter begins sending messages to them.

### "Run"

The operator is asking to run tests that already exist in the `.browser-tests.json` `directory` attribute. In this mode, the Hunter will not begin creating any tests but instead wait for messages from other teammates.

## Prerequisites

Before proceeding, verify all of the following. If any check fails, stop immediately with the corresponding message.

1. **Agent Teams** — Verify that the `TeamCreate` and `SendMessage` tools are available.

   > This skill requires Agent Teams to function. Please enable Agent Teams before running `/browser-test`.

2. **Playwright MCP** — Verify that Playwright MCP tools are available by checking that tools prefixed with `mcp__playwright-1__`, `mcp__playwright-2__`, and `mcp__playwright-3__` exist. All three instances must be present.

   > This skill requires 3 Playwright MCP server instances (playwright-1, playwright-2, playwright-3) configured in `.mcp.json`. Ensure the `@playwright/mcp` package is available and all three servers are running.

3. **Bun** — Verify that `bun` is available by running `bun --version`.

   > This skill requires Bun to run the validation script. Install it from https://bun.sh before running `/browser-test`.

---

## Setup Phase

Before spawning any teammates, establish configuration and gather context.

### 0. Load configuration

Read `.browser-tests.json` from the repository root. If it does **not** exist, stop and tell the operator:

> No `.browser-tests.json` found.

After informing them of this, proceed to go through `references/setup.md` in order to get this file created.

If it exists, load `directory`, `baseURL`, and `furtherSetup` from it.

If `furtherSetup` is set, fetch that URL and read its contents. This provides project-specific testing context (test credentials, seed data, application quirks) that should be passed to teammates — especially the Runner and Hunter.

### 1. What to test

If we are in "Run" mode and we weren't given the tests to run in $ARGUMENTS, ask the operator now.

If we are in "Create" mode and we weren't given the subject to test in $ARGUMENTS, ask the operator what they want to test. Accept one of:

- **PR diff** — You will run `git diff` to identify changed files and features
- **Feature area** — The operator names a feature (e.g., "reservation calendar", "sign-in flow")
- **Description** — The operator provides a free-text description of what to test

### 2. Initialize directories

Create the following directories at the project root if they don't exist:

```bash
mkdir -p {directory}/unsorted {directory}/specs {directory}/results /tmp/browser-tests
```

Where `{directory}` comes from `.browser-tests.json`.

**Important**: The `/tmp/browser-tests/` directory is for temporary files created during test execution (screenshots for verification, dummy test fixtures for upload testing, etc.). Never save temporary files into the project directory — only `.md` report files and `.feature` spec files belong in `{directory}/`.

### 3. Gather context

Based on the operator's choice in step 1:

- **The specs to run**: Read from the `{directory}/specs` directory and find the `*.feature` files that match their request
- **PR diff**: Run `git diff main...HEAD --name-only` and `git diff main...HEAD` to understand what changed
- **Feature area**: Use Glob and Grep to find relevant source files, read key files to understand the feature
- **Description**: Use the description to identify relevant source files

Store this context — in Create mode you will pass it to the Hunter, in Run mode you will pass the spec file list to the Runner.

---

## Teammate Lifecycle

Spawn all teammates simultaneously using `TeamCreate` with these exact names:

| Name        | Prompt                          |
|-------------|---------------------------------|
| `Hunter`    | `references/hunter-prompt.md`   |
| `Librarian` | `references/librarian-prompt.md`|
| `Runner`    | `references/runner-prompt.md`   |
| `Scribe`    | `references/scribe-prompt.md`   |
| `Sneak`     | `references/sneak-prompt.md`    |

These names are how teammates address each other in `SendMessage`. Use them exactly as shown — teammates reference each other by these names in their prompts.

All teammates remain active for the entire workflow and accept new work via messages from the Lead or directly from other teammates. Do not terminate and re-spawn teammates between phases — reuse the existing instances.

Each teammate's task assignment (below) describes ALL of their responsibilities across every phase. They wait for messages to know when to act.

---

## Phase 1 — Spawn Teammates

Spawn all teammates simultaneously.

### Hunter (blue)

Task assignment: Read `references/hunter-prompt.md` and use it as the task assignment message. Substitute template variables ({base URL}, {directory}, {absolute path to this skill}, and the gathered context) before sending.

**Create mode**: Hunter should begin working immediately once it has enough context.

### Librarian (green)

Task assignment: Read `references/librarian-prompt.md` and use it as the task assignment message. Substitute template variables ({directory}) before sending.

### Runner (yellow)

Task assignment: Read `references/runner-prompt.md` and use it as the task assignment message. Substitute template variables ({base URL}, {directory}) before sending. The Runner handles concurrency internally by spawning subagents per feature file.

**Run mode**: Send the Runner a `run_specs` message with the identified spec files so it can begin executing immediately.

### Scribe (cyan)

Task assignment: Read `references/scribe-prompt.md` and use it as the task assignment message. Substitute template variables ({directory}) before sending.

### Sneak (magenta)

Task assignment: Read `references/sneak-prompt.md` and use it as the task assignment message. Substitute template variables ({directory}, {absolute path to this skill}) before sending.

---

## Phase 2 — Execution

**Create mode**: The Librarian sends `run_specs` directly to the Runner after organizing specs — the Lead does **not** need to relay this. The Librarian also sends `specs_ready` to the Lead as a CC.

**Run mode**: The Runner is already executing from the `run_specs` message sent in Phase 1. The Librarian has no role in this phase.

The Runner executes specs and sends `test_results` to the Lead, Scribe, and Sneak. If there are failures, the Runner also sends `repair_needed` directly to the Hunter — the Lead does **not** need to relay this either.

**Wait** for the Runner to send `test_results` before proceeding.

If there are **any failures**, proceed to Phase 2b — Spec Repair. If all scenarios passed, skip to Phase 3 — Reporting.

---

## Phase 2b — Spec Repair

The Runner has already sent `repair_needed` directly to the Hunter — repairs are already underway by the time the Lead receives `test_results`. The Sneak will automatically receive `spec_repair` messages from the Hunter and activate its Repair Audit role. The Librarian will process any repaired specs that the Hunter delivers.

**Wait** for `repair_complete` from the Hunter and `repair_audit` from the Sneak.

### Lead — Repair Decision Point

After receiving `repair_complete` from Hunter and `repair_audit` from Sneak:

1. **If Sneak found suspected bugs or needs-operator-input items**: Present them to the operator:

> The Hunter updated {N} specs to match current behavior, but the Sneak flagged {M} potential issues:
>
> {For each suspected_bug or needs_operator_input finding, show the scenario, the Hunter's change, and the Sneak's reasoning}
>
> For each flagged item, would you like to:
> a) **Accept the update** — the behavior change is intentional
> b) **Keep the original spec** — this is a bug that should be fixed
> c) **Skip this scenario** — remove it from testing for now

2. **If Hunter found suspected bugs**: Present them to the operator:

> The Hunter identified {N} scenarios that appear to be application bugs rather than stale specs:
>
> {For each suspected_bug, show the scenario, expected vs. actual behavior, and evidence}
>
> These specs were NOT updated. Would you like to:
> a) **Continue testing** — proceed with remaining passing specs and repaired specs
> b) **Stop here** — investigate the bugs before continuing

3. **After operator decisions**:
   - For accepted repairs: The Librarian should already have the updated files from the Hunter's deliveries
   - For rejected repairs (keep original): No action needed, original specs remain
   - Send a `run_specs` message to the Runner with ONLY the repaired spec files to verify the fixes work
   - After the re-run, proceed to Phase 3

If there were **no suspected bugs** from either Hunter or Sneak and all repairs were legitimate, send a `run_specs` message to the Runner with the repaired specs, then proceed to Phase 3.

---

## Phase 3 — Reporting

The Runner's `test_results` messages are automatically sent to both the Scribe and Sneak. After the Runner completes (or after Phase 2b re-run if repairs were needed), both are already working:

- **Scribe** creates (or appends to) the test report
- **Sneak** activates Role B (gap analysis) to identify testing gaps

**Wait** for both the Scribe and Sneak to complete before proceeding to Phase 4.

---

## Phase 4 — Optional Re-run

After the Sneak produces gap specs, ask the operator:

> The Sneak identified {N} testing gaps and created {M} new spec files. Would you like to run these additional specs through the browser? (Maximum 2 Sneak cycles)

If **yes**:
1. The Librarian is already processing the Sneak's gap specs and will send `run_specs` directly to the Runner once organized
2. The Runner's results will automatically go to the Scribe (who appends to the existing report) and the Sneak (who may identify further gaps)
3. If this is cycle 1 of max 2, repeat Phase 4 with the Sneak's next gap analysis

If **no**: Proceed to presentation.

Track the cycle count. Do not allow more than 2 Sneak cycles total.

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
{Summary from Sneak's gap_analysis}

### Difficulties
{If the Runner reported any difficulties, summarize them here:}
- **{N} friction points** encountered during execution
- Top suggestions: {list the most impactful suggestions from the Runner's difficulties}
- See the full report for details

{If no difficulties were reported, omit this section.}

### Readiness Assessment
{Based on pass rate and gap analysis, provide one of:}
- **Ready for release** — All scenarios pass, good coverage, no critical gaps
- **Needs attention** — Some failures that should be investigated before release
- **Not ready** — Significant failures or critical gaps in test coverage
```

---

## Final Validation

After all phases are complete and the Presentation has been shown, the Lead validates every spec file in `{directory}/specs/` using the validation script:

```bash
bun {absolute path to this skill}/scripts/validate.js $(find {directory}/specs -name '*.feature')
```

- If any files fail validation, read the file, fix common issues (missing Feature keyword, malformed tables, indentation), and re-validate.
- Only fix parsing errors — do not change test logic.
- Report any files that could not be fixed to the operator.

---

## Teammate Color Reference

| Teammate  | Color   | Role |
|-----------|---------|------|
| Hunter    | blue    | Analyzes code, generates Gherkin specs; repairs stale specs after failures |
| Librarian | green   | Organizes and saves specs |
| Runner    | yellow  | Executes specs concurrently via Playwright MCP subagents |
| Scribe    | cyan    | Creates test reports |
| Sneak     | magenta | Identifies gaps, generates additional specs; audits Hunter's repairs for hidden bugs |

## Error Handling

- If the Hunter produces no specs: Ask the operator for more context about what to test
- If all specs fail validation: Check the guide reference path and report the issue to the operator
- If the Runner cannot connect to the browser: Verify the Playwright MCP servers are running and the application is accessible at the base URL
- If all scenarios fail: Check if the base URL is accessible, credentials are correct, and the application is in the expected state
- If a teammate becomes unresponsive: Report to the operator and offer to retry that phase
