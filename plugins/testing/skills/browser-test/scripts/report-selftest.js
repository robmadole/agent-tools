#!/usr/bin/env bun
// Self-check for report.js. Run: bun scripts/report-selftest.js
//
// The load-bearing case is `incomplete`: a runner that stops early must never read as green.
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { Database } from "bun:sqlite";

const HERE = import.meta.dir;
const REPORT = path.join(HERE, "report.js");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "report-selftest-"));
const RUN = path.join(ws, "run-01");
const SPEC = path.join(ws, "credentials.feature");

fs.writeFileSync(SPEC, `Feature: Sign in
  testdata: create location "Test Camp" --with-admin

  Background:
    Given I am on the "/sessions/sign-in" page
    And the banner should not be visible

  Scenario: Valid credentials
    When I fill "Email" with "free@example.com"
    Then I should see "Dashboard"

  Scenario: Wrong password
    When I fill "Email" with "nobody@example.com"
    Then I should see "Invalid email or password"

  Scenario: Never reached
    When I click "Forgot password"
    Then I should see "Reset your password"

  Scenario Outline: Bad input
    When I fill "Email" with "<email>"
    Then I should see "<message>"

    Examples:
      | email    | message           |
      | a@b.com  | Invalid           |
      |          | Email is required |
`);

const run = (args) => {
  const p = Bun.spawnSync(["bun", REPORT, ...args]);
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  assert.strictEqual(p.exitCode, 0, `exit ${p.exitCode} for ${args.join(" ")}\n${err}`);
  return out;
};
const record = (scenario, step, status, extra = []) =>
  run(["record", "--run", RUN, "--feature", SPEC, "--scenario", scenario,
       "--step", step, "--status", status, ...extra]);
const summary = () => JSON.parse(run(["summary", "--run", RUN, "--steps"]));
const find = (s, name) => s.features[0].scenarios.find((x) => x.name === name);

const BG = ['Given I am on the "/sessions/sign-in" page', "And the banner should not be visible"];
let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };

// --- init -------------------------------------------------------------------------------------
const initOut = JSON.parse(run(["init", "--run", RUN, SPEC]));
assert.strictEqual(initOut.features, 1);
// 3 plain scenarios + 2 Outline rows, each 2 background + 2 own steps.
assert.strictEqual(initOut.scenarios, 5, `expected 5 scenarios, got ${initOut.scenarios}`);
assert.strictEqual(initOut.steps, 20, `expected 20 steps, got ${initOut.steps}`);
ok("init expands Outline rows and inlines Background into every scenario");

const db = new Database(path.join(RUN, "run.db"));
assert.strictEqual(
  db.query("SELECT COUNT(*) c FROM expected WHERE origin = 'background'").get().c, 10);
assert.strictEqual(
  db.query("SELECT command FROM testdata").get().command, 'create location "Test Camp" --with-admin');
ok("Background steps tagged, testdata: lifted out of the feature description");
db.close();

// --- a fully recorded scenario is the only thing that goes green ---------------------------------
const shot = path.join(ws, "shot.png");
fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
for (const s of [...BG, 'When I fill "Email" with "free@example.com"', 'Then I should see "Dashboard"']) {
  record("Valid credentials", s, "passed", ["--screenshot", shot, "--runner", "jev"]);
}
assert.strictEqual(find(summary(), "Valid credentials").verdict, "passed");
ok("every expected step recorded and passing -> passed");

// --- THE HOLE: 3 of 4 steps, none failed, must not be green -------------------------------------
for (const s of [...BG, 'When I fill "Email" with "nobody@example.com"']) {
  record("Wrong password", s, "passed");
}
const wrong = find(summary(), "Wrong password");
assert.strictEqual(wrong.verdict, "incomplete",
  `a runner that stopped at 3 of 4 reported "${wrong.verdict}"`);
assert.strictEqual(wrong.recorded_steps, 3);
assert.strictEqual(wrong.expected_steps, 4);
assert.strictEqual(wrong.steps[3].status, "not_recorded");
ok("runner stops at 3 of 4 -> incomplete, with a ghost frame for the missing step");

