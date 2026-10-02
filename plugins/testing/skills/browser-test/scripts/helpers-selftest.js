#!/usr/bin/env bun
// Self-check for helpers.js, against the same fixture page the Jev runner uses.
// Run: bun scripts/helpers-selftest.js
//
// The load-bearing invariant: a helper can only succeed or defer. Every "defers" case below is a case where a
// weaker design would have failed a step instead — an ambiguous name, a missing element, a route the project
// hasn't mapped. If one of those starts returning true, a stale helper can fail a passing test.

import assert from "assert";
import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { GENERIC, runStep, loadHelpers } from "./helpers.js";

// Served over HTTP rather than read as file://, so a root-relative path in a step ("/app.html") resolves the
// way it would against a real app. Against a file:// base it would resolve to the filesystem root.
const PAGE = fs.readFileSync(path.join(import.meta.dir, "jev-fixture", "app.html"));
const server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
const FIXTURE = `http://127.0.0.1:${server.port}/app.html`;
const CTX = { base: FIXTURE, routes: { "Sign In": "/app.html", Dashboard: "/dashboard" }, values: {} };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

let n = 0;
const fresh = async () => {
  await page.goto(FIXTURE);
  await page.evaluate(() => {
    document.querySelectorAll("main")[0].hidden = false;
    document.querySelectorAll("main")[1].hidden = true;
  });
};
const check = async (label, step, want, before) => {
  await fresh();
  if (before) await before();
  const got = await runStep(page, step, CTX);
  assert.strictEqual(got, want, `${label}: ${step} -> ${got}, wanted ${want}`);
  n++;
};

// --- the happy path: these are the steps that stop costing a model request --------------------------------
await check("fill by label", 'When I fill in "Email" with "user@example.com"', true);
assert.strictEqual(await page.getByLabel("Email").inputValue(), "user@example.com");

await check("click a button", 'When I click the "Sign in" button', true);
await check("native select", 'When I select "Pro" from the "Plan" dropdown', true, async () => {
  await page.evaluate(() => {
    document.querySelectorAll("main")[0].hidden = true;
    document.querySelectorAll("main")[1].hidden = false;
  });
});
await check("checkbox", 'When I check the "Agree to terms" checkbox', true, async () => {
  await page.evaluate(() => {
    document.querySelectorAll("main")[0].hidden = true;
    document.querySelectorAll("main")[1].hidden = false;
  });
});
await check("clear a field", 'When I clear the "Email" field', true);
await check("goto by route", 'Given I am on the "Sign In" page', true);
// A quoted path must navigate, not get looked up in the route map and deferred. One regex covers page names
// and paths both, because matchFirst stops at the first match and a second entry would be dead code.
await check("goto by path", 'Given I am on the page at "/app.html"', true);
await check("navigate to a path", 'When I navigate to "/app.html"', true);
await check("page load", "Given the page has fully loaded", true);
// The guide documents `I hover over the "Profile" menu`; a trailing noun used to stop the regex matching at all.
await check("hover with a trailing noun", 'When I hover over the "Sign in" button', true);
await check("assert a button is visible", 'Then I should see the "Sign in" button', true);
// A real-app run found `I should see the "X" heading` to be the most common step still paying for a model
// request — it is in the gherkin guide's vocabulary and the table did not cover `heading`.
await check("assert a heading is visible", 'Then I should see the "Sign in" heading', true);
await check("assert a button is absent", 'Then I should not see the "Delete account" button', true);
await check("field holds a value", 'Then the "Email" field should contain "a@b.c"', true, () =>
  page.getByLabel("Email").fill("a@b.c"));

// --- defers: every one of these must route to the model rather than fail ----------------------------------
await check("no helper matches", "When I do something nobody wrote a helper for", false);
await check("element is missing", 'When I click the "Nonexistent" button', false);
await check("route is unmapped", 'Given I am on the "Billing History" page', false);
await check("field is missing", 'When I fill in "Nickname" with "x"', false);
await check("assertion does not hold", 'Then the "Email" field should contain "wrong"', false, () =>
  page.getByLabel("Email").fill("a@b.c"));

