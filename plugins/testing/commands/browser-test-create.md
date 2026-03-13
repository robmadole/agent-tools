# Browser Test Create

Create new browser tests, run them, and report the outcome. This is the default mode of the browser-test skill.

**This command is an adjunct to the `browser-test` skill** (`skills/browser-test/SKILL.md`). Read and understand the full skill file first — it defines the teammates, phases, message protocols, and workflows that this command relies on. The instructions below provide the entry point and any command-specific configuration; all execution follows the skill as written.

## Prerequisites

Read `.browser-tests.json` from the repository root. If it doesn't exist, tell the operator to run `/browser-test-setup` first and stop.

Load the configuration values: `browserMCPName`, `directory`, `baseURL`, `furtherSetup`.

## Further Setup

Fetch the `furtherSetup` URL and read its contents. Pass this context to teammates (especially the Runner and Hunter) so they have project-specific knowledge like test credentials, seed data, and application quirks.

If `furtherSetup` is not accessible, continue without it but note this to the operator.

## Execution

Follow the browser-test skill (`skills/browser-test/SKILL.md`) starting from the Setup Phase. The skill will load `.browser-tests.json` automatically (step 0), then proceed through all phases as documented.

When substituting template variables in teammate prompts, use the values from `.browser-tests.json`. Use `{directory}` in place of `browser-tests` wherever paths are constructed.