// --- a scenario with no records at all ----------------------------------------------------------
assert.strictEqual(find(summary(), "Never reached").verdict, "not_run");
ok("scenario the runner never reached -> not_run");

// --- a real failure still reads as failed, and needs no skip records ----------------------------
record("Bad input (example 1)", BG[0], "passed");
record("Bad input (example 1)", BG[1], "failed", ["--reason", "banner still visible after 5s"]);
const bad1 = find(summary(), "Bad input (example 1)");
assert.strictEqual(bad1.verdict, "failed");
assert.strictEqual(bad1.failure_reason, "banner still visible after 5s");
assert.strictEqual(bad1.steps[2].status, "not_recorded");
ok("a failed step wins over a short record; skipped steps need no record");

// --- background failures cluster ----------------------------------------------------------------
record("Bad input (example 2)", BG[0], "passed");
record("Bad input (example 2)", BG[1], "failed", ["--reason", "banner still visible after 5s"]);
const clusters = summary().background_failures;
assert.strictEqual(clusters.length, 1, "the shared background failure should collapse to one");
assert.deepStrictEqual(clusters[0].scenarios.sort(), ["Bad input (example 1)", "Bad input (example 2)"]);
ok("one background step failing in 2 scenarios -> a single clustered finding");

// --- a re-run under a new run-id supersedes the old attempt -------------------------------------
for (const s of [...BG, 'When I fill "Email" with "nobody@example.com"',
                 'Then I should see "Invalid email or password"']) {
  record("Wrong password", s, "passed", ["--run-id", "repair-2", "--runner", "claude"]);
}
const repaired = find(summary(), "Wrong password");
assert.strictEqual(repaired.verdict, "passed", "the repair re-run should win");
assert.strictEqual(repaired.recorded_steps, 4, "the superseded attempt must not be counted too");
assert.strictEqual(repaired.runner, "claude");
ok("re-run under a new --run-id supersedes the earlier attempt rather than stacking");

// --- totals are computed, not counted by hand ---------------------------------------------------
const t = summary().totals;
assert.deepStrictEqual(
  { total: t.total, passed: t.passed, failed: t.failed, incomplete: t.incomplete, not_run: t.not_run },
  { total: 5, passed: 2, failed: 2, incomplete: 0, not_run: 1 });
assert.strictEqual(t.pass_rate, 40);
assert.deepStrictEqual(t.settled_by, { jev: 1, claude: 1, ...t.settled_by });
ok("totals, pass rate and settled_by come out of SQL, not out of counting");

// --- lane: how each step got settled, and the coverage number built from it ----------------------
// The repair re-run above recorded 4 steps with no --lane, so they must not be counted as either
// helper or model — an unreported lane is unknown, not "needed the model".
{
  const before = summary().totals;
  assert.deepStrictEqual(before.steps_by_lane, {}, "no lanes recorded yet");
  assert.strictEqual(before.model_free_rate, null, "no lanes means no rate, not 0%");

  for (const [s, lane] of [[BG[0], "helper"], [BG[1], "literal"],
                           ['When I fill "Email" with "nobody@example.com"', "helper"],
                           ['Then I should see "Invalid email or password"', "model"]]) {
    record("Wrong password", s, "passed", ["--run-id", "lane-1", "--runner", "jev", "--lane", lane]);
  }
  const t2 = summary().totals;
  assert.deepStrictEqual(t2.steps_by_lane, { helper: 2, literal: 1, model: 1 });
  assert.strictEqual(t2.model_free_rate, 75, "3 of 4 settled steps needed no model request");
  const steps = find(summary(), "Wrong password").steps;
  assert.strictEqual(steps[0].lane, "helper", "lane is reported per step, for Phase 2c to read");
  ok("lane records roll up into steps_by_lane and model_free_rate");
}

// --- a Phase 2b re-run that passes with nothing changed is inconsistent, and nobody has judged it yet --
{
  const w = find(summary(), "Wrong password");
  assert.strictEqual(w.inconsistent, true, "incomplete then passed, same runner, same spec text");
  assert.strictEqual(w.flaky, null, "inconsistent is not flaky until the orchestrator says so");
  ok("same-runner attempts that disagree on an unchanged spec -> inconsistent, flaky unjudged");
}

