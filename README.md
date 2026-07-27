# agent-tools

A [Claude Code](https://claude.ai/code) plugin marketplace package for software engineering disciplines.

## Installation

In Claude Code:

```
claude plugin marketplace add robmadole/agent-tools
```

```
claude plugin install testing@agent-tools
claude plugin install develop@agent-tools
claude plugin install quality@agent-tools
```

Using open agent skills (for other Agents):

```bash
npx skills add robmadole/agent-tools
```

## Plugins

### testing

Testing tools for developing software.

| Skill | Description |
|-------|-------------|
| **browser-test** | Orchestrate QA browser testing via Gherkin specs and Playwright MCP (up to 3 parallel instances). Run `/browser-test` in `create` mode (generate specs from a PR/feature) or `run` mode (execute existing specs). |
| **bug-hunter** | Time/count-boxed bug hunt against a feature branch, combining code reading with live browser verification, ending in a scored report. |
| **jit-catch** | Generate catching tests for Elixir code changes to surface unintended behavioral regressions before they land. |

### develop

Tools for writing code during development.

| Skill | Description |
|-------|-------------|
| **hobgoblin** | Examine similar files for consistency violations and produce a list of differences. |

### quality

Tools for reviewing code quality.

| Skill | Description |
|-------|-------------|
| **deskcheck** | Local, interactive PR review: splits a branch diff into sections and serves a web UI with resumable per-section "reviewed" state. |

## Development

Prerequisites: [mise](https://mise.jdx.dev/)

```bash
mise install        # install tooling (lefthook)
lefthook install    # activate pre-commit hooks
```

The pre-commit hooks automatically:

- Create/update skill symlinks in `skills/` (`deploy-skills.sh`)
- Bump plugin patch versions when plugin files change (`bump-plugin-versions.sh`)
