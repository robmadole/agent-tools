// browser-test status: a band above the prompt and a toast per failure, for the newest /browser-test
// run in this project. Everything is read from {directory}/tmp/run-N/run.db, which the skill's runners and
// orchestrator write as they go; no tool calls are watched.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { RunData, Seen, Snapshot } from '../types'
import { ago, llmColor, QUERY, STALL_MS, view } from './status'

const POLL_MS = 3000

const snapshot = atom({ plugin: 'testing', key: 'snapshot' } as const, null)
const seen = atom({ plugin: 'testing', key: 'seen' } as const, null)

let timer: Timer | undefined
// The db and its WAL's mtimes at the last read: unchanged means the same rows.
let lastKey = ''

async function newestRun($: EngineInterface, root: string): Promise<{ run: string; dir: string } | null> {
  const config = `${root}/.browser-tests.json`
  if (!(await $.fs.exists(config))) return null
  const directory = (JSON.parse(await $.fs.read(config)) as { directory?: string }).directory
  if (!directory) return null
  const tmp = `${root}/${directory}/tmp`
  if (!(await $.fs.exists(tmp))) return null
  const runs = (await $.fs.list(tmp))
    .map(entry => /^run-(\d+)$/.exec(entry.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const m of runs) {
    const dir = `${directory}/tmp/${m[0]}`
    if (await $.fs.exists(`${root}/${dir}/run.db`)) return { run: m[0], dir }
  }
  return null
}

async function mtime($: EngineInterface, path: string): Promise<number> {
  return (await $.fs.exists(path)) ? (await $.fs.stat(path)).mtimeMs : 0
}

async function toastFailures($: EngineInterface, dir: string, data: RunData) {
  const top = data.failures.reduce((max, f) => Math.max(max, f.id), 0)
  const before: Seen | null = await read($, seen)
  if (before?.dir !== dir) {
    // First look at this run: what already failed is in the band, not news.
    await update($, seen, () => ({ dir, failId: top }))
    return
  }
  const fresh = data.failures.filter(f => f.id > before.failId).sort((a, b) => a.id - b.id)
  for (const f of fresh.slice(-3)) {
    $.ui.toast(`✗ ${f.scenario}: ${f.reason ?? f.step}`)
  }
  if (fresh.length) await update($, seen, () => ({ dir, failId: top }))
}

async function tick($: EngineInterface) {
  const root = await $.session.root()
  const found = await newestRun($, root)
  const now = await $.clock.now()

  if (!found) {
    lastKey = ''
    if (await read($, snapshot)) await update($, snapshot, () => null)
    return
  }

  const db = `${root}/${found.dir}/run.db`
  const key = `${found.dir}:${await mtime($, db)}:${await mtime($, `${db}-wal`)}`
  const prev = await read($, snapshot)

  if (key === lastKey && prev) {
    // Same rows. Only redraw while something is unfinished, so "running" can turn into "stalled".
    const v = view(prev, now)
    if (v && !v.isDone && v.isVisible) await update($, snapshot, s => (s ? { ...s, checkedAt: now } : s))
    return
  }

  let next: Snapshot
  try {
    const res = await $.process.run(['sqlite3', db], { stdin: QUERY, timeoutMs: 10_000 })
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `sqlite3 exited ${res.exitCode}`)
    const data = JSON.parse(res.stdout) as RunData
    next = { ...found, data, error: null, checkedAt: now }
    await toastFailures($, found.dir, data)
    lastKey = key
  } catch (err) {
    // A db mid-creation or from an older skill: keep the last good rows, say why, try again next tick.
    next = { ...found, data: prev?.dir === found.dir ? prev.data : null, error: String(err), checkedAt: now }
  }
  await update($, snapshot, () => next)
}

export const register: Register = on => {
  timer = undefined
  lastKey = ''

  on('session.start', async ($, e, next) => {
    timer?.cancel()
    await tick($).catch(() => {})
    timer = $.clock.every(POLL_MS, () => void tick($).catch(() => {}))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const v = snap && view(snap, await $.clock.now())
    if (!v || !v.isVisible || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const { counts } = v
    const waiting = counts.queued + counts.not_run

    return (
      <Box>
        <Text>🧪 </Text>
        <Text color="cyan" bold>browser-test </Text>
        <Text dimColor>{v.run} · </Text>
        <Text>{v.phase}</Text>
        {v.pass && <Text dimColor> ({v.pass})</Text>}
        <Text dimColor> · {v.steps.done}/{v.steps.total} steps · </Text>
        <Text color="green">✓{counts.passed} </Text>
        <Text color={counts.failed ? 'red' : 'gray'}>✗{counts.failed} </Text>
        {v.running > 0 && <Text color="yellow">▶{v.running} </Text>}
        {v.stalled > 0 && <Text color="magenta">⏸{v.stalled} stalled </Text>}
        {counts.incomplete > 0 && <Text color="magenta">◐{counts.incomplete} </Text>}
        {waiting > 0 && <Text dimColor>· {waiting} waiting </Text>}
        {v.llmPct !== null && (
          <Text color={llmColor(v.llmPct)} dimColor={!llmColor(v.llmPct)}>
            · llm {v.llmPct}%{' '}
          </Text>
        )}
        {v.findings > 0 && <Text color="yellow">· {v.findings} findings </Text>}
        {v.flaky > 0 && <Text color="magenta">· {v.flaky} flaky </Text>}
        {v.quietMs > STALL_MS && <Text color="magenta">· quiet {ago(v.quietMs)}</Text>}
        {snap.error && <Text color="red">· can't read run.db</Text>}
      </Box>
    )
  })
}
