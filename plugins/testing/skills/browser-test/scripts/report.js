#!/usr/bin/env bun
// The deterministic record of a browser-test run.
//
//   claim    take the next free run number, atomically, before anything else touches the run
//   runner   write one pass's runner instructions, with every value the runners share filled in
//   init     parse the specs into a manifest of what SHOULD happen, before any runner starts
//   record   one step, from either runner, as it happens
//   flag     the orchestrator's flaky verdict on one scenario, with its reason
//   finding  one focus finding, or a batch from a file (axe-core results are read as-is)
//   summary  reconcile manifest against records -> verdicts and totals, as JSON
//   build    render the run into one self-contained HTML report
//
// A scenario is only `passed` when every expected step has a passing record. Absence is never
// green: a runner that dies at step 3 of 4 leaves an `incomplete`, not a short happy filmstrip.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseArgs } from "util";
import { Database } from "bun:sqlite";
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from "@cucumber/gherkin";

const SCHEMA_BASE = `
CREATE TABLE IF NOT EXISTS features (
  file TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS expected (
  feature TEXT NOT NULL, scenario TEXT NOT NULL, ordinal INTEGER NOT NULL,
  position INTEGER NOT NULL, step TEXT NOT NULL, origin TEXT NOT NULL,
  PRIMARY KEY (feature, scenario, position));
CREATE TABLE IF NOT EXISTS testdata (
  feature TEXT NOT NULL, position INTEGER NOT NULL, command TEXT NOT NULL,
  status TEXT, output TEXT,
  PRIMARY KEY (feature, position));
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, run_id TEXT NOT NULL, runner TEXT NOT NULL,
  feature TEXT NOT NULL, scenario TEXT NOT NULL,
  step TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, png BLOB,
  -- How the step was settled: helper | code | literal | model. Null for runners that don't report it. What it
  -- buys is a coverage number that moves between runs, which is the only way progressive helpers stay honest.
  lane TEXT,
  -- functional | focus. Only functional attempts decide a verdict; a focus pass replays the same scenarios to
  -- run its checks, and if its records counted, the last attempt would quietly replace the real one.
  pass TEXT);
CREATE INDEX IF NOT EXISTS steps_scenario ON steps (feature, scenario, id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

// Tables that arrived after the first schema. openRun creates them too, so a run.db from before they existed
// takes a flag or a finding instead of rejecting it.
const ADDED_TABLES = `
CREATE TABLE IF NOT EXISTS flags (
  feature TEXT NOT NULL, scenario TEXT NOT NULL, flaky INTEGER NOT NULL, reason TEXT, ts INTEGER NOT NULL,
  PRIMARY KEY (feature, scenario));
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, run_id TEXT NOT NULL,
  focus TEXT NOT NULL, feature TEXT NOT NULL, scenario TEXT NOT NULL, step TEXT NOT NULL,
  url TEXT, source TEXT NOT NULL, rule TEXT NOT NULL, impact TEXT NOT NULL,
  target TEXT, summary TEXT NOT NULL, detail TEXT, wcag TEXT, png BLOB);
