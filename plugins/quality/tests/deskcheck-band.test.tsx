import { expect, mock, test } from 'claude-code/testing'

const URL = 'http://127.0.0.1:51234'
const BAND = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never } as const

test('band links the review, counts hunks, clears when the server dies', async ($, on) => {
  const clock = mock.clock(on)
  let progress: string | null = '{"reviewed":3,"total":12}'

  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">? for shortcuts</Text>
  })
  on('tool.call', () => ({ result: { stdout: `Serving on ${URL}\n`, stderr: '', interrupted: false } }))
  on('http.fetch', (_$, e) => ({
    value:
      e.url === `${URL}/api/progress` && progress
        ? { status: 200, ok: true, headers: {}, text: progress }
        : { status: 502, ok: false, headers: {}, text: '' },
  }))

  const draw = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ plugin: 'quality', surface, ...BAND })
    const link = (await ui.find({ type: 'Link' }))?.props.href
    const count = (await ui.find({ type: 'Text', text: /hunks reviewed/ }))?.text
    const hint = (await ui.find({ type: 'Text', text: /for shortcuts/ }))?.text
    await ui.unmount()
    return { link, count, hint }
  }

  expect((await draw('terminal')).link).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'cat /tmp/out' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const { link, count, hint } = await draw(surface)
    expect(link).toBe('http://localhost:51234')
    expect(count).toContain('3/12 hunks reviewed')
    expect(hint).toBe('? for shortcuts')
  }

  progress = '{"reviewed":7,"total":12}'
  await clock.advance(5000)
  expect((await draw('terminal')).count).toContain('7/12 hunks reviewed')

  progress = null
  await clock.advance(5000)
  expect((await draw('terminal')).link).toBeUndefined()
})
