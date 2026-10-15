# Report Format Template

Use this template when creating and updating test reports in `{directory}/results/`.

## Initial Report

Create the file at: `{directory}/results/{YYYY-MM-DD}-run-{N}.md`

`{N}` is the run number `report.js claim` gave this run in Setup. Don't work it out from `{directory}/results/`: a run whose report isn't written yet doesn't show up there.

```markdown
# Browser Test Report — {YYYY-MM-DD} Run #{N}

## Cumulative Summary

| Metric | Count |
|--------|-------|
| Total Scenarios | {total} |
| Passed | {passed} |
| Failed | {failed} |
| Skipped | {skipped} |
| Pass Rate | {percentage}% |
| Flaky | {totals.flaky} (omit when 0) |
| Focus findings | {totals.findings} (only when a focus ran) |
| Settled by Jev | {n} (Jev runs only) |
| Re-run by Claude | {m} (Jev runs only) |
| Jev cost | ${cost} (Jev runs only) |

---

## Run 1 — Initial Specs

### Results by Feature

#### {Feature Name}
**File**: `{file path}`

| Scenario | Status | Runner |
|----------|--------|--------|
| {name} | ✅ Pass | Jev |
| {name} | ❌ Fail | Claude |
| {name} | ⏭️ Skip | Claude |

Drop the Runner column, and the three Jev rows in the summary, when `runner` is `claude`.

### Failed Scenarios

#### {Scenario Name}
**Feature**: {feature name}
**Failed Step**: `{step text}`
**Reason**: {failure reason}

**Steps**:
1. ✅ {step 1}
2. ✅ {step 2}
3. ❌ {failed step}
4. ⏭️ {skipped step}

### Flaky Scenarios

{Include this section only if `totals.flaky` is above 0. One row per scenario with `flaky: true`.}

| Scenario | Feature | Attempts | Why it's flaky |
|----------|---------|----------|----------------|
| {name} | `{file}` | functional claude-1: passed · focus focus-1: failed | {flaky_reason} |

{Flaky means the attempts disagreed and the cause wasn't found or wasn't fixed. It's a signal to
investigate, not a failure: the scenario keeps its functional verdict in the tables above.}

### Difficulties Encountered

{Include this section only if the Runner reported difficulties. These are steps that passed but required extra effort — addressing them will speed up future test runs.}

| Spec File | Scenario | Step | Difficulty | Suggestion |
|-----------|----------|------|------------|------------|
| `{file}` | {scenario} | `{step}` | {difficulty} | {suggestion} |

{Omit this section entirely if no difficulties were reported.}

### Clarifications

{Include this section only if Phase 2b clarified any specs. One row per clarified step.}

| Spec File | Scenario | Before | After | Why |
|-----------|----------|--------|-------|-----|
| `{file}` | {scenario} | `{old step}` | `{new step(s)}` | {runner interpretation or Jev reason} |

{In a Jev run, finish with: "Jev now settles {j} of the {k} clarified scenarios."}

### Focus Findings

{Include this section only if a focus ran. Take everything from `report summary --steps`: `findings.by_focus`
for the counts, `findings.groups` for the rows, already sorted most severe first. One table per focus.}

{findings.total} distinct findings from {findings.recorded} checks. A finding seen on several transitions
is listed once, and so is one element with the same problem on several pages: "Where" lists its `paths`.
These never change a scenario's verdict.

#### {Focus name}

{critical} critical · {serious} serious · {moderate} moderate · {minor} minor

| Impact | Rule | Finding | Where | Seen after |
|--------|------|---------|-------|------------|
| critical | `image-alt` (axe) | Images must have alternate text | `/sign-in` · `img.logo` · wcag2a wcag111 | Valid credentials › `Given I am on the "Sign In" page` (+2 more) |
| serious | `focus-not-moved` (judgment) | Focus stays on the submit button after the error appears | `/sign-in` · `form#signin` | Wrong password › `When I click the "Sign in" button` |

{Findings with a screenshot show it in the visual report. When the run also built one, end the section with
a line pointing there.}

### Recommendations

{Based on failure patterns AND any reported difficulties, suggest:
- Likely root causes
- Areas needing developer attention
- Whether failures indicate bugs vs. spec issues
- Improvements to specs or the application that would make testing smoother}
```

## Appending Subsequent Runs

For subsequent runs (repaired specs, gap specs, etc.), read the existing report file and append a new section:

```markdown
---

## Run {M} — {context: "Repaired Specs" or "Gap Specs" or "Gap Specs Cycle 2"}

{Same structure as above: Results by Feature, Failed Scenarios, Difficulties, Recommendations}
```

After appending, update the **Cumulative Summary** table at the top to reflect totals across ALL runs combined.