// --- focus pass, flaky flags, findings: their own run so the counts above stay what they are ------
const fails = (args) => {
  const p = Bun.spawnSync(["bun", REPORT, ...args]);
  assert.notStrictEqual(p.exitCode, 0, `expected ${args[0]} to refuse: ${args.join(" ")}`);
  return p.stderr.toString();
};
{
  const R2 = path.join(ws, "run-focus");
  run(["init", "--run", R2, SPEC]);
  const rec = (scenario, step, status, extra = []) =>
    run(["record", "--run", R2, "--feature", SPEC, "--scenario", scenario, "--step", step, "--status", status,
         ...extra]);
  const sum = (lean = false) => JSON.parse(run(["summary", "--run", R2, ...(lean ? [] : ["--steps"])]));
  const sc = (s, name) => s.features[0].scenarios.find((x) => x.name === name);
  const VALID = [...BG, 'When I fill "Email" with "free@example.com"', 'Then I should see "Dashboard"'];

  // The focus pass replays a passing scenario and it fails this time. The verdict must not move.
  for (const s of VALID) rec("Valid credentials", s, "passed", ["--run-id", "claude-1"]);
  for (const s of VALID.slice(0, 3)) rec("Valid credentials", s, "passed", ["--run-id", "focus-1", "--pass", "focus"]);
  rec("Valid credentials", VALID[3], "failed", ["--run-id", "focus-1", "--pass", "focus", "--reason", "no Dashboard"]);
  let v = sc(sum(), "Valid credentials");
  assert.strictEqual(v.verdict, "passed", "a focus-pass record replaced the functional verdict");
  assert.strictEqual(v.recorded_steps, 4);
  assert.strictEqual(v.inconsistent, true);
  assert.deepStrictEqual(v.attempts.map((a) => [a.pass, a.verdict]), [["functional", "passed"], ["focus", "failed"]]);
  assert.strictEqual(v.attempts[1].failure_reason, "no Dashboard");
  ok("a focus-pass failure leaves the functional verdict alone and marks the scenario inconsistent");

  fails(["record", "--run", R2, "--feature", SPEC, "--scenario", "Valid credentials", "--step", VALID[0],
         "--status", "passed", "--pass", "replay"]);
  ok("--pass only takes functional or focus");

  // Jev failing and Claude passing is the fallback working, not a disagreement.
  rec("Wrong password", BG[0], "failed", ["--run-id", "jev-1", "--runner", "jev"]);
  for (const s of [...BG, 'When I fill "Email" with "nobody@example.com"', 'Then I should see "Invalid email or password"']) {
    rec("Wrong password", s, "passed", ["--run-id", "claude-1"]);
  }
  assert.strictEqual(sc(sum(), "Wrong password").inconsistent, false);
  ok("a Jev leftover that Claude passes is not inconsistent");

  // A repaired spec: the failed attempt recorded the old step text, so it tested something else.
  rec("Never reached", BG[0], "passed", ["--run-id", "claude-1"]);
  rec("Never reached", BG[1], "passed", ["--run-id", "claude-1"]);
  rec("Never reached", 'When I click "Forgot it"', "failed", ["--run-id", "claude-1"]);
  for (const s of [...BG, 'When I click "Forgot password"', 'Then I should see "Reset your password"']) {
    rec("Never reached", s, "passed", ["--run-id", "repair-1"]);
  }
  assert.strictEqual(sc(sum(), "Never reached").inconsistent, false);
  ok("attempts on different step text (a repaired spec) are not compared");

  // Flaky is recorded by hand, with a reason, and refuses a scenario that is not in the manifest.
  run(["flag", "--run", R2, "--feature", SPEC, "--scenario", "Valid credentials", "--flaky", "true",
       "--reason", "Dashboard rendered after the assertion; nothing changed between attempts"]);
  fails(["flag", "--run", R2, "--feature", SPEC, "--scenario", "Valid credentialz", "--flaky", "true"]);
  fails(["flag", "--run", R2, "--feature", SPEC, "--scenario", "Valid credentials", "--flaky", "maybe"]);
  let s2 = sum();
  v = sc(s2, "Valid credentials");
  assert.strictEqual(v.flaky, true);
  assert.match(v.flaky_reason, /after the assertion/);
  assert.strictEqual(s2.totals.flaky, 1);
  assert.strictEqual(s2.totals.inconsistent, 1);
  assert.deepStrictEqual(s2.inconsistent.map((i) => [i.scenario, i.flaky]), [["Valid credentials", true]]);
  run(["flag", "--run", R2, "--feature", SPEC, "--scenario", "Valid credentials", "--flaky", "false",
       "--reason", "testdata collision, fixed"]);
  assert.strictEqual(sc(sum(), "Valid credentials").flaky, false, "a later flag replaces the earlier one");
  ok("flag records flaky with a reason, replaces itself, and refuses unknown scenarios and values");

  // Findings: one by hand, and a batch straight from an axe.run() result.
  const F = ["--run", R2, "--feature", SPEC, "--scenario", "Valid credentials", "--run-id", "focus-1"];
  run(["finding", ...F, "--focus", "accessibility", "--step", VALID[2], "--rule", "focus-not-moved",
       "--impact", "serious", "--summary", "Focus stays on the submit button after the dialog opens",
       "--url", "http://localhost/sign-in?x=1", "--screenshot", shot]);
  fails(["finding", ...F, "--focus", "accessibility", "--step", VALID[2], "--rule", "r", "--impact", "huge",
         "--summary", "s"]);
  fails(["finding", "--run", R2, "--feature", SPEC, "--scenario", "Nope", "--focus", "accessibility",
         "--step", VALID[2], "--rule", "r", "--impact", "minor", "--summary", "s"]);
  const axeFile = path.join(ws, "axe.json");
  const axeResult = (url) => ({
    url,
    violations: [
      { id: "image-alt", impact: "critical", help: "Images must have alternate text", tags: ["cat.text-alternatives", "wcag2a", "wcag111"],
        nodes: [{ target: ["img.logo"], impact: "critical", failureSummary: "Element does not have an alt attribute" },
                { target: ["img.hero"], impact: "critical", failureSummary: "Element does not have an alt attribute" }] },
      { id: "region", impact: "moderate", help: "All page content should be contained by landmarks", tags: ["best-practice"],
        nodes: [{ target: ["p"], impact: "moderate" }] },
    ],
    incomplete: [{ id: "color-contrast", help: "Contrast", nodes: [{ target: ["p.lowc"], any: [{ message: "background overlapped" }] }] }],
  });
  fs.writeFileSync(axeFile, JSON.stringify(axeResult("http://localhost/sign-in")));
  const axeOut = JSON.parse(run(["finding", ...F, "--focus", "accessibility", "--step", VALID[0], "--from", axeFile]));
  assert.strictEqual(axeOut.recorded, 3, "one finding per violating node");
  assert.deepStrictEqual(axeOut.incomplete, [{ rule: "color-contrast", target: "p.lowc", message: "background overlapped" }]);
  // Same page reached again on a later transition, with a different query string: same findings, not new ones.
  fs.writeFileSync(axeFile, JSON.stringify(axeResult("http://localhost/sign-in?after=submit")));
  run(["finding", ...F, "--focus", "accessibility", "--step", VALID[2], "--from", axeFile]);
  fs.writeFileSync(axeFile, JSON.stringify([{ rule: "horizontal-overflow", impact: "serious", summary: "Page scrolls sideways at 320px",
                                              target: "div.wide", url: "http://localhost/sign-in" }]));
  run(["finding", ...F, "--focus", "responsive", "--step", VALID[0], "--from", axeFile]);

  s2 = sum();
  const g = s2.findings.groups;
  assert.strictEqual(s2.findings.recorded, 8);
  assert.strictEqual(s2.findings.total, 5, "8 rows collapse to 5 distinct findings");
  assert.strictEqual(s2.totals.findings, 5);
  assert.deepStrictEqual(g.map((x) => x.impact), ["critical", "critical", "serious", "serious", "moderate"],
    "most severe first");
  const alt = g.find((x) => x.target === "img.logo");
  assert.strictEqual(alt.occurrences.length, 2, "seen on two transitions");
  assert.strictEqual(alt.path, "/sign-in");
  assert.strictEqual(alt.source, "axe");
  assert.strictEqual(alt.wcag, "wcag2a wcag111");
  assert.deepStrictEqual(s2.findings.by_focus,
    { accessibility: { critical: 2, serious: 1, moderate: 1, minor: 0 },
      responsive: { critical: 0, serious: 1, moderate: 0, minor: 0 } });
  assert.strictEqual(g.find((x) => x.rule === "focus-not-moved").source, "judgment");
  assert.ok(g.find((x) => x.rule === "focus-not-moved").occurrences[0].has_png);
  ok("findings: by hand and from an axe.run() result, grouped by rule/path/target, most severe first");

  const leanAlt = JSON.parse(run(["summary", "--run", R2])).findings.groups.find((x) => x.target === "img.logo");
  assert.strictEqual(leanAlt.occurrence_count, 2);
  assert.ok(leanAlt.occurrences.length <= 3);
  ok("lean summary caps occurrences and keeps the count");

  if (fs.existsSync(path.join(HERE, "..", "assets", "template.html"))) {
    const out = path.join(ws, "focus.html");
    const built = JSON.parse(run(["build", "--run", R2, "--out", out]));
    const html = fs.readFileSync(out, "utf8");
    const data = JSON.parse(html.match(/const DATA = (.*);\n/)[1]);
    assert.strictEqual(data.findings.total, 5);
    assert.ok(data.images[data.findings.groups.find((x) => x.rule === "focus-not-moved").occurrences[0].img],
      "the finding's screenshot was not embedded");
    assert.ok(built.images >= 1);
    ok("build embeds findings and their screenshots");
  }

  // A shared header overflowing on three pages is one finding with three paths, not three findings. Without a
  // target the page is all there is, so those still split by path.
  for (const u of ["http://localhost/a", "http://localhost/b", "http://localhost/c"]) {
    run(["finding", ...F, "--focus", "responsive", "--step", VALID[0], "--rule", "horizontal-overflow", "--impact", "serious",
         "--summary", `Header overflows on ${u}`, "--target", "header.site", "--url", u, "--source", "measurement"]);
    run(["finding", ...F, "--focus", "accessibility", "--step", VALID[0], "--rule", "landmark-main", "--impact", "moderate",
         "--summary", "No main landmark", "--url", u]);
  }
  const g3 = sum().findings.groups;
  const header = g3.filter((x) => x.target === "header.site");
  assert.strictEqual(header.length, 1, "one group for one element across pages, whatever the summaries say");
  assert.deepStrictEqual(header[0].paths, ["/a", "/b", "/c"]);
  assert.strictEqual(header[0].source, "measurement");
  assert.strictEqual(g3.filter((x) => x.rule === "landmark-main").length, 3, "untargeted findings stay per page");
  fails(["finding", ...F, "--focus", "responsive", "--step", VALID[0], "--rule", "r", "--impact", "minor",
         "--summary", "s", "--source", "guess"]);
  ok("targeted findings group across pages; --source takes axe, measurement or judgment");

  // axe stops at shadow roots, and two of its "could not decide" kinds there were dropped by hand every time.
  fs.writeFileSync(axeFile, JSON.stringify({ url: "http://localhost/sign-in", violations: [], incomplete: [
    { id: "color-contrast", help: "Contrast", nodes: [{ target: [["wa-button", "button.base"]] }, { target: ["p.lowc"] }] },
    { id: "aria-valid-attr-value", help: "ARIA", nodes: [{ target: [["wa-select", "input.display"]] }] },
    { id: "label", help: "Label", nodes: [{ target: [["wa-input", "input"]] }] },
  ] }));
  const shadowOut = JSON.parse(run(["finding", ...F, "--focus", "accessibility", "--step", VALID[0], "--from", axeFile]));
  assert.strictEqual(shadowOut.incomplete_dropped, 2);
  assert.deepStrictEqual(shadowOut.incomplete.map((x) => x.target), ["p.lowc", "wa-input input"],
    "light-DOM contrast and other rules in shadow DOM still come back");
  ok("shadow-root contrast and aria-controls incompletes are dropped and counted");
}

