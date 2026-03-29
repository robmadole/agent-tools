---
name: hobgoblin
description: "Examine similar files for consistency violations. Compares 2+ files that should follow the same pattern, decomposes comparison areas, and produces a work items list of differences. Use when user says 'hobgoblin', 'consistency check', or 'compare patterns'."
version: 1.0.0
args: "Paths or globs identifying the similar files to compare (minimum 2)"
user-invokable: true
---

# Hobgoblin — Consistency Enforcement for Similar Files

> "A foolish consistency is the hobgoblin of little minds, adored by little statesmen and philosophers and divines." — Emerson

We get to be the hobgoblin because agents are not constrained by attention. Where a human reviewer glazes over after the third file, we thrive. The goal: lower mental load for humans and reduce contextual confusion for agents by enforcing consistency across files that should follow the same pattern.

Hobgoblin does not make changes. It produces a work items list that can be acted on later.

## Prerequisites

Before proceeding, verify:

1. **Agent tool** — The Agent tool must be available for spawning comparison subagents.
2. **Minimum 2 targets** — At least 2 files or file groups must be identified for comparison. If fewer than 2 are provided or resolved, stop and tell the operator.

## Step 1 — Resolve Targets

Parse `$ARGUMENTS` to identify the files to compare. Arguments may be:

- Explicit file paths (`src/components/Button.tsx src/components/Input.tsx`)
- Glob patterns (`src/components/*.tsx`)
- A description the operator gives you to find the files ("all the LiveView modules", "the controller files")

If arguments are ambiguous or missing, ask the operator directly: "Which files should I compare for consistency?"

Resolve all targets to concrete file paths. Read every target file in full. If there are more than 10 files, confirm with the operator before proceeding — large comparisons work best when scoped.

## Step 2 — Decompose Comparison Areas

Read all target files and identify the major areas where consistency can be evaluated. This decomposition is specific to the files at hand — do not use a generic checklist. Study what the files actually contain and determine the axes of comparison.

Examples of comparison areas (illustrative, not exhaustive):

- **Structural layout** — ordering of imports, module attributes, function groupings, section separators
- **Naming conventions** — variable names, function names, module names, CSS classes, data attributes
- **API shape** — function signatures, parameter ordering, return value patterns, error handling style
- **Stylistic patterns** — string quoting, trailing commas, blank line usage, comment style
- **Domain conventions** — how similar domain concepts are modeled across files (field names, validation patterns, query structure)
- **Error handling** — try/rescue patterns, error tuple shapes, fallback behavior
- **Type annotations** — typespec presence, format, level of detail
- **Template/markup patterns** — component usage, class ordering, attribute ordering, nesting depth

Produce a numbered list of comparison areas with a one-line description of each. This list becomes the investigation plan.

## Step 3 — Investigate Each Area with Subagents

For each comparison area identified in Step 2, spawn a subagent using the Agent tool. Run subagents concurrently where possible (batch independent areas together).

Each subagent receives:

1. The full content of all target files (or the relevant excerpts if files are very large)
2. The specific comparison area to investigate
3. The following instructions:

> You are a consistency auditor examining similar files. Your comparison area is: **[area name]**.
>
> Your job is to find EVERY inconsistency in this area across the provided files, no matter how small. Be nit-picky turned up to 11. One character off, a simple mis-ordering with no functional impact, the smallest stylistic difference — flag it all.
>
> For each inconsistency found, report:
> - **What**: A precise description of the difference
> - **Where**: File paths and line numbers for each variant
> - **Variants**: Show each distinct variant, quoting the exact code
> - **Severity**: `nitpick` (pure style, zero impact), `minor` (slightly increases cognitive load), or `notable` (actively confusing or likely to mislead)
>
> If a file is perfectly consistent with all others in this area, say so explicitly.
>
> Do NOT suggest which variant is "correct" — that is the operator's decision. Just surface the differences.

Collect all subagent results.

## Step 4 — Check Memory for Prior Decisions

