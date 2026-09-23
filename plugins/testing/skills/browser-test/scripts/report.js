#!/usr/bin/env bun
// The deterministic record of a browser-test run.
//
//   init     parse the specs into a manifest of what SHOULD happen, before any runner starts
//   record   one step, from either runner, as it happens
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

const SCHEMA = `
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
  step TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, png BLOB);
CREATE INDEX IF NOT EXISTS steps_scenario ON steps (feature, scenario, id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const STATUSES = new Set(["passed", "failed", "skipped"]);
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

function initRun(runDir, specs) {
  fs.mkdirSync(runDir, { recursive: true });
  const db = new Database(path.join(runDir, "run.db"), { create: true });
  // Only init touches journal_mode. Concurrent writers all flipping it race and die SQLITE_BUSY,
  // and busy_timeout does not save them because the contention is on db creation itself.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

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

const openRun = (runDir) => {
  const file = path.join(runDir, "run.db");
  if (!fs.existsSync(file)) die(`No run database at ${file}. Run "report init" first.`);
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
};

// Exported so jev-run.js calls the same code path in-process, with the PNG already in memory —
// no temp file, no subprocess. The CLI below is the same function for the Claude runner.
export function recordStep(db, r) {
  if (!STATUSES.has(r.status)) die(`--status must be one of ${[...STATUSES].join(", ")}`);
  db.prepare(
    `INSERT INTO steps (ts, run_id, runner, feature, scenario, step, status, reason, png)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), r.runId ?? "1", r.runner ?? "claude", r.feature, r.scenario,
        r.step, r.status, r.reason ?? null, r.screenshot ?? null);
}

function summarize(db) {
  const featureNames = new Map(
    db.query("SELECT file, name FROM features ORDER BY file").all().map((f) => [f.file, f.name]));
  const expected = db.query(
    "SELECT feature, scenario, position, step, origin FROM expected ORDER BY feature, ordinal, position").all();
  // One attempt wins per scenario: the run_id of its most recent record. Phase 2b re-runs and the
  // Claude fallback after a Jev pass both append a fresh set rather than editing the old one.
  const current = db.query(`
    WITH last AS (SELECT feature, scenario, MAX(id) AS mid FROM steps GROUP BY feature, scenario)
    SELECT s.id, s.ts, s.run_id, s.runner, s.feature, s.scenario, s.step, s.status, s.reason,
           s.png IS NOT NULL AS has_png
      FROM steps s JOIN last l ON s.feature = l.feature AND s.scenario = l.scenario
     WHERE s.run_id = (SELECT run_id FROM steps WHERE id = l.mid)
     ORDER BY s.id`).all();

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
    const verdict =
      rec.some((r) => r.status === "failed") ? "failed"
      : rec.length === 0 ? "not_run"
      : rec.length < n ? "incomplete"
      : rec.every((r) => r.status === "passed") ? "passed"
      : "incomplete";
    // Un-recorded steps render as ghost frames, which is what makes a truncated strip legible.
    const steps = sc.expected.map((e, i) => {
      const r = rec[i];
      return {
        position: i, text: e.step, origin: e.origin,
        status: r ? r.status : "not_recorded",
        reason: r?.reason ?? null,
        step_id: r?.id ?? null,
        has_png: Boolean(r?.has_png),
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
      steps,
    });
  }

  const count = (v) => out.filter((s) => s.verdict === v).length;
  const settled = {};
  for (const s of out) if (s.runner) settled[s.runner] = (settled[s.runner] ?? 0) + 1;

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
    },
    features: [...featureNames].map(([file, name]) => ({
      file, name,
      testdata: db.query("SELECT command, status FROM testdata WHERE feature = ? ORDER BY position").all(file),
      scenarios: out.filter((s) => s.feature === file),
    })),
    background_failures: [...clusters.values()].filter((c) => c.scenarios.length > 1),
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
  data.images = images;
  data.frames = frames;
  const template = path.join(import.meta.dir, "..", "assets", "template.html");
  if (!fs.existsSync(template)) die(`Missing report template at ${template}`);
  // Step text and failure reasons carry content straight out of the app under test, so a page that
  // renders "</script>" in an error message would otherwise break out of the data blob.
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  fs.writeFileSync(outFile, fs.readFileSync(template, "utf8").replace("__DATA__", payload));
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
    out: { type: "string" },
    steps: { type: "boolean", default: false },
  },
});

const cmd = positionals[0];
const USAGE = `usage: report <init|record|summary|build> --run <dir> [...]

  init    --run <dir> <spec.feature ...>          write the manifest of expected scenarios
  record  --run <dir> --feature F --scenario S --step "..." --status passed|failed
          [--run-id ID] [--runner N] [--reason R] [--screenshot PATH]
  summary --run <dir>                             reconciled verdicts and totals, as JSON
  build   --run <dir> --out <file.html>           one self-contained HTML report`;
if (!cmd || !["init", "record", "summary", "build"].includes(cmd)) die(USAGE);
if (!opts.run) die("--run <dir> is required");

if (cmd === "init") {
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
    step: opts.step, status: opts.status, reason: opts.reason, screenshot: png,
  });
  db.close();
  console.log(`recorded ${opts.status}: ${opts.step}`);

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