// --- app text with replacement patterns, and --from items carrying their own scenario and screenshot ------
{
  const rd = path.join(ws, "dollar-run");
  run(["init", "--run", rd, SPEC]);
  const xdb = new Database(path.join(rd, "run.db"));
  const first = xdb.query("SELECT scenario, step FROM expected ORDER BY ordinal, position LIMIT 1").get();
  xdb.close();
  const reason = "Expected \"$5\" but saw $& and $' and $`";
  run(["record", "--run", rd, "--feature", SPEC, "--scenario", first.scenario, "--step", first.step,
       "--status", "failed", "--reason", reason]);
  const items = path.join(ws, "items.json");
  fs.writeFileSync(items, JSON.stringify([{ rule: "content-clipped", impact: "minor", summary: "Cut off", screenshot: shot }]));
  run(["finding", "--run", rd, "--feature", SPEC, "--scenario", first.scenario, "--step", first.step,
       "--focus", "responsive", "--from", items]);
  fs.writeFileSync(items, JSON.stringify([{ rule: "r", impact: "minor", summary: "s", scenario: "No such scenario" }]));
  fails(["finding", "--run", rd, "--feature", SPEC, "--scenario", first.scenario, "--step", first.step,
         "--focus", "responsive", "--from", items]);
  const out = path.join(ws, "dollar.html");
  run(["build", "--run", rd, "--out", out]);
  const data = JSON.parse(fs.readFileSync(out, "utf8").match(/const DATA = (.*);\n/)[1]);
  assert.ok(JSON.stringify(data).includes("saw $& and $' and $`"), "replacement patterns in app text survive build");
  const occ = data.findings.groups[0].occurrences[0];
  assert.ok(occ.img && data.images[occ.img].startsWith("data:image/png;base64,"), "an item's screenshot path is loaded as an image");
  ok("build keeps $& in app text; --from items are checked against the manifest and their screenshots loaded");
}