`;
const SCHEMA = SCHEMA_BASE + ADDED_TABLES;

const STATUSES = new Set(["passed", "failed", "skipped"]);
const PASSES = new Set(["functional", "focus"]);
// The orchestrator's phases, in SKILL.md order. run.db is the one place a run's status lives, and the phases
// with no steps of their own (repair analysis, flaky review, reporting) would otherwise look like a stall.
const PHASES = ["specs", "execute", "repair", "helpers", "focus", "flaky", "report", "gaps", "done"];
// axe-core's four levels. Every focus uses them, so findings from different foci sort on one scale.
const IMPACTS = ["critical", "serious", "moderate", "minor"];
// axe: from axe-core. measurement: a number a focus snippet measured (overflow px, target size). judgment: a
// runner's own call.
const SOURCES = ["axe", "measurement", "judgment"];
const newId = () => crypto.randomUUID();
const die = (msg) => { console.error(msg); process.exit(1); };

// Scenario Outline rows share a name; astNodeIds is [scenario, examples row]. Both this file and
// jev-run.js name pickles through here, so Jev's records land on the manifest rows they belong to.
export function pickleName(pickle, rows) {
  const [scenarioId, rowId] = pickle.astNodeIds;
  rows[scenarioId] = (rows[scenarioId] ?? 0) + 1;
  return rowId ? `${pickle.name} (example ${rows[scenarioId]})` : pickle.name;
}

// `compile` inlines Background steps into every pickle and expands Outline rows, so a pickle's step
// list is the true expected count. Counting lines in the .feature file would get both wrong.
export function parseSpec(file) {
  const doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher())
    .parse(fs.readFileSync(file, "utf8"));
  const background = new Set();
  const keywords = {};
  const collect = (children = []) => {
    for (const c of children) {
      for (const s of (c.background ?? c.scenario)?.steps ?? []) {
        keywords[s.id] = s.keyword;
        if (c.background) background.add(s.id);
      }
      collect(c.rule?.children);
    }
  };
  collect(doc.feature?.children);

  const rows = {};
  const scenarios = [];
  for (const pickle of compile(doc, file, newId)) {
    scenarios.push({
      name: pickleName(pickle, rows),
      steps: pickle.steps.map((s) => ({
        text: (keywords[s.astNodeIds[0]] ?? "") + s.text,
        origin: background.has(s.astNodeIds[0]) ? "background" : "scenario",
      })),
    });
  }
  // testdata: directives live in the feature description, not in any pickle. They run once per
  // feature before any scenario, so they are setup that can fail on its own.
  const testdata = (doc.feature?.description ?? "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("testdata:"))
    .map((l) => l.slice("testdata:".length).trim());

  return { name: doc.feature?.name ?? "", scenarios, testdata };
}

// Only init and phase create the database, and both run from the orchestrator alone, never alongside runners.
// Only they touch journal_mode: concurrent writers all flipping it race and die SQLITE_BUSY, and busy_timeout
// does not save them because the contention is on db creation itself.
function createRun(runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  const db = new Database(path.join(runDir, "run.db"), { create: true });
  // The status mod reads run.db every few seconds. Without a timeout, a phase marker that lands on its lock
  // fails with SQLITE_BUSY and is lost.
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function setPhase(runDir, name) {
  if (!PHASES.includes(name)) die(`--name must be one of ${PHASES.join(", ")}`);
  const db = createRun(runDir);
  const put = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  db.transaction(() => { put.run("phase", name); put.run("phase_at", String(Date.now())); })();
  db.close();
}

// The run number used to come from the highest report in results/, which a run only writes at the very end, so
// two runs started on one branch both took the same N and wrote into one run.db. mkdir without `recursive` fails
// when the directory exists, which makes it the lock: whoever creates tmp/run-N owns N.
export function claimRun(directory) {
  const num = (re) => (dir) => {
    try { return fs.readdirSync(dir).map((f) => Number(f.match(re)?.[1] ?? 0)); } catch { return []; }
  };
  const tmp = path.join(directory, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  let n = Math.max(0, ...num(/run-(\d+)/)(path.join(directory, "results")), ...num(/^run-(\d+)$/)(tmp)) + 1;
  for (;; n++) {
    try {
      fs.mkdirSync(path.join(tmp, `run-${n}`));
      return { n, run: path.join(tmp, `run-${n}`) };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

// The runner instructions for one pass, written once and read by every runner in it. The orchestrator used to
// copy the template out through its own output: about 20k characters per pass, a long wait before any agent
// started, and every chance to mangle the template on the way. The per-runner values stay in braces; each
// runner's short dispatch prompt lists its own.
const PER_RUNNER = ["{file path}", "{playwright tool prefix}", "{report command}", "{helper context}", "{scenarios}",
                    "{testdata context}", "{finding command}"];
export function writeRunner(runDir, { pass, config, shots, foci }) {
  if (!["functional", "focus"].includes(pass)) die("--pass must be functional or focus");
  const skill = path.join(import.meta.dir, "..");
  const read = (...p) => fs.readFileSync(path.join(skill, ...p), "utf8");
  const cfgPath = path.resolve(config ?? ".browser-tests.json");
  if (!fs.existsSync(cfgPath)) die(`No config at ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.baseURL) die(`${cfgPath} has no baseURL`);
  const further = cfg.furtherSetup ? path.resolve(path.dirname(cfgPath), cfg.furtherSetup) : null;
  if (further && !fs.existsSync(further)) die(`furtherSetup ${further} does not exist`);

  let focusChecks = "";
  if (pass === "focus") {
    const names = (foci ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    if (!names.length) die("--foci is required for the focus pass, e.g. --foci accessibility,responsive");
    // Code the runner runs in the page resolves relative paths against the MCP server's working directory.
    const focusDir = path.resolve(runDir, "focus");
    fs.mkdirSync(focusDir, { recursive: true });
    const bodies = names.map((n) => {
      if (!fs.existsSync(path.join(skill, "foci", `${n}.md`))) die(`No focus named ${n} in ${path.join(skill, "foci")}`);
      return read("foci", `${n}.md`).replace(/^---\n[\s\S]*?\n---\n/, "");
    });
    focusChecks = [read("references", "focus-pass.md"), ...bodies].join("\n\n")
      .split("{focus dir}").join(focusDir)
      .split("{axe path}").join(path.join(skill, "foci", "vendor", "axe.min.js"));
  }
  const values = {
    "{base URL}": cfg.baseURL,
    "{directory}": cfg.directory ?? "browser-tests",
    "{further setup}": further ? fs.readFileSync(further, "utf8") : "",
    "{verification tools}": (cfg.verificationTools ?? []).map((t) => `- ${t}`).join("\n"),
    // The focus pass screenshots failed steps only, and focus-pass.md says how.
    "{screenshot instructions}": shots && pass === "functional"
      ? read("references", "screenshot-instructions.md").split("{run dir}").join(runDir) : "",
    "{focus checks}": focusChecks,
  };
  let text = read("references", "runner-prompt.md");
  for (const [k, v] of Object.entries(values)) text = text.split(k).join(v);
  const out = path.join(runDir, `runner-${pass}.md`);
  fs.writeFileSync(out, text);
  const left = [...new Set(text.match(/(?<!\$)\{[a-z ]+\}/g) ?? [])].filter((k) => !PER_RUNNER.includes(k));
  return { file: path.resolve(out), chars: text.length, per_runner: PER_RUNNER.filter((k) => text.includes(k)),
           unfilled: left };
}

