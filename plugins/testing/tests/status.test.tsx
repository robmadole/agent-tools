import { describe, expect, mock, test } from 'claude-code/testing'

import type { RunData, ScenarioRow, Snapshot } from '../types'
import { STALL_MS, view } from '../hooks/status'

const NOW = 1_800_000_000_000

const row = (over: Partial<ScenarioRow>): ScenarioRow => ({
  feature: 'bt/specs/signin.feature', name: 'x', expected: 3,
  run_id: null, recorded: null, passed: null, failed: null,
  active_run_id: null, active_recorded: null, active_failed: null, active_started: null, active_ts: null,
  ...over,
})

// One attempt, both as the verdict and as the active one.
const attempt = (runId: string, steps: number, passed: number, failed: number, started: number, last: number) => ({
  run_id: runId, recorded: steps, passed, failed,
  active_run_id: runId, active_recorded: steps, active_failed: failed, active_started: started, active_ts: last,
})

const PHASE_AT = NOW - 60_000

const data = (over: Partial<RunData> = {}): RunData => ({
  phase: 'execute', phase_at: PHASE_AT, initialized_at: PHASE_AT, last_ts: NOW - 1000,
  scenarios: [
    row({ name: 'Valid credentials', expected: 4, ...attempt('jev-1', 4, 4, 0, NOW - 50_000, NOW - 30_000) }),
    row({ name: 'Wrong password', ...attempt('claude-1', 2, 2, 0, NOW - 10_000, NOW - 1000) }),
    row({ name: 'Locked out', ...attempt('jev-1', 2, 1, 1, NOW - 40_000, NOW - 20_000) }),
    row({ name: 'Forgot password' }),
  ],
  lanes: { helper: 4, code: 1, literal: 1, model: 2, unknown: 3 },
  findings: {},
  flaky: 0,
  failures: [{ id: 8, scenario: 'Locked out', step: 'When I fill "Password"', reason: 'no field labelled Password' }],
  ...over,
})

const snap = (d: RunData): Snapshot => ({ run: 'run-3', dir: 'bt/tmp/run-3', data: d, error: null, checkedAt: NOW })

describe('view', () => {
  test('sorts scenarios into verdicts and counts steps against the manifest', () => {
    const v = view(snap(data()), NOW)!
    expect(v.scenarios.map(s => [s.verdict, s.activity])).toEqual([
      ['passed', null], ['incomplete', 'running'], ['failed', null], ['queued', null],
    ])
    // the running scenario is counted as running, not incomplete
    expect(v.counts).toEqual({ passed: 1, failed: 1, incomplete: 0, queued: 1, not_run: 0 })
    expect(v.running).toBe(1)
    expect(v.steps).toEqual({ done: 8, total: 13 })
    // 2 of 8 laned steps took a model; code and literal count as free, unlaned steps are left out
    expect(v.llmPct).toBe(25)
    expect(v.pass).toBe('claude-1')
    expect(v.isVisible).toBe(true)
  })

  test('an attempt from this phase with no record for two minutes is stalled', () => {
    const v = view(snap(data()), NOW + STALL_MS)!
    expect(v.scenarios[1]!.activity).toBe('stalled')
    expect(v.stalled).toBe(1)
    expect(v.quietMs).toBeGreaterThan(STALL_MS)
  })

  test('an attempt left unfinished by an earlier phase is incomplete, not stalled', () => {
    // The orchestrator moved on to repair analysis; nobody owes "Wrong password" a record now.
    const v = view(snap(data({ phase: 'repair', phase_at: NOW })), NOW + 10 * 60_000)!
    expect(v.scenarios[1]).toMatchObject({ verdict: 'incomplete', activity: null })
    expect(v.stalled).toBe(0)
    expect(v.quietMs).toBe(0)
  })

  test('a hung focus replay is stalled while the scenario keeps its functional pass', () => {
    const focusAt = NOW - 10 * 60_000
    const hung = row({
      name: 'Valid credentials', expected: 4, ...attempt('jev-1', 4, 4, 0, focusAt - 60_000, focusAt - 30_000),
      active_run_id: 'focus-1', active_recorded: 2, active_failed: 0, active_started: focusAt + 1000,
      active_ts: focusAt + 5000,
    })
    const v = view(snap(data({ phase: 'focus', phase_at: focusAt, last_ts: focusAt + 5000, scenarios: [hung] })), NOW)!
    expect(v.scenarios[0]).toMatchObject({ verdict: 'passed', activity: 'stalled' })
    expect(v.counts.passed).toBe(1)
    expect(v.stalled).toBe(1)
    expect(v.pass).toBe('focus-1')
  })

  test('a skipped step makes the scenario incomplete, as report summary does', () => {
    const skipped = row({ name: 'Valid credentials', expected: 4, ...attempt('jev-1', 4, 3, 0, PHASE_AT - 9000, PHASE_AT - 5000) })
    const v = view(snap(data({ scenarios: [skipped] })), NOW)!
    expect(v.scenarios[0]!.verdict).toBe('incomplete')
    expect(v.counts.passed).toBe(0)
  })

  test('once reporting starts, unstarted scenarios are not run', () => {
    const v = view(snap(data({ phase: 'report', phase_at: NOW })), NOW)!
    expect(v.scenarios[1]).toMatchObject({ verdict: 'incomplete', activity: null })
    expect(v.scenarios[3]!.verdict).toBe('not_run')
  })

  test('a finished run hides after ten minutes, an abandoned one after thirty', () => {
    expect(view(snap(data({ phase: 'done', phase_at: NOW })), NOW + 11 * 60_000)!.isVisible).toBe(false)
    expect(view(snap(data()), NOW + 20 * 60_000)!.isVisible).toBe(true)
    expect(view(snap(data()), NOW + 31 * 60_000)!.isVisible).toBe(false)
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120,
           scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })

test('reads the newest run.db, draws the band, and toasts only failures that are new', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let rows = data()
  let mtime = 1
  const toasts: string[] = []

  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: !e.path.endsWith('run-10/run.db') }))
  on('fs.read', () => ({ value: JSON.stringify({ directory: 'bt' }) }))
  // run-10 is newest by number but never got a run.db, so run-3 is the one read.
  on('fs.list', () => ({ value: [dir('run-2'), dir('run-3'), dir('run-10')] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: mtime, isLink: false } }))
  on('process.run', ($, e) => {
    expect(e.argv).toEqual(['sqlite3', '/proj/bt/tmp/run-3/run.db'])
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '',
                      isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'testing', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /run-3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /8\/13 steps/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✗1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /llm 25%/ })).toBeDefined()
    await ui.unmount()
  }
  // Locked out had already failed when we first looked: not news.
  expect(toasts).toEqual([])

  rows = data({
    failures: [{ id: 9, scenario: 'Wrong password', step: 'Then I should see "Invalid"', reason: 'saw "Welcome"' },
               ...data().failures],
  })
  mtime = 2
  await clock.advance(3000)
  expect(toasts).toEqual(['✗ Wrong password: saw "Welcome"'])
})
