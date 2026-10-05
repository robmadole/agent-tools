// deskcheck band: under the prompt, the running /deskcheck review's URL and
// hunks reviewed (polled from server.py's /api/progress).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Progress } from '../types'

const url = atom({ plugin: 'quality', key: 'url' } as const, null)
const progress = atom({ plugin: 'quality', key: 'progress' } as const, null)

// server.py prints this on startup; Claude reads it back in deskcheck step 4.
const SERVING = /Serving on (http:\/\/127\.0\.0\.1:\d+)/g

let timer: Timer | undefined

async function poll($: EngineInterface, base: string) {
  try {
    const res = await $.http.fetch(`${base}/api/progress`)
    if (!res.ok) throw new Error(String(res.status))
    const p = JSON.parse(res.text) as Progress
    await update($, progress, () => p)
  } catch {
    // ponytail: one failed poll = server gone; a relaunch re-arms us via its Serving line
    timer?.cancel()
    await update($, url, () => null)
    await update($, progress, () => null)
  }
}

function watch($: EngineInterface, base: string) {
  timer?.cancel()
  void poll($, base)
  timer = $.clock.every(5000, () => void poll($, base))
}

export const register: Register = on => {
  timer = undefined

  on('session.start', async ($, e, next) => {
    const saved = await read($, url)
    if (saved) watch($, saved)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const found = [...JSON.stringify(ran.result ?? '').matchAll(SERVING)].pop()?.[1]
    if (found && found !== (await read($, url))) {
      await update($, url, () => found)
      await update($, progress, () => null)
      watch($, found)
    }
    return ran
  })

  // Under the prompt: ours first, then the engine's hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const href = await read($, url)
    if (!href) return next(e)

    const hint = await next(e)
    const p = await read($, progress)
    const done = p !== null && p.total > 0 && p.reviewed === p.total
    const { Box, Text, Link } = $.ui.resolve(e)

    return (
      <Box>
        {/* ponytail: Unicode has no desk emoji; 🖥️ needs VS16 and drifts a column in some terminals */}
        <Text>📋 </Text>
        <Text color="magenta" bold>deskcheck </Text>
        {/* desktop only links https: or http://localhost */}
        <Link href={href.replace('127.0.0.1', 'localhost')} />
        <Text color={p ? (done ? 'green' : 'yellow') : 'gray'}>
          {p ? `  ${p.reviewed}/${p.total} hunks reviewed` : '  …'}
        </Text>
        <Text>  </Text>
        {hint}
      </Box>
    )
  })
}