function initRun(runDir, specs) {
  const db = createRun(runDir);

  const putFeature = db.prepare("INSERT OR REPLACE INTO features (file, name) VALUES (?, ?)");
  // ordinal keeps the report in spec order; ordering by scenario name would alphabetize them.
  const putStep = db.prepare(
    "INSERT OR REPLACE INTO expected (feature, scenario, ordinal, position, step, origin) VALUES (?, ?, ?, ?, ?, ?)");
  const putData = db.prepare(
    "INSERT OR REPLACE INTO testdata (feature, position, command) VALUES (?, ?, ?)");

  let scenarios = 0, steps = 0;
  db.transaction(() => {
    for (const file of specs) {
      const spec = parseSpec(file);
      putFeature.run(file, spec.name);
      spec.testdata.forEach((cmd, i) => putData.run(file, i, cmd));
      spec.scenarios.forEach((sc, ordinal) => {
        scenarios++;
        sc.steps.forEach((s, i) => { putStep.run(file, sc.name, ordinal, i, s.text, s.origin); steps++; });
      });
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('initialized_at', ?)")
      .run(String(Date.now()));
  })();
  db.close();
  return { features: specs.length, scenarios, steps };
}

// Exported so jev-run.js opens the database the same way rather than keeping its own copy of this.
export const openRun = (runDir) => {
  const file = path.join(runDir, "run.db");
  if (!fs.existsSync(file)) die(`No run database at ${file}. Run "report init" first.`);
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout = 10000");
  // `lane` arrived after the schema did, and a run dir can outlive a skill update — without this an older
  // run.db rejects every insert with "no column named lane", which reads as a dead runner.
  const columns = db.query("PRAGMA table_info(steps)").all().map((c) => c.name);
  if (!columns.includes("lane")) db.exec("ALTER TABLE steps ADD COLUMN lane TEXT");
  if (!columns.includes("pass")) db.exec("ALTER TABLE steps ADD COLUMN pass TEXT");
  db.exec(ADDED_TABLES);
  return db;
};

// Exported so jev-run.js calls the same code path in-process, with the PNG already in memory —
// no temp file, no subprocess. The CLI below is the same function for the Claude runner.
export function recordStep(db, r) {
  if (!STATUSES.has(r.status)) die(`--status must be one of ${[...STATUSES].join(", ")}`);
  if (r.pass && !PASSES.has(r.pass)) die(`--pass must be one of ${[...PASSES].join(", ")}`);
  db.prepare(
    `INSERT INTO steps (ts, run_id, runner, feature, scenario, step, status, reason, png, lane, pass)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), r.runId ?? "1", r.runner ?? "claude", r.feature, r.scenario,
        r.step, r.status, r.reason ?? null, r.screenshot ?? null, r.lane ?? null, r.pass ?? null);
}

const inManifest = (db, feature, scenario) =>
  Boolean(db.query("SELECT 1 FROM expected WHERE feature = ? AND scenario = ? LIMIT 1").get(feature, scenario));

// Flaky is a verdict the orchestrator reaches after looking, never something derived: summary only says which
// scenarios are inconsistent. A typo'd scenario name would flag nothing and look like it worked, so refuse it.
function flagScenario(db, f) {
  if (!inManifest(db, f.feature, f.scenario)) die(`No scenario "${f.scenario}" in ${f.feature}`);
  if (!["true", "false"].includes(f.flaky)) die("--flaky must be true or false");
  db.prepare("INSERT OR REPLACE INTO flags (feature, scenario, flaky, reason, ts) VALUES (?, ?, ?, ?, ?)")
    .run(f.feature, f.scenario, f.flaky === "true" ? 1 : 0, f.reason ?? null, Date.now());
}

// axe.run() resolves to { url, violations, incomplete, ... }. Taking that shape as-is means a runner saves the
// result straight to a file with browser_evaluate and never has to rewrite axe's output into ours. Violations
// become findings. `incomplete` is the part axe could not decide, so it goes back to the runner to judge.
function fromAxe(result) {
  const wcag = (tags) => (tags ?? []).filter((t) => /^wcag\d/.test(t)).join(" ") || null;
  const findings = [];
  for (const v of result.violations ?? []) {
    for (const n of v.nodes ?? [{}]) {
      findings.push({
        rule: v.id, impact: n.impact ?? v.impact, summary: v.help, url: result.url ?? null,
        target: (n.target ?? []).flat().join(" ") || null, detail: n.failureSummary ?? null, wcag: wcag(v.tags),
        source: "axe",
      });
    }
  }
  // Two kinds of "could not decide" that runners judged and dropped every single time on a web-component app,
  // both because axe stops at a shadow root: contrast on an element inside one ("background could not be
  // determined"), and an aria-controls/-owns that points into one. axe writes a target that crosses a shadow
  // root as a nested array. Those are dropped here and counted, so a runner only triages the rest.
  const crossesShadow = (n) => Array.isArray(n.target?.[0]) && n.target[0].length > 1;
  const SHADOW_NOISE = ["color-contrast", "aria-valid-attr-value"];
  let dropped = 0;
  const incomplete = (result.incomplete ?? []).flatMap((v) => (v.nodes ?? [{}]).flatMap((n) => {
    if (SHADOW_NOISE.includes(v.id) && crossesShadow(n)) { dropped++; return []; }
    return [{ rule: v.id, target: (n.target ?? []).flat().join(" ") || null, message: n.any?.[0]?.message ?? v.help }];
  }));
  return { findings, incomplete, dropped };
}

function recordFindings(db, defaults, items) {
  const put = db.prepare(
    `INSERT INTO findings (ts, run_id, focus, feature, scenario, step, url, source, rule, impact, target, summary,
                           detail, wcag, png)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = items.map((i) => {
    const r = { ...defaults, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v != null)) };
    for (const f of ["focus", "feature", "scenario", "step", "rule", "summary"]) {
      if (!r[f]) die(`finding needs --${f}${items.length > 1 ? ` (missing on rule "${r.rule ?? "?"}")` : ""}`);
    }
    // An item from --from can name its own scenario and screenshot, so check them as the flags are checked.
    if (!inManifest(db, r.feature, r.scenario)) die(`No scenario "${r.scenario}" in ${r.feature}`);
    if (typeof r.screenshot === "string") {
      if (fs.existsSync(r.screenshot)) r.screenshot = fs.readFileSync(r.screenshot);
      else { console.error(`warning: no screenshot at ${r.screenshot}`); r.screenshot = null; }
    }
    // axe leaves impact null on a few best-practice rules. Moderate is where it would have put them.
    r.impact = r.impact ?? "moderate";
    if (!IMPACTS.includes(r.impact)) die(`--impact must be one of ${IMPACTS.join(", ")}`);
    r.source = r.source ?? "judgment";
    if (!SOURCES.includes(r.source)) die(`--source must be one of ${SOURCES.join(", ")}`);
    return r;
  });
  db.transaction(() => {
    for (const r of rows) {
      put.run(Date.now(), r.runId ?? "1", r.focus, r.feature, r.scenario, r.step, r.url ?? null,
              r.source, r.rule, r.impact, r.target ?? null, r.summary, r.detail ?? null,
              r.wcag ?? null, r.screenshot ?? null);
    }
  })();
  return rows.length;
}

