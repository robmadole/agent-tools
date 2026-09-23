# Browser Test Setup

Configure the browser testing environment for this project by creating a `.browser-tests.json` configuration file at the repository root.

## Steps

### 1. Check for existing configuration

Look for `.browser-tests.json` in the repository root. If it already exists, read it and show the current configuration to the operator. Ask if they want to update it or start fresh.

### 2. Gather configuration

Ask the operator for the following:

**Base URL** (required): The base URL of the running application (e.g., `http://localhost:8080`).

**Directory** (optional, default: `browser-tests`): The directory where specs and results are stored, relative to the repository root.

**Runner** (optional, default: `claude`): `claude` runs every scenario with a Claude subagent driving Playwright MCP. `jev` runs every scenario first with `scripts/jev-run.js`, which uses TypeSafe's Jev model. That's several times faster and uses no Claude tokens. Only the scenarios Jev can't settle go to Claude subagents. `jev` needs Google Chrome and a TypeSafe API key.

**Reports** (optional): which reports each run produces — `["markdown"]`, `["visual"]`, or both. Leave the key out and the operator is asked at the start of every run.

- `markdown` — the familiar `{directory}/results/*.md` report.
- `visual` — one self-contained HTML page per run: a screenshot of every step, laid out as a filmstrip per scenario, with failures marked and un-run steps drawn as empty frames. Click any frame for the full-resolution image. Everything is embedded, so the file travels on its own.

`visual` costs a screenshot and a record call on every step. Under the Jev runner that is a few milliseconds and no tokens; under the Claude runner it is two extra tool calls per step. A run of ~120 steps produces a 15-20MB HTML file, which `gzip -9` cuts by about a quarter.

### 3. Write `.browser-tests.json`

Create the configuration file at the repository root:

```json
{
  "directory": "<directory>",
  "baseURL": "<base URL>",
  "furtherSetup": "<directory>/setup.md",
  "reports": ["markdown", "visual"],
  "runner": "jev",
  "jev": {
    "routes": { "Sign In": "/sessions/sign-in", "Search": "/search" },
    "values": { "password": "password", "free account email": "free@example.com" },
    "envFile": ".env"
  }
}
```

Leave out `runner` and `jev` for the Claude runner, and `reports` to be asked each run.

The `furtherSetup` property is a path (relative to the repository root) to a file that documents project-specific testing context — things like test user credentials, seed data, special application states, or anything else that helps execute tests effectively.

### 3b. Fill in `jev` (Jev runner only)

A Claude runner reads `furtherSetup` and works out routes and credentials itself. Jev can't read prose, so write that knowledge down once. To switch an existing project to the Jev runner, do only this step and set `"runner": "jev"`.

- **`routes`**: every page name the specs use in `I am on the "X" page`, mapped to its path.
  - Collect the names with `grep -oh 'I am on the "[^"]*" page' {directory}/specs -r`.
  - Take the paths from `furtherSetup` or the app's router.
  - Quoted paths such as `I am on the "/search?q=x" page` need no entry.
- **`values`**: the credentials and fixture values specs refer to without quoting, labeled so a step's wording matches them.
  - Examples: `"password"`, `"free account email"`, `"admin email"`.
  - Take them from `furtherSetup`.
  - Values created by `testdata:` directives are added per run, so leave them out.
- **`envFile`** (optional): a gitignored file containing `TYPESAFE_API_KEY=…`, for when the key isn't exported in the environment.

Show the operator the routes and values before writing them.

### 4. Initialize directories

Create the directory structure if it doesn't exist:

```bash
mkdir -p {directory}/specs {directory}/results {directory}/tmp
```

`{directory}/tmp` holds runner scratch files (screenshots, upload fixtures). It
must be gitignored — check with `git check-ignore -q {directory}/tmp` and append
`{directory}/tmp/` to the project's `.gitignore` if that exits non-zero.
