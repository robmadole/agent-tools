# Report Format Template

Use this template when creating and updating test reports in `{directory}/results/`.

## Initial Report

Create the file at: `{directory}/results/{YYYY-MM-DD}-run-{N}.md`

Determine the run number by checking existing files in `{directory}/results/` — increment from the highest existing run number, or start at 1.

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

---

## Run 1 — Initial Specs

### Results by Feature

#### {Feature Name}
**File**: `{file path}`

| Scenario | Status |
|----------|--------|
| {name} | ✅ Pass |
| {name} | ❌ Fail |
| {name} | ⏭️ Skip |

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

### Difficulties Encountered

{Include this section only if the Runner reported difficulties. These are steps that passed but required extra effort — addressing them will speed up future test runs.}

| Spec File | Scenario | Step | Difficulty | Suggestion |
|-----------|----------|------|------------|------------|
| `{file}` | {scenario} | `{step}` | {difficulty} | {suggestion} |

{Omit this section entirely if no difficulties were reported.}

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
