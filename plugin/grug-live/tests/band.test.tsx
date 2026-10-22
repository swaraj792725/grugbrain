import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const status = {
  savedPct: 0.56,
  netUsd: 412,
  tokens: 160000,
  limit: 200000,
  alerts: ['cache expired while idle'],
  recent: 'Trimmed npm test output',
  grug: { act: 'smash', say: 'GRUG SMASH NOISY OUTPUT', short: 'SMASH NOISE', frames: ['🧔🦴   ≋≋≋', '🧔  💥 ≋'], svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' }
}

function world(on: On, lines: (string | undefined)[], toasts: string[]) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', async () => ({ value: JSON.stringify({ argv: ['node', 'cli.js', 'app-status'] }) }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '' } }) as any)
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined } as any
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return clock
}

test('grug lives in the footer entry only: animated frames, short line, saving; no band above the prompt', async ($, on) => {
  const lines: (string | undefined)[] = []
  const toasts: string[] = []
  const clock = world(on, lines, toasts)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clock.advance(1000)
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.some(l => l?.startsWith('🧔🦴   ≋≋≋ SMASH NOISE'))).toBe(true)
  expect(lines.some(l => l?.startsWith('🧔  💥 ≋ SMASH NOISE'))).toBe(true)
  expect(lines.every(l => (l ?? '').length <= 48)).toBe(true)
  expect(lines[0]).toContain('56% saved')
  expect(lines[0]).toContain('ctx 160k')
  expect(toasts).toEqual(['grug: cache expired while idle'])
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  expect(await ui.find({ text: /SMASH/ })).toBeUndefined()
  expect(await ui.find({ text: 'engine' })).toBeDefined()
})

test('where the app draws the hint below the prompt, grug is also drawn there; the text entry stays (desktop showed nothing)', async ($, on) => {
  const lines: (string | undefined)[] = []
  const clock = world(on, lines, [])
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } as any })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('GRUG SMASH NOISY OUTPUT')
  expect(await ui.find({ text: /SMASH NOISE · 56% saved · ctx 160k/ })).toBeDefined()
  await clock.advance(2000)
  expect(lines.at(-1)).toContain('SMASH NOISE')
})

test('the terminal keeps its own hint line; grug stays a text entry there', async ($, on) => {
  const lines: (string | undefined)[] = []
  const clock = world(on, lines, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as any })
  expect(await ui.find({ text: /SMASH/ })).toBeUndefined()
  await clock.advance(1000)
  expect(lines.some(l => l?.includes('SMASH NOISE'))).toBe(true)
})