function verdictOf(rec, n) {
  return rec.some((r) => r.status === "failed") ? "failed"
    : rec.length === 0 ? "not_run"
    : rec.length < n ? "incomplete"
    : rec.every((r) => r.status === "passed") ? "passed"
    : "incomplete";
}

// A scenario is inconsistent when two attempts at the same spec got different verdicts. Two kinds of
// disagreement are left out because they are expected, not suspicious:
//   - an attempt whose step text differs from the spec: the spec was repaired in between, so the attempts
//     tested different things
//   - attempts by different runners: a Jev leftover that Claude then passes is the fallback doing its job
// Inconsistent is only a prompt to look. Whether it is flaky is the orchestrator's call, recorded with `flag`.
function consistency(sc, rows, flag) {
  const byAttempt = new Map();
  for (const r of rows) {
    const k = `${r.pass}\u0000${r.run_id}`;
    if (!byAttempt.has(k)) byAttempt.set(k, []);
    byAttempt.get(k).push(r);
  }
  const attempts = [...byAttempt.values()].map((rec) => {
    const failed = rec.find((r) => r.status === "failed");
    return {
      run_id: rec[0].run_id, pass: rec[0].pass, runner: rec[0].runner,
      verdict: verdictOf(rec, sc.expected.length),
      comparable: rec.every((r, i) => sc.expected[i]?.step === r.step),
      failed_step: failed?.step ?? null, failure_reason: failed?.reason ?? null,
    };
  });
  const byRunner = new Map();
  for (const a of attempts.filter((a) => a.comparable)) {
    if (!byRunner.has(a.runner)) byRunner.set(a.runner, new Set());
    byRunner.get(a.runner).add(a.verdict);
  }
  const inconsistent = [...byRunner.values()].some((v) => v.size > 1);
  return {
    attempts, inconsistent,
    flaky: flag ? Boolean(flag.flaky) : null,
    flaky_reason: flag?.reason ?? null,
  };
}