// An ambiguous accessible name is the case that makes inexact matching safe to use: Playwright strict mode
// throws, so the step defers instead of clicking whichever one happened to be first in the DOM.
await check("ambiguous name defers", 'When I click the "Duplicate" button', false, () =>
  page.evaluate(() => {
    const m = document.querySelectorAll("main")[0];
    m.insertAdjacentHTML("beforeend", "<button>Duplicate</button><button>Duplicate</button>");
  }));

// A custom widget that isn't a native <select> can't be driven by selectOption. It must defer so the project
// can shadow the entry, or the model can drive it.
await check("custom combobox defers", 'When I select "Pro" from the "Tier" dropdown', false, () =>
  page.evaluate(() => {
    const m = document.querySelectorAll("main")[0];
    m.insertAdjacentHTML("beforeend", '<div role="combobox" aria-label="Tier">Free</div>');
  }));

// A miss must be cheap. Candidates are unioned with .or() and gated behind an instant count(), so a step whose
// element isn't there defers in milliseconds. Try the candidates in sequence with a timeout each instead and
// every step headed for the model gets seconds slower — the regression this guards against.
{
  await fresh();
  const t = Date.now();
  assert.strictEqual(await runStep(page, 'When I click the "Nowhere" button', CTX), false);
  assert.strictEqual(await runStep(page, 'When I click "Nowhere"', CTX), false); // no noun: two roles unioned
  assert.strictEqual(await runStep(page, 'When I fill in "Nowhere" with "x"', CTX), false); // three candidates
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `three misses took ${ms}ms; expected well under 1s (are candidates awaited in sequence?)`);
  n += 3;
}

// --- exact before substring -------------------------------------------------------------------------------
// Reproduces the real failure this was built for: a login form with `textbox "Password *"` next to
// `button "Show password"`. Substring matching on the label finds both and strict mode defers every Password
// fill; the exact label text "Password" finds one. Probing exact first is what rescues it.
{
  await fresh();
  // On the dashboard pane, which has no password field of its own, so the counts below are only the two
  // elements this injects. Mirrors the real markup: the asterisk sits outside the <label>, so the label text is
  // exactly "Password" while the field's accessible name is "Password *".
  await page.evaluate(() => {
    const [signin, dashboard] = document.querySelectorAll("main");
    signin.hidden = true;
    dashboard.hidden = false;
    dashboard.insertAdjacentHTML("beforeend",
      '<div><label for="pw2">Password</label><span>*</span><input id="pw2" type="text">' +
      '<button aria-label="Show password">eye</button></div>');
  });
  // As field() sees them: visible-filtered, because getByLabel also counts elements that aren't displayed
  // (the sign-in pane's own password input is still in the DOM, just hidden).
  const v = (l) => l.filter({ visible: true });
  assert.strictEqual(await v(page.getByLabel("Password")).count(), 2, "fixture reproduces the collision");
  assert.strictEqual(await v(page.getByLabel("Password", { exact: true })).count(), 1, "exact picks out the field");
  assert.strictEqual(await runStep(page, 'When I fill in "Password" with "s3cret"', CTX), true,
    "exact label match disambiguates where substring cannot");
  assert.strictEqual(await page.locator("#pw2").inputValue(), "s3cret", "and it filled the input, not the button");
  n += 4;
}

// A field hidden in a collapsed section must not make a fill on the visible one look ambiguous. getByLabel is a
// DOM lookup and counts both, so field() filters to visible.
{
  await fresh();
  await page.evaluate(() => {
    document.querySelectorAll("main")[0].insertAdjacentHTML("beforeend",
      '<div hidden><label for="e2">Email</label><input id="e2"></div>');
  });
  assert.strictEqual(await page.getByLabel("Email").count(), 2, "both are in the DOM");
  assert.strictEqual(await runStep(page, 'When I fill in "Email" with "visible@example.com"', CTX), true,
    "a hidden duplicate must not cause a defer");
  assert.strictEqual(await page.locator("#e2").inputValue(), "", "the hidden one was left alone");
  n += 3;
}