// --- runner: one pass's instructions, shared values filled in, per-runner ones left in braces -----------
{
  const dir = path.join(ws, "runner-proj");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "setup.md"), "Sign in as qa@example.com.");
  fs.writeFileSync(path.join(dir, ".browser-tests.json"),
    JSON.stringify({ directory: "browser-tests", baseURL: "http://localhost:4000", furtherSetup: "setup.md" }));
  const rd = path.join(ws, "runner-run");
  fs.mkdirSync(rd);
  const cfg = path.join(dir, ".browser-tests.json");
  const fn = JSON.parse(run(["runner", "--run", rd, "--pass", "functional", "--config", cfg, "--shots"]));
  const ftext = fs.readFileSync(fn.file, "utf8");
  assert.deepStrictEqual(fn.unfilled, [], "every shared value filled");
  assert.ok(ftext.includes("http://localhost:4000") && ftext.includes("Sign in as qa@example.com."));
  assert.ok(ftext.includes(`${rd}/shots/<slug>-<n>.png`), "screenshot instructions point at this run");
  assert.ok(ftext.includes("{playwright tool prefix}") && ftext.includes("{report command}"), "per-runner values left alone");
  const fo = JSON.parse(run(["runner", "--run", rd, "--pass", "focus", "--config", cfg, "--foci", "accessibility,responsive"]));
  const otext = fs.readFileSync(fo.file, "utf8");
  assert.deepStrictEqual(fo.unfilled, []);
  assert.ok(otext.includes("## Focus pass") && otext.includes("## Accessibility") && otext.includes("## Responsive design"));
  assert.ok(!/^name: /m.test(otext), "focus frontmatter stripped");
  assert.ok(otext.includes(path.join(rd, "focus")) && otext.includes("axe.min.js") && !otext.includes("{axe path}"));
  assert.ok(!otext.includes("browser_take_screenshot` with `type: \"png\"`, `scale: \"css\"`, and\n   `filename: \"" + rd + "/shots"),
    "no every-step screenshots in the focus pass");
  assert.ok(fs.existsSync(path.join(rd, "focus")));
  fails(["runner", "--run", rd, "--pass", "focus", "--config", cfg]);
  fails(["runner", "--run", rd, "--pass", "focus", "--config", cfg, "--foci", "nope"]);
  ok("runner writes each pass's instructions with shared values filled and per-runner ones left");
}

