import type { Register } from 'claude-code'

const FRAMES = ['🪨', '🪨.', '🪨..', '🪨...']
const bar = (f: number, w: number) => {
  const n = Math.round(Math.max(0, Math.min(1, f)) * w)
  return '█'.repeat(n) + '░'.repeat(w - n)
}
const k = (n: number) => `${Math.round(n / 1000)}k`

type Status = {
  savedPct?: number
  netUsd?: number
  tokens?: number
  limit?: number
  recent?: string
  alerts?: string[]
}

let argv: string[] | null = null
let status: Status = {}
let busy = false
let frame = 0
let notified = ''
let lastPing = 0

/** Tell grug the plugin really loaded / drew (`grug doctor` reports it). Throttled; failures ignored. */
async function ping($: any, kind: string) {
  const now = Date.now()
  if (kind === 'render' && now - lastPing < 60000) return
  lastPing = now
  try {
    if (!argv) argv = JSON.parse(await $.fs.read(`${$.plugin.root}/grug.json`)).argv
    await $.process.run([...argv!.slice(0, -1), 'live-ping', kind], { timeoutMs: 4000 })
  } catch {
    /* grug missing: nothing to report */
  }
}

async function refresh($: any) {
  try {
    if (!argv) argv = JSON.parse(await $.fs.read(`${$.plugin.root}/grug.json`)).argv
    const r = await $.process.run(argv, { timeoutMs: 8000 })
    if (r.exitCode === 0) status = JSON.parse(r.stdout || '{}')
    const alert = (status.alerts ?? [])[0]
    if (alert && alert !== notified) $.ui.toast(`grug: ${alert}`)
    notified = alert ?? ''
  } catch {
    /* grug missing or busy: keep the last numbers */
  }
}


export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    void ping($, 'session')
    await refresh($)
    $.clock.every(1000, () => {
      frame += 1
      $.ui.status(line())
    })
    $.clock.every(15000, () => refresh($))
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    busy = false
    await refresh($)
    return next(e)
  })

  const line = () => {
    const parts = [busy ? `grug working ${FRAMES[frame % FRAMES.length]}` : '🪨 grug on']
    if (status.savedPct !== undefined) parts.push(`saved ${bar(status.savedPct, 10)} ~${Math.round(status.savedPct * 100)}%`)
    if (status.tokens && status.limit) parts.push(`ctx ${bar(status.tokens / status.limit, 8)} ${k(status.tokens)}`)
    if (status.alerts?.[0]) parts.push(`⚠ ${status.alerts[0]}`)
    else if (status.recent) parts.push(status.recent.slice(0, 50))
    return parts.join(' │ ')
  }

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    void ping($, 'render')
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{line()}</Text>
      </Box>
    )
  })
}