// One problem seen on five transitions is one finding with five occurrences. The key is the URL path, not the
// URL: testdata ids land in query strings and paths often enough that keying on the whole URL would split it.
function groupFindings(db) {
  const rows = db.query(`
    SELECT id, focus, feature, scenario, step, url, source, rule, impact, target, summary, detail, wcag,
           png IS NOT NULL AS has_png
      FROM findings ORDER BY id`).all();
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u ?? null; } };
  const groups = new Map();
  for (const r of rows) {
    const p = pathOf(r.url);
    // With a target, the element is the problem wherever it shows up: a shared header that overflows on seven
    // pages is one finding seen seven times, not seven findings. Without one, the page is all there is to go on.
    const k = (r.target ? [r.focus, r.rule, r.target] : [r.focus, r.rule, "", p]).join("\u0000");
    if (!groups.has(k)) {
      groups.set(k, { focus: r.focus, rule: r.rule, impact: r.impact, source: r.source, summary: r.summary,
                      detail: r.detail, wcag: r.wcag, target: r.target, path: p, paths: [], occurrences: [] });
    }
    const g = groups.get(k);
    if (p && !g.paths.includes(p)) g.paths.push(p);
    if (IMPACTS.indexOf(r.impact) < IMPACTS.indexOf(g.impact)) g.impact = r.impact;
    g.occurrences.push({ id: r.id, feature: r.feature, scenario: r.scenario, step: r.step, url: r.url,
                         has_png: Boolean(r.has_png) });
  }
  const list = [...groups.values()].sort((a, b) =>
    IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || b.occurrences.length - a.occurrences.length);
  const byFocus = {};
  for (const g of list) {
    byFocus[g.focus] ??= Object.fromEntries(IMPACTS.map((i) => [i, 0]));
    byFocus[g.focus][g.impact]++;
  }
  return { total: list.length, recorded: rows.length, by_focus: byFocus, groups: list };
}

