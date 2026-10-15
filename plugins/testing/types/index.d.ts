// One scenario as run.db has it: the manifest row, the attempt that decides its verdict, and the attempt
// being worked on now (the same one, except during a focus pass or a re-run). Attempt fields are null when
// the scenario has no record yet.
export type ScenarioRow = {
  feature: string
  name: string
  expected: number
  run_id: string | null
  recorded: number | null
  passed: number | null
  failed: number | null
  active_run_id: string | null
  active_recorded: number | null
  active_failed: number | null
  // first and last record of the active attempt
  active_started: number | null
  active_ts: number | null
}

export type Failure = { id: number; scenario: string; step: string; reason: string | null }

// What one read of run.db returns.
export type RunData = {
  phase: string | null
  phase_at: number | null
  initialized_at: number | null
  last_ts: number | null
  scenarios: ScenarioRow[]
  lanes: Record<string, number>
  findings: Record<string, number>
  flaky: number
  failures: Failure[]
}

export type Snapshot = {
  // `run-7`, and the run dir relative to the project root
  run: string
  dir: string
  data: RunData | null
  error: string | null
  checkedAt: number
}

export type Seen = { dir: string; failId: number }

declare module 'claude-code' {
  interface PluginState {
    'testing': { snapshot: Snapshot | null; seen: Seen | null }
  }
}
