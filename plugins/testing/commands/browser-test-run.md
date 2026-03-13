# Browser Test Run

Run existing browser test specs without creating new ones. Skips spec generation (Phase 1) entirely.

**This command is an adjunct to the `browser-test` skill** (`skills/browser-test/SKILL.md`). Read and understand the full skill file first — it defines the teammates, phases, message protocols, and workflows that this command builds on. The modifications below tell you which parts of the skill to skip or adjust; everything else follows the skill as written.

## Prerequisites

Read `.browser-tests.json` from the repository root. If it doesn't exist, tell the operator to run `/browser-test-setup` first and stop.

Load the configuration values: `browserMCPName`, `directory`, `baseURL`, `furtherSetup`.

## Confirm Browser Integration

Before proceeding, confirm the browser integration with the operator:

```
Browser integration: {browserMCPName}

Is this correct? (yes/change)
```

If the operator wants to change it, ask which browser MCP to use (chrome-devtools, vibium, or playwright) and use that for the remainder of the run.

## Further Setup

Fetch the `furtherSetup` URL and read its contents. Pass this context to the Runner so it has project-specific knowledge like test credentials, seed data, and application quirks.

If `furtherSetup` is not accessible, continue without it but note this to the operator.

## Determine which specs to run

Check if the operator's prompt specifies which tests to run. They may provide:

- **Specific file paths** — e.g., `browser-tests/specs/sign-in/manager-sign-in.feature`
- **A category/directory** — e.g., "sign-in specs" or "all reservation tests"
- **A pattern** — e.g., "all specs" or "everything that failed last time"
- **Nothing specific** — the prompt doesn't indicate which tests

If the prompt doesn't contain enough information to determine which specs to run, ask the operator. List the available spec files from `{directory}/specs/` to help them choose:

```
Available specs in {directory}/specs/:

  sign-in/
    manager-sign-in.feature (3 scenarios)
    employee-sign-in.feature (2 scenarios)
  reservations/
    create-reservation.feature (5 scenarios)
    ...

Which specs would you like to run? (You can say "all", name specific files, or name a category)
```

## Execution

Follow the browser-test skill (`skills/browser-test/SKILL.md`) with these modifications:

- **Skip Setup Phase entirely** — configuration comes from `.browser-tests.json`, specs are already identified above.
- **Skip Phase 1 (Spec Generation)** — no Hunter or Librarian work needed for initial spec creation.
- **Spawn only**: Runner(s), Scribe, and Sneak.
- **Runner concurrency** — default to spawning **3 Runner instances** that execute specs in parallel. Before spawning, confirm with the operator:

  ```
  Spawning 3 Runners to execute specs concurrently. OK? (yes/change number)
  ```

  If the operator changes the number, use that instead. Divide the spec files roughly evenly across the Runner instances.
- **Begin at Phase 2 (Execution)** — send `run_specs` to each Runner with its portion of the identified spec files.
- **Phase 2b (Spec Repair)** — if failures occur, spawn the Hunter at this point to investigate and repair. The Librarian is also spawned here if needed to organize repaired specs.
- **Phase 3 (Reporting)**, **Phase 4 (Optional Re-run)**, **Presentation**, and **Final Validation** proceed as documented in the skill.

When substituting template variables in teammate prompts, use the values from `.browser-tests.json`. Use `{directory}` in place of `browser-tests` wherever paths are constructed.
