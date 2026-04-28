# Scripted Test Creation

Contract for authoring `@playwright/test` files that act as a **disposable cache** for `.feature` specs. The `.feature` file is always the source of truth; the JS file is a fast-path optimization, regenerated whenever the feature file changes.

## When to author one

Only at the end of a `/browser-test` run, in response to the operator accepting the Script Generation Offer (see SKILL.md). Never speculatively — every script you write must correspond to a feature file that just ran agentically with all scenarios passing. The skill orchestrator handles the prompt; this document tells you how to write the file once the operator says yes.

## File location

Strict mirror of the feature file path. No exceptions — the runner derives the cache path by string substitution.

| Feature file                                          | Script file                                          |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `{directory}/specs/sign-in/manager.feature`           | `{directory}/tests/sign-in/manager.js`               |
| `{directory}/specs/reservations/booking-flow.feature` | `{directory}/tests/reservations/booking-flow.js`     |
| `{directory}/specs/foo.feature`                       | `{directory}/tests/foo.js`                           |

If `{directory}/tests/<relative-path>` doesn't exist, the operator (or the orchestrator's `mkdir` setup step) creates it before writing.

## Module shape

```js
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BROWSER_TEST_BASE_URL;
if (!BASE_URL) {
  throw new Error('BROWSER_TEST_BASE_URL is required');
}

const data = JSON.parse(process.env.BROWSER_TEST_DATA || '{}');
```

- One `test('<scenario name>', async ({ page }) => { ... })` per Gherkin Scenario.
- **Scenario name must match the .feature file verbatim** — including punctuation and casing. The orchestrator maps Playwright Test results back to scenarios by name; a typo means the runner reports a missing scenario rather than a pass/fail.
- Background steps go in `test.beforeEach(async ({ page }) => { ... })`.
- Use `test.describe('<Feature name>', () => { ... })` to wrap all tests in the file. The Feature name must match the `Feature:` line in the .feature file verbatim.

## Inputs

You get exactly two inputs at runtime, both via env vars:

- `process.env.BROWSER_TEST_BASE_URL` — required. Throw at module load if missing.
- `process.env.BROWSER_TEST_DATA` — JSON string of the resolved testdata scope. Top-level keys are whatever the `testdata:` directives produced (e.g. `location_id`, `admin_email`, `admin_password`, `guest_email`, `guest_password`). Default to `{}` if unset, but in practice the orchestrator always passes it.

**Never hardcode** credentials, IDs, slugs, URLs, emails, or anything else that varies per run. If the value should come from testdata and you don't see it in `data`, the feature file is missing a `testdata:` directive — fix that first rather than working around it in the script.

## Step → Playwright Test mapping

This is the same translation table the agentic runner uses. Mirror it so the JS reads like the .feature.

| Gherkin step                          | Playwright Test                                                |
| ------------------------------------- | -------------------------------------------------------------- |
| `Given I am on the "X" page`          | `await page.goto(BASE_URL + '<path-for-X>');`                  |
| `When I click the "X" button`         | `await page.getByRole('button', { name: 'X' }).click();`       |
| `When I click the "X" link`           | `await page.getByRole('link', { name: 'X' }).click();`         |
| `When I fill in "X" with "Y"`         | `await page.getByLabel('X').fill('Y');`                        |
| `When I fill in "X" with the admin email` | `await page.getByLabel('X').fill(data.admin_email);`       |
| `Then I should see "X"`               | `await expect(page.getByText('X')).toBeVisible();`             |
| `Then I should be on the "X" page`    | `await expect(page).toHaveURL(/<regex-for-X>/);`               |
| `Given I am signed in as the admin manager` | sign-in helper (see below) using `data.admin_email` / `data.admin_password` |

For "I am signed in as X" steps that recur across files, write a helper inside the file (not extracted yet — extraction is a future concern):

```js
async function signInAs(page, email, password) {
  await page.goto(BASE_URL + '/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
```

Prefer Playwright's role/label/text locators over CSS selectors. They survive style changes and read like the spec.

## What not to do

- **No fixtures pulled from the project filesystem** beyond `/tmp/browser-tests/`. If a scenario uploads a file, generate it inline (`Buffer.from(...)`) or write to `/tmp/browser-tests/<name>` first.
- **No `.env` reads, no `dotenv`, no config files.** Env vars come from the orchestrator only.
- **No `test.describe.serial`, `test.describe.parallel`, or worker tweaks.** Default settings are fine; the orchestrator runs files in parallel at the file level, not within a file.
- **No custom reporters.** The orchestrator invokes with `--reporter=json` and parses stdout.
- **No `page.pause()`, no `test.only`, no `test.skip` left in.** These break unattended runs.
- **No writes outside `/tmp/browser-tests/`.** Test artifacts go there, never into the project directory.
- **No `console.log` for status.** It pollutes the JSON reporter output. Use `expect` assertions instead.

## Annotated example

Feature file: `browser-tests/specs/sign-in/manager.feature`

```gherkin
Feature: Manager sign-in
  testdata: create location "Test Camp" --with-admin

  A manager should be able to sign in with their email and password.

  Background:
    Given I am on the "Sign In" page

  Scenario: Successful sign-in
    When I fill in "Email" with the admin manager email
    And I fill in "Password" with the admin manager password
    And I click the "Sign In" button
    Then I should be on the "Dashboard" page

  Scenario: Wrong password shows error
    When I fill in "Email" with the admin manager email
    And I fill in "Password" with "nope"
    And I click the "Sign In" button
    Then I should see "Incorrect email or password"
```

Generated script: `browser-tests/tests/sign-in/manager.js`

```js
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BROWSER_TEST_BASE_URL;
if (!BASE_URL) {
  throw new Error('BROWSER_TEST_BASE_URL is required');
}

// data.admin_email / data.admin_password come from `testdata: create location "Test Camp" --with-admin`
const data = JSON.parse(process.env.BROWSER_TEST_DATA || '{}');

test.describe('Manager sign-in', () => {
  test.beforeEach(async ({ page }) => {
    // Background: Given I am on the "Sign In" page
    await page.goto(BASE_URL + '/sign-in');
  });

  // Scenario name matches the .feature verbatim — required for result mapping
  test('Successful sign-in', async ({ page }) => {
    await page.getByLabel('Email').fill(data.admin_email);
    await page.getByLabel('Password').fill(data.admin_password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('Wrong password shows error', async ({ page }) => {
    await page.getByLabel('Email').fill(data.admin_email);
    await page.getByLabel('Password').fill('nope');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByText('Incorrect email or password')).toBeVisible();
  });
});
```

## Self-check before saving

Before finishing the file, verify each item. If any fails, fix before writing:

- [ ] `test.describe(...)` name matches `Feature:` line verbatim.
- [ ] One `test(...)` per Scenario; names match Scenario names verbatim (case, punctuation, whitespace).
- [ ] Background steps are in `test.beforeEach`, not duplicated into each test.
- [ ] `BASE_URL` is sourced from `process.env.BROWSER_TEST_BASE_URL` and validated at module load.
- [ ] All credentials/IDs/emails come from `data.<key>`. No hardcoded user data.
- [ ] No `test.only`, no `test.skip`, no `page.pause()`, no `console.log`.
- [ ] No imports beyond `@playwright/test` and Node built-ins (`fs`, `path`, etc.) — no project source, no helper modules.
- [ ] No writes outside `/tmp/browser-tests/`.
