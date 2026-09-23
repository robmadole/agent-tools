#!/usr/bin/env bun
// Self-check for checks.js. Run: bun scripts/checks-selftest.js
//
// The node shapes below are what parseSnapshot produces from a real `ariaSnapshot({ mode: "ai" })`:
//
//   - button "Target" [ref=e2]
//   - button "Blocked" [disabled] [ref=e3]
//   - checkbox "Subscribe" [checked] [ref=e5]
//   - checkbox "Newsletter" [ref=e7]
//   - textbox "Email" [disabled] [ref=e8]
//
// Only the non-default state is marked, so an absent flag is the answer, not missing information.
import assert from "assert";
import { LITERAL_CHECKS, matchFirst } from "./checks.js";

const node = (role, name, ...flags) => ({ role, name, flags, value: "", ref: "e1" });
const OBS = {
  url: "https://ba.test:8800/dev/web-awesome",
  title: "Web Awesome",
  text: "Target Blocked Subscribe Newsletter",
  nodes: [
    node("button", "Target"),
    node("button", "Blocked", "[disabled]"),
    node("checkbox", "Subscribe", "[checked]"),
    node("checkbox", "Newsletter"),
    node("textbox", "Email", "[disabled]"),
    node("heading", "Blocked"),
  ],
};

const run = (step, obs = OBS) => {
  const hit = matchFirst(LITERAL_CHECKS, step);
  assert.ok(hit, `no LITERAL_CHECK matched: ${step}`);
  return hit[1](hit[0], obs);
};

let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };
const expect = (step, want) => {
  const got = run(step);
  assert.strictEqual(got.ok, want, `${step}\n  expected ok=${want}, got ok=${got.ok} (${got.miss})`);
};

// --- the truth table: flag present/absent x the four words --------------------------------------
expect('the "Target" button should be enabled', true);
expect('the "Target" button should be disabled', false);
expect('the "Blocked" button should be disabled', true);
expect('the "Blocked" button should be enabled', false);
ok("an absent [disabled] reads as enabled, a present one as disabled");

expect('the "Subscribe" checkbox should be checked', true);
expect('the "Subscribe" checkbox should be unchecked', false);
expect('the "Newsletter" checkbox should be unchecked', true);
expect('the "Newsletter" checkbox should be checked', false);
ok("an absent [checked] reads as unchecked, a present one as checked");

expect('the "Email" field should be disabled', true);
ok("a field carries [disabled] the same way a button does");

// --- the role filter keeps a same-named heading from answering for the button --------------------
// Without it the heading "Blocked" (no flags) is found first and the assertion flips.
const both = { ...OBS, nodes: [node("heading", "Blocked"), node("button", "Blocked", "[disabled]")] };
assert.strictEqual(run('the "Blocked" button should be disabled', both).ok, true);
ok("a heading sharing the name does not answer for the button");

// --- a missing element fails loudly rather than defaulting to enabled ---------------------------
const gone = run('the "Nonexistent" button should be enabled');
assert.strictEqual(gone.ok, false);
assert.match(gone.miss, /no button named "Nonexistent"/);
ok("an element that is not on the page fails, and says so");

// --- the whole point of the routing fix: these are assertions, not actions ----------------------
for (const step of ['I should see "Opened by the server"', 'the URL should contain "/dev"',
                    'the page title should be "Web Awesome"', 'the "Target" button should be enabled']) {
  assert.ok(matchFirst(LITERAL_CHECKS, step), `should route to outcomeStep: ${step}`);
}
// An action must NOT match, or it would be routed to the assertion path and never performed.
for (const step of ['I click the "Target" button', 'I fill "Email" with "a@b.c"',
                    'I am on the "Sign In" page', 'I press the "Enter" key']) {
  assert.ok(!matchFirst(LITERAL_CHECKS, step), `action wrongly matched an assertion: ${step}`);
}
ok("assertion phrasings match and action phrasings do not");

// --- the pre-existing checks still behave --------------------------------------------------------
expect('I should see "Target"', true);
expect('I should not see "Target"', false);
expect('I should see "nowhere"', false);
expect('I should not see "nowhere"', true);
expect('the URL should contain "/dev/web-awesome"', true);
expect('the page title should be "Web Awesome"', true);
ok("text, URL and title checks unchanged by the split");

console.log(`\n${checks} checks passed`);