function summarize(db) {
  const featureNames = new Map(
    db.query("SELECT file, name FROM features ORDER BY file").all().map((f) => [f.file, f.name]));
  const expected = db.query(
    "SELECT feature, scenario, position, step, origin FROM expected ORDER BY feature, ordinal, position").all();
  // One attempt wins per scenario: the run_id of its most recent functional record. Phase 2b re-runs and
  // the Claude fallback after a Jev pass both append a fresh set rather than editing the old one. A focus
  // pass appends one too, and is kept out of this on purpose: it is a second opinion, not the verdict.
  const FUNCTIONAL = "COALESCE(pass, 'functional') = 'functional'";
  const current = db.query(`
    WITH last AS (SELECT feature, scenario, MAX(id) AS mid FROM steps WHERE ${FUNCTIONAL}
                   GROUP BY feature, scenario)
    SELECT s.id, s.ts, s.run_id, s.runner, s.feature, s.scenario, s.step, s.status, s.reason, s.lane,
           s.png IS NOT NULL AS has_png
      FROM steps s JOIN last l ON s.feature = l.feature AND s.scenario = l.scenario
     WHERE s.run_id = (SELECT run_id FROM steps WHERE id = l.mid) AND ${FUNCTIONAL.replaceAll("pass", "s.pass")}
     ORDER BY s.id`).all();
  // Every attempt, both passes, for the inconsistency check. No png: this is only ever read for verdicts.
  const history = db.query(`
    SELECT id, run_id, runner, COALESCE(pass, 'functional') AS pass, feature, scenario, step, status, reason,
           png IS NOT NULL AS has_png
      FROM steps ORDER BY id`).all();
  const flags = new Map(db.query("SELECT feature, scenario, flaky, reason FROM flags").all()
    .map((f) => [`${f.feature}\u0000${f.scenario}`, f]));

  const key = (f, s) => `${f}\u0000${s}`;
  const scenarios = new Map();
  for (const e of expected) {
    const k = key(e.feature, e.scenario);
    if (!scenarios.has(k)) scenarios.set(k, { feature: e.feature, name: e.scenario, expected: [], recorded: [] });
    scenarios.get(k).expected.push(e);
  }
  const orphans = [];
  for (const c of current) {
    const sc = scenarios.get(key(c.feature, c.scenario));
    if (sc) sc.recorded.push(c); else orphans.push({ feature: c.feature, scenario: c.scenario, step: c.step });
  }

  const out = [];
  for (const sc of scenarios.values()) {
    const n = sc.expected.length;
    const rec = sc.recorded;
    const verdict = verdictOf(rec, n);
    // Un-recorded steps render as ghost frames, which is what makes a truncated strip legible.
    const steps = sc.expected.map((e, i) => {
      const r = rec[i];
      return {
        position: i, text: e.step, origin: e.origin,
        status: r ? r.status : "not_recorded",
        reason: r?.reason ?? null,
        step_id: r?.id ?? null,
        has_png: Boolean(r?.has_png),
        lane: r?.lane ?? null,
        drift: r && r.step !== e.step ? r.step : null,
      };
    });
    const failed = steps.find((s) => s.status === "failed");
    const ts = rec.map((r) => r.ts);
    out.push({
      feature: sc.feature, feature_name: featureNames.get(sc.feature) ?? "",
      name: sc.name, verdict,
      runner: rec[0]?.runner ?? null, run_id: rec[0]?.run_id ?? null,
      expected_steps: n, recorded_steps: rec.length,
      over_recorded: rec.length > n,
      failed_step: failed?.text ?? null, failure_reason: failed?.reason ?? null,
      elapsed_ms: ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : null,
      ...consistency(sc, history.filter((h) => h.feature === sc.feature && h.scenario === sc.name),
                     flags.get(key(sc.feature, sc.name))),
      steps,
    });
  }

  const count = (v) => out.filter((s) => s.verdict === v).length;
  const settled = {};
  for (const s of out) if (s.runner) settled[s.runner] = (settled[s.runner] ?? 0) + 1;

  // How each step got settled. `model_free_rate` is the number to watch across runs: it goes up as a project
  // adds helpers, and it's the only honest measure of whether they're earning their keep. Steps recorded
  // without a lane (the Claude runner before the bridge) are left out rather than counted as either.
  const lanes = {};
  for (const s of out) for (const st of s.steps) if (st.lane) lanes[st.lane] = (lanes[st.lane] ?? 0) + 1;
  const laneTotal = Object.values(lanes).reduce((a, b) => a + b, 0);
  const modelFree = laneTotal - (lanes.model ?? 0);

  const findings = groupFindings(db);

  // A background step failing across N scenarios is one broken thing, not N bugs. Phase 2b would
  // otherwise read the source and investigate the same root cause once per scenario.
  const clusters = new Map();
  for (const s of out) {
    for (const st of s.steps) {
      if (st.status !== "failed" || st.origin !== "background") continue;
      const k = key(s.feature, st.text);
      if (!clusters.has(k)) clusters.set(k, { feature: s.feature, step: st.text, reason: st.reason, scenarios: [] });
      clusters.get(k).scenarios.push(s.name);
    }
  }

  return {
    totals: {
      total: out.length, passed: count("passed"), failed: count("failed"),
      incomplete: count("incomplete"), not_run: count("not_run"),
      pass_rate: out.length ? Math.round((count("passed") / out.length) * 100) : 0,
      settled_by: settled,
      steps_by_lane: lanes,
      model_free_rate: laneTotal ? Math.round((modelFree / laneTotal) * 100) : null,
      inconsistent: out.filter((s) => s.inconsistent).length,
      flaky: out.filter((s) => s.flaky).length,
      findings: findings.total,
    },
    features: [...featureNames].map(([file, name]) => ({
      file, name,
      testdata: db.query("SELECT command, status FROM testdata WHERE feature = ? ORDER BY position").all(file),
      scenarios: out.filter((s) => s.feature === file),
    })),
    background_failures: [...clusters.values()].filter((c) => c.scenarios.length > 1),
    // The scenarios whose attempts disagree. `flaky: null` means nobody has looked yet: those are the ones the
    // orchestrator still owes a verdict on.
    inconsistent: out.filter((s) => s.inconsistent).map((s) => ({
      feature: s.feature, scenario: s.name, flaky: s.flaky, flaky_reason: s.flaky_reason, attempts: s.attempts,
    })),
    findings,
    orphan_records: orphans,
    generated_at: Date.now(),
  };
}