Before presenting findings, check the project's memory files for any prior hobgoblin decisions. If a previous hobgoblin run established a preference for a specific variant (e.g., "we use single quotes in this codebase"), filter out inconsistencies that align with that decision and instead flag files that violate it as "violates established convention."

If no prior decisions exist, proceed with all findings.

## Step 5 — Present Findings to Operator

Compile all subagent results into a single report, organized by comparison area. Within each area, group inconsistencies by severity (notable first, then minor, then nitpick).

For each inconsistency, present it as a decision point:

> **[Area]: [Brief description]**
> Severity: `[severity]`
>
> Variant A (used in `file1.ex`, `file3.ex`):
> ```
> [exact code]
> ```
>
> Variant B (used in `file2.ex`):
> ```
> [exact code]
> ```
>
> Which variant should be the standard? (A / B / skip / custom)

If one variant is overwhelmingly more common (used in 80%+ of files), note this: "Variant A is dominant (4 of 5 files)."

Do NOT decide for the operator. Even if one choice seems obviously better, present it neutrally. The one exception: if a prior memory decision covers this case, note the established convention instead of asking.

Present each inconsistency **one at a time** using the `AskUserQuestion` tool. Do not batch them. The operator needs space to think about each decision individually. After receiving the answer, save the decision to memory (Step 6) before moving to the next inconsistency.

The operator may respond with:

- Pick a variant (A, B, etc.)
- Say "skip" to leave it inconsistent intentionally
- Provide a custom standard that differs from all current variants

## Step 6 — Save Decisions to Memory

For every decision the operator makes (including "skip"), save it to a memory file. Use type `feedback` and structure each memory so it can be recalled in future hobgoblin runs or by other skills.

Memory file naming: `hobgoblin_[brief-topic].md`

Example memory content:

```markdown
---
name: hobgoblin-controller-function-ordering
description: "Established convention for function ordering in Phoenix controllers"
type: feedback
---

Controller functions should be ordered: index, show, new, create, edit, update, delete.

**Why:** Decided during hobgoblin consistency review of controllers. Matches Phoenix generator output order.

**How to apply:** When writing or reviewing Phoenix controllers, follow this ordering. Flag deviations in future hobgoblin runs.
```

If the operator says "skip," save that too — it prevents the same question from being asked in future runs:

```markdown
---
name: hobgoblin-skip-quote-style-templates
description: "No enforced convention for quote style in HEEx templates"
type: feedback
---

Quote style (single vs double) in HEEx templates is not enforced — both are acceptable.

**Why:** Operator explicitly skipped this during hobgoblin review. Mix of both exists and neither causes confusion.

**How to apply:** Do not flag quote style differences in HEEx templates during future hobgoblin runs.
```

## Step 7 — Generate Work Items and Ask Where They Go

Produce a final work items list containing every inconsistency where the operator chose a standard (not skipped). Each work item should be actionable:

```markdown
## Hobgoblin Work Items — [date]

### [Comparison Area]

- [ ] **[file_path:line_number]** — Change [description of current state] to [description of target state]
- [ ] **[file_path:line_number]** — Change [description of current state] to [description of target state]

### [Next Comparison Area]

- [ ] ...
```

Summarize the totals: "X work items across Y files in Z comparison areas."

Then use `AskUserQuestion` to ask: **"What would you like to do with this?"**

Do whatever the operator asks.

## Important Constraints

- **Never make changes** — Hobgoblin is read-only. It produces work items, not patches.
- **Never decide for the operator** — When one variant is not obviously better than another, the human decides. "Obviously better" means one variant is a bug or violates a language/framework rule — style preferences always go to the operator.
- **Minimum 2 targets** — Consistency requires comparison. A single file has nothing to be consistent with.
- **Respect prior decisions** — Check memory before asking questions the operator has already answered.
- **Be exhaustive** — The whole point is to catch things humans miss. If you're unsure whether something is an inconsistency, flag it as a `nitpick` rather than omitting it.
- **Quote exactly** — When showing variants, use the exact code from the files. Do not paraphrase or summarize code.
