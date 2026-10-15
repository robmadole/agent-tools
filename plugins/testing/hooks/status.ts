// Everything this mod knows about a /browser-test run comes from its run.db. This file holds the one query
// and turns its answer into what the band draws. No engine calls, so the test can feed it rows.
import type { RunData, ScenarioRow, Snapshot } from '../types'

// A runner records after each step. A model-driven step with a screenshot takes well under a minute, so two
// minutes of silence on an unfinished scenario means it is stuck, not thinking.
export const STALL_MS = 120_000
// A run that stopped without marking `done` disappears after this long; a finished one sooner.
export const IDLE_MS = 30 * 60_000
export const DONE_MS = 10 * 60_000

// Phases after which an unstarted scenario will not be started.
const SETTLED = new Set(['report', 'gaps', 'done'])

// Two attempts per scenario. The verdict attempt follows report.js summarize(): the run_id of the scenario's
// latest functional record. The active attempt is the latest of either pass, so a focus replay counts as work
// in progress too.
export const QUERY = `
WITH
exp AS (SELECT feature, scenario, MIN(ordinal) AS ord, COUNT(*) AS n FROM expected GROUP BY feature, scenario),
lastf AS (SELECT feature, scenario, MAX(id) AS mid FROM steps
           WHERE COALESCE(pass, 'functional') = 'functional' GROUP BY feature, scenario),
cur AS (SELECT s.feature, s.scenario, s.run_id, COUNT(*) AS rec,
               SUM(s.status = 'passed') AS passed, SUM(s.status = 'failed') AS failed
          FROM steps s JOIN lastf l ON s.feature = l.feature AND s.scenario = l.scenario
         WHERE s.run_id = (SELECT run_id FROM steps WHERE id = l.mid)
           AND COALESCE(s.pass, 'functional') = 'functional'
         GROUP BY s.feature, s.scenario),
lasta AS (SELECT feature, scenario, MAX(id) AS mid FROM steps GROUP BY feature, scenario),
act AS (SELECT s.feature, s.scenario, s.run_id, COUNT(*) AS rec, SUM(s.status = 'failed') AS failed,
               MIN(s.ts) AS started, MAX(s.ts) AS last_ts
          FROM steps s JOIN lasta l ON s.feature = l.feature AND s.scenario = l.scenario
          JOIN steps m ON m.id = l.mid
         WHERE s.run_id = m.run_id AND COALESCE(s.pass, 'functional') = COALESCE(m.pass, 'functional')
         GROUP BY s.feature, s.scenario)
SELECT json_object(
  'phase', (SELECT value FROM meta WHERE key = 'phase'),
  'phase_at', (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'phase_at'),
  'initialized_at', (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'initialized_at'),
  'last_ts', (SELECT MAX(ts) FROM steps),
  'scenarios', (SELECT json_group_array(json_object(
      'feature', e.feature, 'name', e.scenario, 'expected', e.n,
      'run_id', c.run_id, 'recorded', c.rec, 'passed', c.passed, 'failed', c.failed,
      'active_run_id', a.run_id, 'active_recorded', a.rec, 'active_failed', a.failed,
      'active_started', a.started, 'active_ts', a.last_ts))
    FROM (SELECT * FROM exp ORDER BY feature, ord) e
    LEFT JOIN cur c ON c.feature = e.feature AND c.scenario = e.scenario
    LEFT JOIN act a ON a.feature = e.feature AND a.scenario = e.scenario),
  'lanes', (SELECT json_group_object(lane, c) FROM
      (SELECT COALESCE(lane, 'unknown') AS lane, COUNT(*) AS c FROM steps
        WHERE COALESCE(pass, 'functional') = 'functional' GROUP BY 1)),
  'findings', (SELECT json_group_object(impact, c) FROM
      (SELECT impact, COUNT(*) AS c FROM findings GROUP BY impact)),
  'flaky', (SELECT COUNT(*) FROM flags WHERE flaky = 1),
  'failures', (SELECT json_group_array(json_object('id', id, 'scenario', scenario, 'step', step, 'reason', reason))
    FROM (SELECT id, scenario, step, reason FROM steps
           WHERE status = 'failed' AND COALESCE(pass, 'functional') = 'functional'
           ORDER BY id DESC LIMIT 20))
);
`

// What `report summary` would say, plus queued: no record yet in a phase that may still start it.
export type Verdict = 'passed' | 'failed' | 'incomplete' | 'queued' | 'not_run'
// What a runner is doing with the scenario right now, if anything.
export type Activity = 'running' | 'stalled' | null