function build(db, runDir, outFile) {
  const data = summarize(db);
  const images = {};
  const png = new Map(db.query("SELECT id, png FROM steps WHERE png IS NOT NULL").all()
    .map((r) => [r.id, r.png]));
  // Two things keep the file honest but small. Only the winning attempt is walked, so a scenario
  // Claude re-ran after Jev doesn't drag its superseded frames along. And identical frames are
  // stored once: the runners screenshot every step on purpose, and most steps leave the page
  // unchanged, so a real 171-frame run held only 66 distinct images — 14.1MB of PNG down to 5.3MB.
  // Every step still gets its own frame in the filmstrip; they just share the bytes.
  let frames = 0;
  for (const f of data.features) for (const s of f.scenarios) for (const st of s.steps) {
    const bytes = st.step_id && png.get(st.step_id);
    if (!bytes) continue;
    const hash = crypto.createHash("sha1").update(bytes).digest("base64url").slice(0, 16);
    if (!(hash in images)) images[hash] = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    st.img = hash;
    frames++;
  }
  // Findings carry their own screenshot (the element at fault, or the page at the width that broke). They go
  // through the same dedupe, since one layout bug seen on every transition is often the same frame.
  const findingPng = new Map(db.query("SELECT id, png FROM findings WHERE png IS NOT NULL").all()
    .map((r) => [r.id, r.png]));
  for (const g of data.findings.groups) for (const o of g.occurrences) {
    const bytes = findingPng.get(o.id);
    if (!bytes) continue;
    const hash = crypto.createHash("sha1").update(bytes).digest("base64url").slice(0, 16);
    if (!(hash in images)) images[hash] = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    o.img = hash;
  }
  data.images = images;
  data.frames = frames;
  const template = path.join(import.meta.dir, "..", "assets", "template.html");
  if (!fs.existsSync(template)) die(`Missing report template at ${template}`);
  // Step text and failure reasons carry content straight out of the app under test, so a page that
  // renders "</script>" in an error message would otherwise break out of the data blob.
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  // A function, not the string: `$&` or `$'` in a failure reason or an axe summary would otherwise be read as a
  // replacement pattern and corrupt the JSON.
  fs.writeFileSync(outFile, fs.readFileSync(template, "utf8").replace("__DATA__", () => payload));
  return { out: outFile, bytes: fs.statSync(outFile).size, frames, images: Object.keys(images).length };
}

// jev-run.js imports recordStep/pickleName from here, so the CLI only runs when this file is
// the entry point.
if (import.meta.main) cli();

function cli() {
const { values: opts, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    run: { type: "string" },
    "run-id": { type: "string", default: "1" },
    runner: { type: "string", default: "claude" },
    feature: { type: "string" },
    scenario: { type: "string" },
    step: { type: "string" },
    status: { type: "string" },
    reason: { type: "string" },
    screenshot: { type: "string" },
    lane: { type: "string" },
    pass: { type: "string" },
    flaky: { type: "string" },
    focus: { type: "string" },
    source: { type: "string" },
    rule: { type: "string" },
    impact: { type: "string" },
    target: { type: "string" },
    summary: { type: "string" },
    detail: { type: "string" },
    wcag: { type: "string" },
    url: { type: "string" },
    name: { type: "string" },
    dir: { type: "string" },
    config: { type: "string" },
    foci: { type: "string" },
    shots: { type: "boolean", default: false },
    from: { type: "string" },
    out: { type: "string" },
    steps: { type: "boolean", default: false },
  },
});

const cmd = positionals[0];
const USAGE = `usage: report <claim|runner|phase|init|record|flag|finding|summary|build> --run <dir> [...]

  claim   --dir <directory>                       take the next run number; prints {"n", "run"}
  runner  --run <dir> --pass functional|focus [--config .browser-tests.json] [--shots] [--foci a,b]
                                                  write <dir>/runner-<pass>.md with the shared values filled in
  phase   --run <dir> --name ${PHASES.join("|")}
                                                  mark the phase the orchestrator is entering
  init    --run <dir> <spec.feature ...>          write the manifest of expected scenarios
  record  --run <dir> --feature F --scenario S --step "..." --status passed|failed
          [--run-id ID] [--runner N] [--reason R] [--screenshot PATH] [--lane helper|model]
          [--pass functional|focus]
  flag    --run <dir> --feature F --scenario S --flaky true|false [--reason R]
  finding --run <dir> --focus NAME --feature F --scenario S --step "..."
          --rule R --impact critical|serious|moderate|minor --summary "..."
          [--source axe|measurement|judgment] [--url U] [--target SELECTOR] [--detail D] [--wcag TAGS]
          [--screenshot PATH] [--run-id ID]
          --from FILE  instead of --rule/--impact/--summary: an axe.run() result, or an array of findings
  summary --run <dir>                             reconciled verdicts and totals, as JSON
  build   --run <dir> --out <file.html>           one self-contained HTML report`;
if (!cmd || !["claim", "runner", "phase", "init", "record", "flag", "finding", "summary", "build"].includes(cmd)) die(USAGE);
if (cmd !== "claim" && !opts.run) die("--run <dir> is required");

