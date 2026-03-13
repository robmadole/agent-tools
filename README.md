# agent-tools

A [Claude Code](https://claude.ai/code) plugin marketplace package providing testing and QA tools.

## Installation

```bash
npx skills add /path/to/agent-tools
```

## Plugins

### testing

Tools for developing and testing software.

| Skill | Description |
|-------|-------------|
| **browser-test** | Orchestrate QA browser testing via Gherkin specs using Claude Agent Teams. Invoked via `/browser-test-setup`, `/browser-test-create`, `/browser-test-run`. |
| **jit-catch** | Generate catching tests for Elixir code changes to surface unintended behavioral regressions before they land. |

## Development

Prerequisites: [mise](https://mise.jdx.dev/)

```bash
mise install        # install tooling (lefthook)
lefthook install    # activate pre-commit hooks
```

The pre-commit hooks automatically:

- Create/update skill symlinks in `skills/` (`deploy-skills.sh`)
- Bump plugin patch versions when plugin files change (`bump-plugin-versions.sh`)
