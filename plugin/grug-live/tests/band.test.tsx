import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On) {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', async () => ({ value: JSON.stringify({ argv: ['node', 'cli.js', 'app-status'] }) }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '' } }) as any)
}

const status = {
  savedPct: 0.56,
  netUsd: 412,
  tokens: 140000,
  limit: 200000,
  alerts: [],
  recent: 'Trimmed npm test output',
  grug: { act: 'smash', say: 'GRUG SMASH NOISY OUTPUT', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', frames: ['(ò_ó)', '(ง ò_ó)ง'] }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band shows grug's scene and the bars on ${surface}`, async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as any)
    const ui = await $.ui.mount({ plugin: 'grug-live', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
    expect(await ui.find({ text: /GRUG SMASH NOISY OUTPUT/ })).toBeDefined()
    expect(await ui.find({ text: /140k/ })).toBeDefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('GRUG SMASH NOISY OUTPUT')
  })
}

test('band yields while a survey holds it', async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  expect(await ui.find({ text: /GRUG SMASH/ })).toBeUndefined()
  expect(await ui.find({ text: 'survey' })).toBeDefined()
})