if (cmd === "claim") {
  if (!opts.dir) die("--dir <directory> is required for claim");
  console.log(JSON.stringify(claimRun(opts.dir)));

} else if (cmd === "runner") {
  console.log(JSON.stringify(writeRunner(opts.run, { pass: opts.pass, config: opts.config, shots: opts.shots,
                                                     foci: opts.foci })));

} else if (cmd === "phase") {
  if (!opts.name) die("--name is required for phase");
  setPhase(opts.run, opts.name);
  console.log(`phase: ${opts.name}`);

} else if (cmd === "init") {
  const specs = positionals.slice(1);
  if (!specs.length) die("init needs at least one .feature file");
  const missing = specs.filter((f) => !fs.existsSync(f));
  if (missing.length) die(`No such spec file: ${missing.join(", ")}`);
  console.log(JSON.stringify(initRun(opts.run, specs)));

} else if (cmd === "record") {
  for (const f of ["feature", "scenario", "step", "status"]) {
    if (!opts[f]) die(`--${f} is required for record`);
  }
  let png = null;
  if (opts.screenshot) {
    // A missing screenshot must not kill a run mid-scenario; the step still gets its record and
    // the report draws a ghost frame for it.
    if (fs.existsSync(opts.screenshot)) png = fs.readFileSync(opts.screenshot);
    else console.error(`warning: no screenshot at ${opts.screenshot}`);
  }
  const db = openRun(opts.run);
  recordStep(db, {
    runId: opts["run-id"], runner: opts.runner, feature: opts.feature, scenario: opts.scenario,
    step: opts.step, status: opts.status, reason: opts.reason, screenshot: png, lane: opts.lane,
    pass: opts.pass,
  });
  db.close();
  console.log(`recorded ${opts.status}: ${opts.step}`);

} else if (cmd === "flag") {
  for (const f of ["feature", "scenario", "flaky"]) if (!opts[f]) die(`--${f} is required for flag`);
  const db = openRun(opts.run);
  flagScenario(db, opts);
  db.close();
  console.log(`flagged ${opts.flaky === "true" ? "flaky" : "not flaky"}: ${opts.scenario}`);

} else if (cmd === "finding") {
  const db = openRun(opts.run);
  if (!inManifest(db, opts.feature, opts.scenario)) die(`No scenario "${opts.scenario}" in ${opts.feature}`);
  let png = null;
  if (opts.screenshot) {
    if (fs.existsSync(opts.screenshot)) png = fs.readFileSync(opts.screenshot);
    else console.error(`warning: no screenshot at ${opts.screenshot}`);
  }
  const defaults = {
    runId: opts["run-id"], focus: opts.focus, feature: opts.feature,
    scenario: opts.scenario, step: opts.step, url: opts.url, source: opts.source, rule: opts.rule,
    impact: opts.impact, target: opts.target, summary: opts.summary, detail: opts.detail, wcag: opts.wcag,
    screenshot: png,
  };
  let items = [{}];
  let incomplete = [];
  let dropped = 0;
  if (opts.from) {
    if (!fs.existsSync(opts.from)) die(`No such file: ${opts.from}`);
    const parsed = JSON.parse(fs.readFileSync(opts.from, "utf8"));
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.violations)) ({ findings: items, incomplete, dropped } = fromAxe(parsed));
    else die(`${opts.from} is neither an array of findings nor an axe.run() result`);
  }
  const n = items.length ? recordFindings(db, defaults, items) : 0;
  db.close();
  // The runner reads this line, so `incomplete` is the useful half: axe's own "could not decide" list, which
  // is exactly what it should look at next. Capped so a page with 200 of them does not flood its context.
  console.log(JSON.stringify({ recorded: n, incomplete: incomplete.slice(0, 20),
                               incomplete_total: incomplete.length, incomplete_dropped: dropped }));

} else if (cmd === "summary") {
  const db = openRun(opts.run);
  const data = summarize(db);
  // The per-step arrays are most of the bytes and none of what the orchestrator decides with —
  // 68KB of context on a 171-step run. Everything Phase 2b acts on (failed_step, failure_reason,
  // recorded vs expected counts) is already on the scenario. Pass --steps for the full detail.
  if (!opts.steps) {
    for (const f of data.features) {
      for (const s of f.scenarios) {
        s.drifted_steps = s.steps.filter((st) => st.drift).length;
        delete s.steps;
      }
    }
    // A finding seen on 40 transitions is one decision for the orchestrator, not 40 rows to read.
    for (const g of data.findings.groups) {
      g.occurrence_count = g.occurrences.length;
      g.occurrences = g.occurrences.slice(0, 3);
    }
  }
  console.log(JSON.stringify(data, null, 2));
  db.close();

} else if (cmd === "build") {
  if (!opts.out) die("--out <file.html> is required for build");
  const db = openRun(opts.run);
  console.log(JSON.stringify(build(db, opts.run, opts.out)));
  db.close();

}
}