export type ScenarioView = { row: ScenarioRow; verdict: Verdict; activity: Activity }

export type RunView = {
  run: string
  phase: string
  // run_id of the most recent step: `claude-1`, `repair-1`, `focus-1`
  pass: string | null
  scenarios: ScenarioView[]
  // Verdicts of scenarios no runner is working on; the ones being worked are in running and stalled.
  counts: Record<Verdict, number>
  running: number
  stalled: number
  steps: { done: number; total: number }
  // Share of laned steps a model settled: the run's cost. helper, code and literal steps took no request.
  // Steps recorded without a lane are left out, so a runner that skips --lane flatters this.
  llmPct: number | null
  findings: number
  flaky: number
  isDone: boolean
  // Time since anything was written, while some scenario is stalled; 0 otherwise.
  quietMs: number
  isVisible: boolean
}

// Same rule as report.js verdictOf: passed only when every expected step has a record and all of them
// passed. A skipped record makes it incomplete, as it does in `report summary`.
export function verdictOf(row: ScenarioRow, phase: string | null): Verdict {
  if (row.recorded === null) return SETTLED.has(phase ?? '') ? 'not_run' : 'queued'
  if ((row.failed ?? 0) > 0) return 'failed'
  if (row.recorded >= row.expected && row.passed === row.recorded) return 'passed'
  return 'incomplete'
}

// An attempt stalls only if it began in the current phase. One left unfinished by an earlier phase is just
// incomplete: the orchestrator moved on (repair analysis, flaky review), and no runner owes it a record.
// Working from the active attempt rather than the verdict one is what catches a hung focus replay.
export function activityOf(row: ScenarioRow, phaseAt: number | null, now: number): Activity {
  if (row.active_recorded === null || row.active_ts === null) return null
  if ((row.active_failed ?? 0) > 0 || row.active_recorded >= row.expected) return null
  if (phaseAt !== null && (row.active_started ?? 0) < phaseAt) return null
  return now - row.active_ts < STALL_MS ? 'running' : 'stalled'
}

export function view(snap: Snapshot, now: number): RunView | null {
  const data: RunData | null = snap.data
  if (!data) return null

  const counts: Record<Verdict, number> = { passed: 0, failed: 0, incomplete: 0, queued: 0, not_run: 0 }
  let running = 0
  let stalled = 0
  let done = 0
  let total = 0
  let latest: ScenarioRow | null = null
  const scenarios = data.scenarios.map(row => {
    const verdict = verdictOf(row, data.phase)
    const activity = activityOf(row, data.phase_at, now)
    if (activity === 'running') running += 1
    else if (activity === 'stalled') stalled += 1
    // An attempt still being worked isn't incomplete yet; it shows as running or stalled instead.
    if (!(activity && verdict === 'incomplete')) counts[verdict] += 1
    total += row.expected
    done += Math.min(row.recorded ?? 0, row.expected)
    if (row.active_ts !== null && (latest === null || row.active_ts > (latest.active_ts ?? 0))) latest = row
    return { row, verdict, activity }
  })

  const lanes = Object.entries(data.lanes).filter(([lane]) => lane !== 'unknown')
  const settled = lanes.reduce((sum, [, n]) => sum + n, 0)
  const model = data.lanes.model ?? 0
  const lastWrite = Math.max(data.phase_at ?? 0, data.initialized_at ?? 0, data.last_ts ?? 0)
  const isDone = data.phase === 'done'
  const isVisible = isDone ? now - (data.phase_at ?? 0) < DONE_MS : now - lastWrite < IDLE_MS

  return {
    run: snap.run,
    phase: data.phase ?? 'setup',
    pass: (latest as ScenarioRow | null)?.active_run_id ?? null,
    scenarios,
    counts,
    running,
    stalled,
    steps: { done, total },
    llmPct: settled ? Math.round((100 * model) / settled) : null,
    findings: Object.values(data.findings).reduce((sum, n) => sum + n, 0),
    flaky: data.flaky,
    isDone,
    quietMs: stalled > 0 ? now - lastWrite : 0,
    isVisible,
  }
}

export function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
}

// Quiet while most steps run without a model, loud once the run leans on one.
export function llmColor(pct: number): string | undefined {
  return pct > 50 ? 'red' : pct > 25 ? 'yellow' : undefined
}
