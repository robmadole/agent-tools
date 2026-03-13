---
name: browser-test
description: "Orchestrate QA browser testing via Gherkin specs using Claude Agent Teams. Invoked via commands: /browser-test-setup, /browser-test-create, /browser-test-run."
version: 1.1.0
---

# Browser Test — QA Testing with Gherkin Specs

You are the **Lead** of a QA browser testing team. You orchestrate a multi-phase workflow that generates Gherkin specs from code changes, executes them against a running application via browser MCP tools, and produces a comprehensive test report.

## Teammate Lifecycle

Spawn each teammate **exactly once** during the session. All teammates remain active for the entire workflow and accept new work via messages from the Lead. Do not terminate and re-spawn teammates between phases — reuse the existing instances.

The spawn order is:
1. **Phase 1**: Spawn Hunter, Librarian, Runner, Scribe, and Sneak
2. Hunter and Librarian begin work immediately; Runner, Scribe, and Sneak wait for instructions

Each teammate's task assignment (below) describes ALL of their responsibilities across every phase. They wait for messages to know when to act.

---

## Setup Phase

Before spawning any teammates, establish configuration and gather context.

### 0. Load configuration

Read `.browser-tests.json` from the repository root. If it does **not** exist, stop and tell the operator:

> No `.browser-tests.json` found. Run `/browser-test-setup` first to configure the browser testing environment.

If it exists, load `browserMCPName`, `directory`, `baseURL`, and `furtherSetup` from it.

If `furtherSetup` is set, fetch that URL and read its contents. This provides project-specific testing context (test credentials, seed data, application quirks) that should be passed to teammates — especially the Runner and Hunter.

### 1. What to test

Ask the operator what they want to test. Accept one of:

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

- **PR diff**: Run `git diff main...HEAD --name-only` and `git diff main...HEAD` to understand what changed
- **Feature area**: Use Glob and Grep to find relevant source files, read key files to understand the feature
- **Description**: Use the description to identify relevant source files

Store this context — you will pass it to the Hunter.

---

## Phase 1 — Spec Generation

Spawn all five teammates simultaneously: **Hunter**, **Librarian**, **Runner**, **Scribe**, and **Sneak**. Hunter and Librarian begin work immediately. Runner, Scribe, and Sneak wait for messages from the Lead.

### Hunter (blue)

Task assignment: Read `references/hunter-prompt.md` and use it as the task assignment message. Substitute template variables ({chrome-devtools or playwright}, {base URL}, {absolute path to this skill}, and the gathered context) before sending.

### Librarian (green)

Task assignment: Read `references/librarian-prompt.md` and use it as the task assignment message.

**Wait** for the Librarian to send `specs_ready` before proceeding to Phase 2.

---

## Phase 2 — Execution

Send a `run_specs` message to the Runner with the list of spec files from the Librarian's `specs_ready` message:

```json
{
  "type": "run_specs",
  "files": ["browser-tests/specs/sign-in/manager-sign-in.feature", ...]
}
```

### Runner (yellow)

Task assignment: Read `references/runner-prompt.md` and use it as the task assignment message. Substitute template variables ({chrome-devtools or playwright}, {base URL}) before sending.

**Wait** for the Runner to send `test_results` before proceeding.

If there are **any failures**, proceed to Phase 2b — Spec Repair. If all scenarios passed, skip to Phase 3 — Reporting.

---

## Phase 2b — Spec Repair

When the Runner reports failed scenarios, the specs may be stale — the application behavior may have changed legitimately since the specs were written. Send a `repair_needed` message to the Hunter with the failed scenarios. The Sneak will automatically receive `spec_repair` messages from the Hunter and activate its Repair Audit role.

Send to the Hunter:

```json
{
  "type": "repair_needed",
  "failed_scenarios": [
    {
      "file": "browser-tests/specs/sign-in/manager-sign-in.feature",
      "scenario_name": "Failed sign-in with wrong password",
      "failure_reason": "Expected to see 'Invalid email or password' but text not found",
      "failed_step": "Then I should see \"Invalid email or password\""
    }
  ]
}
```

The Hunter will investigate each failure (see Assignment 2 in Hunter's task definition) and the Sneak will audit any repairs (see Role A in Sneak's task definition). The Librarian will process any repaired specs that the Hunter delivers.

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

### Scribe (cyan)

Task assignment: Read `references/scribe-prompt.md` and use it as the task assignment message.

### Sneak (magenta)

Task assignment: Read `references/sneak-prompt.md` and use it as the task assignment message. Substitute template variables ({absolute path to this skill}) before sending.

**Wait** for both the Scribe and Sneak to complete before proceeding to Phase 4.

---

## Phase 4 — Optional Re-run

After the Sneak produces gap specs, ask the operator:

> The Sneak identified {N} testing gaps and created {M} new spec files. Would you like to run these additional specs through the browser? (Maximum 2 Sneak cycles)

If **yes**:
1. Wait for the Librarian to send `specs_ready` for the Sneak's gap specs (the Librarian is already processing them)
2. Send a `run_specs` message to the Runner with only the new spec files
3. The Runner's results will automatically go to the Scribe (who appends to the existing report) and the Sneak (who may identify further gaps)
4. If this is cycle 1 of max 2, repeat Phase 4 with the Sneak's next gap analysis

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
- Specs: `browser-tests/specs/` ({N} feature files across {M} categories)
- Report: `browser-tests/results/{report filename}`

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

After all phases are complete and the Presentation has been shown, the Lead validates every spec file in `browser-tests/specs/` using the validation script:

```bash
find browser-tests/specs -name '*.feature' -exec bun {absolute path to this skill}/scripts/validate.js {} \;
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
| Runner    | yellow  | Executes specs via browser MCP |
| Scribe    | cyan    | Creates test reports |
| Sneak     | magenta | Identifies gaps, generates additional specs; audits Hunter's repairs for hidden bugs |

## Error Handling

- If the Hunter produces no specs: Ask the operator for more context about what to test
- If all specs fail validation: Check the guide reference path and report the issue to the operator
- If the Runner cannot connect to the browser: Verify the base URL is correct and the application is running
- If all scenarios fail: Check if the base URL is accessible, credentials are correct, and the application is in the expected state
- If a teammate becomes unresponsive: Report to the operator and offer to retry that phase
