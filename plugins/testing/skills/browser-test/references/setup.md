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

**Reports** (optional): which reports each run produces — `["markdown"]`, `["visual"]`, or both. Leave the key out and runs produce the visual HTML report.

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

Leave out `runner` and `jev` for the Claude runner. Leave out `reports` to get the visual HTML report, which is the default; set `["markdown"]` or `["markdown", "visual"]` to change that.

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

### 5. Step helpers (optional, and grown rather than written up front)

`{directory}/playwright-helpers.js` maps step phrasings to Playwright code that runs them directly,
with no model request. Both runners load it: the Jev runner through `--helpers`, the Claude runner
through `page.__runStep`, which the plugin's `.mcp.json` preloads onto every page with
`--init-page`. The same function settles the step in both.

Do not write this file during setup. It is filled in by Phase 2c from what a real run spent model
requests on — a helper for a phrasing the suite does not actually use is wasted work, and one
written before a green run bakes in whatever was broken. A project with no such file still gets the
generic helpers.

Measured on a real 44-scenario suite, against the same specs and seed each time:

| | model requests | cost | wall clock | steps needing the model |
|---|---|---|---|---|
| before any of this | 300 | $0.0859 | 52.0s | 61% |
| generic helpers only | 118 | $0.0296 | 47.7s | 15% |
| plus **one** project helper | 47 | $0.0178 | 36.1s | 11% |

The shape of that table is the thing to take from it. The generic helpers cut requests and cost by
about two thirds and barely touched wall clock, because the model's sign-in chain still gated the
slowest workers. One helper for that chain cut requests by a further 60% and wall clock by 31%. The
first helper worth writing is whichever multi-step `Given` the suite repeats most.

The shape is a default-exported array of `[RegExp, function]` pairs, and nothing else — no imports,
so a plugin update can never break it:

```js
export default [
  // ctx.values holds this run's flattened `testdata:` output; ctx.base is the base URL,
  // ctx.routes the `jev.routes` map.
  [/^I am signed in as the admin for the exemplar$/i, async (page, m, ctx) => {
    await page.goto(ctx.base + "/sign-in");
    await page.getByLabel("Email").fill(ctx.values.admin_email);
    await page.getByLabel("Password").fill("password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/dashboard/);
  }],

  // Never hardcode an id from testdata: it differs every run.
  [/^I am on the guest-info page for the seeded reservation request$/i, (page, m, ctx) =>
    page.goto(`${ctx.base}/reservations/${ctx.values.reservation_request_id}/guest-info`)],
];
```

Rules that keep a helper from doing harm:

- **Throwing is how a helper says "not me."** A helper that throws — element missing, name ambiguous,
  timed out — sends that step to the model instead. It never fails the step. So a helper that falls
  out of date costs speed, never a wrong result, and there is no need to keep them in sync with the
  app defensively.
- **Project entries win.** They are matched before the generic ones, so to override a generic mapping
  that does not suit the app — a custom combobox where `selectOption` does nothing — add an entry
  with the same phrasing.
- **Write regexes loose**, with `(?:a|the)` and similar alternations. Absorbing wording drift in the
  regex is free; rewriting specs to match a strict one is not.
- **Commit it.** It is project knowledge, like `setup.md`, not a cache — and unlike a recorded test it
  is one definition per phrasing, not one per scenario.
