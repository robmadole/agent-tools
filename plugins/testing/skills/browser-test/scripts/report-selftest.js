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