// --- unquoted testdata references -------------------------------------------------------------------------
// The gherkin guide's one exception to quoting values: `with the test identity email`. Resolution must be
// unambiguous or defer — filling the wrong value silently is worse than paying for a model request.
{
  await fresh();
  const withValues = (values) => ({ ...CTX, values });

  assert.strictEqual(
    await runStep(page, 'When I fill in "Email" with the test identity email',
      withValues({ email: "ada@example.com", password: "pw" })), true);
  assert.strictEqual(await page.getByLabel("Email").inputValue(), "ada@example.com");
  n += 2;

  // Every word of the key must appear in the reference, so admin_email answers and guest_email does not.
  await fresh();
  assert.strictEqual(
    await runStep(page, 'When I fill in "Email" with the admin manager email',
      withValues({ admin_email: "root@example.com", guest_email: "g@example.com" })), true);
  assert.strictEqual(await page.getByLabel("Email").inputValue(), "root@example.com");
  n += 2;

  // `work_email` does NOT answer "the email", because its word "work" is absent — so that case resolves
  // cleanly to `email` rather than deferring.
  await fresh();
  assert.strictEqual(
    await runStep(page, 'When I fill in "Email" with the email',
      withValues({ email: "a@b.c", work_email: "d@e.f" })), true, "a key needing an absent word does not compete");
  assert.strictEqual(await page.getByLabel("Email").inputValue(), "a@b.c");
  n += 2;

  // Real ambiguity is one key whose words are a subset of another's: both fully answer the reference.
  await fresh();
  assert.strictEqual(
    await runStep(page, 'When I fill in "Email" with the identity email',
      withValues({ email: "a@b.c", "identity email": "d@e.f" })), false, "two keys both answering it defers");
  // No key answers at all -> defer, and never type the reference text itself into the field.
  assert.strictEqual(
    await runStep(page, 'When I fill in "Email" with the nonexistent thing',
      withValues({ email: "a@b.c" })), false, "unresolvable reference defers");
  assert.strictEqual(await page.getByLabel("Email").inputValue(), "", "field untouched by a deferred fill");
  n += 3;

  // A quoted value still takes the literal path, unaffected by any of the above.
  await fresh();
  assert.strictEqual(await runStep(page, 'When I fill in "Email" with "literal@example.com"', CTX), true);
  assert.strictEqual(await page.getByLabel("Email").inputValue(), "literal@example.com");
  n += 2;
}

// --- project table: first match wins, so a project overrides a generic mapping -----------------------------
{
  await fresh();
  let called = false;
  const project = [[/^I click the "([^"]+)" button$/i, async (p, m) => { called = true; }]];
  const got = await runStep(page, 'When I click the "Sign in" button', CTX, project);
  assert.strictEqual(got, true, "project helper ran");
  assert.ok(called, "project entry shadowed the generic one");
  n++;
}

// A throwing project helper is a defer, not a crash — runStep never throws.
{
  await fresh();
  const project = [[/^I explode$/i, () => { throw new Error("boom"); }]];
  assert.strictEqual(await runStep(page, "When I explode", CTX, project), false);
  n++;
}

// A helper returning false says "matched, but I can't answer this" — also a defer.
{
  await fresh();
  const project = [[/^I decline$/i, () => false]];
  assert.strictEqual(await runStep(page, "When I decline", CTX, project), false);
  n++;
}

// --- loadHelpers --------------------------------------------------------------------------------------
assert.deepStrictEqual(await loadHelpers(null), [], "no file configured");
assert.deepStrictEqual(await loadHelpers("/nonexistent/playwright-helpers.js"), [], "missing file is normal");
n += 2;

// Every generic entry is a [RegExp, function] pair — a malformed table breaks matchFirst at runtime.
for (const [re, fn] of GENERIC) {
  assert.ok(re instanceof RegExp, `generic entry has a RegExp: ${re}`);
  assert.strictEqual(typeof fn, "function", `generic entry has a function: ${re}`);
}
n++;

await browser.close();
server.stop();
console.log(`helpers-selftest: ${n} checks passed (${GENERIC.length} generic helpers)`);