// --- claim: the run number is taken by creating the directory, so two runs can't share one --------------
{
  const dir = path.join(ws, "claim");
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  fs.writeFileSync(path.join(dir, "results", "2026-10-15-run-8.md"), "");
  const a = JSON.parse(run(["claim", "--dir", dir]));
  const b = JSON.parse(run(["claim", "--dir", dir]));
  assert.strictEqual(a.n, 9, "one past the highest report");
  assert.strictEqual(b.n, 10, "a second claim before any report is written still gets its own number");
  assert.ok(fs.existsSync(a.run) && fs.existsSync(b.run));
  ok("claim takes the next free run number, counting reports and claimed run dirs");
}

// --- a run.db from before pass/flags/findings existed takes the new records ----------------------
{
  const OLD = path.join(ws, "run-old");
  fs.mkdirSync(OLD);
  const odb = new Database(path.join(OLD, "run.db"), { create: true });
  odb.exec(`
    CREATE TABLE features (file TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE expected (feature TEXT NOT NULL, scenario TEXT NOT NULL, ordinal INTEGER NOT NULL,
      position INTEGER NOT NULL, step TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY (feature, scenario, position));
    CREATE TABLE testdata (feature TEXT NOT NULL, position INTEGER NOT NULL, command TEXT NOT NULL,
      status TEXT, output TEXT, PRIMARY KEY (feature, position));
    CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, run_id TEXT NOT NULL,
      runner TEXT NOT NULL, feature TEXT NOT NULL, scenario TEXT NOT NULL, step TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, png BLOB);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  odb.prepare("INSERT INTO features VALUES (?, ?)").run(SPEC, "Sign in");
  odb.prepare("INSERT INTO expected VALUES (?, ?, 0, 0, ?, 'scenario')").run(SPEC, "Only", "Given x");
  odb.close();
  run(["record", "--run", OLD, "--feature", SPEC, "--scenario", "Only", "--step", "Given x", "--status", "passed",
       "--pass", "focus"]);
  run(["flag", "--run", OLD, "--feature", SPEC, "--scenario", "Only", "--flaky", "true"]);
  run(["finding", "--run", OLD, "--feature", SPEC, "--scenario", "Only", "--step", "Given x", "--focus", "responsive",
       "--rule", "r", "--impact", "minor", "--summary", "s"]);
  const old = JSON.parse(run(["summary", "--run", OLD]));
  assert.strictEqual(old.features[0].scenarios[0].verdict, "not_run", "a focus-only record is not a verdict");
  assert.strictEqual(old.totals.flaky, 1);
  assert.strictEqual(old.findings.total, 1);
  ok("an older run.db is migrated in place: pass column, flags and findings tables");
}

// --- the default summary stays small enough to read into an orchestrator's context ---------------
const lean = JSON.parse(run(["summary", "--run", RUN]));
const leanScenario = lean.features[0].scenarios[0];
assert.strictEqual(leanScenario.steps, undefined, "per-step arrays should be omitted by default");
assert.strictEqual(typeof leanScenario.drifted_steps, "number");
assert.ok(leanScenario.verdict && "expected_steps" in leanScenario,
  "the verdict and counts must survive the trim");
assert.ok(run(["summary", "--run", RUN]).length < run(["summary", "--run", RUN, "--steps"]).length,
  "--steps should return more than the default");
ok("summary omits per-step detail unless --steps is passed");

// --- the other entry point: jev-run.js calls recordStep in-process with a Buffer ----------------
const INPROC = path.join(ws, "run-inproc");
run(["init", "--run", INPROC, SPEC]);
const { recordStep } = await import(REPORT);
const idb = new Database(path.join(INPROC, "run.db"));
idb.exec("PRAGMA busy_timeout = 10000");
for (const s of [...BG, 'When I fill "Email" with "free@example.com"', 'Then I should see "Dashboard"']) {
  recordStep(idb, { runId: "1", runner: "jev", feature: SPEC, scenario: "Valid credentials",
                    step: s, status: "passed", screenshot: fs.readFileSync(shot) });
}
idb.close();
const inproc = JSON.parse(
  Bun.spawnSync(["bun", REPORT, "summary", "--run", INPROC, "--steps"]).stdout.toString());
const viaImport = inproc.features[0].scenarios.find((s) => s.name === "Valid credentials");
assert.strictEqual(viaImport.verdict, "passed");
assert.ok(viaImport.steps.every((s) => s.has_png), "in-process Buffer screenshots were not stored");
ok("recordStep imported in-process produces the same records as the CLI");

// --- concurrent writers, the thing that killed the JSONL design ---------------------------------
const CONC = path.join(ws, "run-conc");
run(["init", "--run", CONC, SPEC]);
const writers = ["a", "b", "c"].map((tag) =>
  Bun.spawn(["bun", "-e", `
    const { spawnSync } = require("child_process");
    for (let i = 0; i < 12; i++) {
      spawnSync("bun", ["${REPORT}", "record", "--run", "${CONC}", "--feature", "${SPEC}",
        "--scenario", "Valid credentials", "--step", "step ${tag} " + i, "--status", "passed",
        "--screenshot", "${shot}"]);
    }`]));
await Promise.all(writers.map((w) => w.exited));
const cdb = new Database(path.join(CONC, "run.db"));
assert.strictEqual(cdb.query("SELECT COUNT(*) c FROM steps").get().c, 36, "lost writes under concurrency");
assert.strictEqual(cdb.query("PRAGMA integrity_check").get()["integrity_check"], "ok");
cdb.close();
ok("36 rows from 3 concurrent writer processes, integrity ok");

// --- phase ---------------------------------------------------------------------------------------
// Phase 1 runs before init, so phase has to be able to create the database on its own.
const PH = path.join(ws, "run-phase");
run(["phase", "--run", PH, "--name", "specs"]);
run(["init", "--run", PH, SPEC]);
run(["phase", "--run", PH, "--name", "execute"]);
const pdb = new Database(path.join(PH, "run.db"));
const meta = Object.fromEntries(pdb.query("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
assert.strictEqual(meta.phase, "execute");
assert.ok(Number(meta.phase_at) > 0, "phase_at should be a timestamp");
assert.ok(meta.initialized_at, "init after phase should still write its manifest");
assert.strictEqual(pdb.query("PRAGMA journal_mode").get().journal_mode, "wal");
pdb.close();
const bad = Bun.spawnSync(["bun", REPORT, "phase", "--run", PH, "--name", "lunch"]);
assert.notStrictEqual(bad.exitCode, 0, "an unknown phase name should be refused");
ok("phase creates run.db before init, overwrites the current phase, refuses unknown names");

// --- build ---------------------------------------------------------------------------------------
if (fs.existsSync(path.join(HERE, "..", "assets", "template.html"))) {
  const out = path.join(ws, "report.html");
  const built = JSON.parse(run(["build", "--run", RUN, "--out", out]));
  const html = fs.readFileSync(out, "utf8");
  assert.ok(!html.includes("__DATA__"), "the data marker was not substituted");
  assert.ok(html.includes("data:image/png;base64,"), "screenshots were not embedded");
  assert.ok(!/<\/script>/i.test(JSON.stringify(built)), "build output should be inert");
  // All four steps were handed the same file, so dedupe must collapse them to one stored image.
  assert.strictEqual(built.frames, 4, "every step should still get its own frame");
  assert.strictEqual(built.images, 1, "identical frames should be stored once");
  ok(`build: ${built.frames} frames share ${built.images} stored image, ${(built.bytes / 1024).toFixed(1)}KB`);
} else {
  console.log("  --  build skipped (assets/template.html not written yet)");
}

fs.rmSync(ws, { recursive: true, force: true });
console.log(`\n${checks} checks passed`);
