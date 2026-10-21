import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Status } from '../types'

const REPO = 'https://github.com/swaraj792725/grugbrain'
const IDLE_FRAMES = ['(ò_ó)', '(ò_ó)', '(-_ó)', '(ò_ó)']
const bar = (f: number, w: number) => {
  const n = Math.round(Math.max(0, Math.min(1, f)) * w)
  return '█'.repeat(n) + '░'.repeat(w - n)
}
const k = (n: number) => `${Math.round(n / 1000)}k`
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

/** The numbers and grug's scene from `grug app-status`; the band reads it, so a write redraws the band. */
const statusAtom = atom({ plugin: 'grug-live', key: 'status' } as const, {})

let argv: string[] | null = null
let status: Status = {}
let busy = false
let frame = 0
let notified = ''
let rendered = false
let lastRefresh = 0
let shown = ''
/** While idle the numbers barely move: refresh every 2 min instead of every 15 s (each refresh starts a node process). */
const IDLE_REFRESH_MS = 120000

/** Tell grug the plugin really loaded / drew (`grug doctor` reports it). Once per session each; failures ignored. */
async function ping($: any, kind: string) {
  if (kind === 'render') {
    if (rendered) return
    rendered = true
  }
  try {
    if (!argv) argv = JSON.parse(await $.fs.read(`${$.plugin.root}/grug.json`)).argv
    await $.process.run([...argv!.slice(0, -1), 'live-ping', kind], { timeoutMs: 4000 })
  } catch {
    /* grug missing: nothing to report */
  }
}

async function refresh($: any) {
  lastRefresh = Date.now()
  try {
    if (!argv) argv = JSON.parse(await $.fs.read(`${$.plugin.root}/grug.json`)).argv
    const r = await $.process.run(busy ? [...argv!, '--busy'] : argv, { timeoutMs: 8000 })
    if (r.exitCode === 0) status = JSON.parse(r.stdout || '{}')
    const alert = (status.alerts ?? [])[0]
    if (alert && alert !== notified && !status.quiet) $.ui.toast(`grug: ${alert}`)
    notified = alert ?? ''
    await update($, statusAtom, () => status)
  } catch {
    /* grug missing or busy: keep the last numbers */
  }
}

/** One text line (status entry, and the band where no SVG is drawn): grug's face animates frame by frame. */
function line(s: Status): string {
  const frames = s.grug?.frames ?? IDLE_FRAMES
  const parts = [`${frames[frame % frames.length]} ${s.grug?.say ?? (busy ? 'GRUG WATCH CLAUDE WORK' : 'grug on')}`]
  if (s.savedPct !== undefined) parts.push(`saved ${bar(s.savedPct, 10)} ~${Math.round(s.savedPct * 100)}%`)
  if (s.tokens && s.limit) parts.push(`ctx ${bar(s.tokens / s.limit, 8)} ${k(s.tokens)}`)
  if (s.alerts?.[0]) parts.push(`⚠ ${s.alerts[0]}`)
  else if (s.recent) parts.push(s.recent.slice(0, 50))
  return parts.join(' │ ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void ping($, 'session')
    await refresh($)
    $.clock.every(1000, () => {
      frame += 1
      const l = status.quiet ? '' : line(status)
      if (l !== shown) {
        shown = l
        $.ui.status(l || undefined)
      }
    })
    $.clock.every(15000, () => {
      if (busy || Date.now() - lastRefresh >= IDLE_REFRESH_MS) void refresh($)
    })
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    busy = true
    refresh($).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    busy = false
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    void ping($, 'render')
    const s = await read($, statusAtom)
    if (e.props.hasSurvey || s.quiet) return next(e)
    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text color="claude">{line(s)}</Text>
        </Box>
      )
    }
    const { Box, Text, Svg, Link } = $.ui.resolve(e)
    const g = s.grug
    const alert = s.alerts?.[0]
    const ctx = s.tokens && s.limit ? s.tokens / s.limit : 0
    const ctxColor = ctx >= 1 ? 'error' : ctx >= 0.75 ? 'warning' : 'success'
    return (
      <Box flexDirection="row" alignItems="center" gap="sm">
        {g ? <Svg source={g.svg} alt={g.say} width={104} height={50} isInteractive /> : <Text>{IDLE_FRAMES[0]}</Text>}
        <Box flexDirection="column" flexShrink={1}>
          <Text weight="bold" color={alert ? 'warning' : 'claude'}>
            {g?.say ?? 'grug on'}
          </Text>
          <Text>
            {s.savedPct !== undefined ? <Text dimColor>saved </Text> : ''}
            {s.savedPct !== undefined ? <Text color="success">{bar(s.savedPct, 10)}</Text> : ''}
            {s.savedPct !== undefined ? <Text weight="bold"> ~{Math.round(s.savedPct * 100)}%</Text> : ''}
            {s.netUsd && s.netUsd >= 0.01 ? <Text dimColor> ({usd(s.netUsd)} this week)</Text> : ''}
            {ctx ? <Text dimColor>{'  │  ctx '}</Text> : ''}
            {ctx ? <Text color={ctxColor}>{bar(ctx, 8)}</Text> : ''}
            {ctx ? <Text weight="bold"> {k(s.tokens!)}</Text> : ''}
          </Text>
          <Text dimColor italic wrap="truncate-end">
            {alert ? `⚠ ${alert}` : s.recent ? `last: ${s.recent.slice(0, 70)}` : 'grugbrain: grug make Claude use few token'}
            {'  '}
            <Link href={REPO} label="what is grug? ↗" />
          </Text>
        </Box>
      </Box>
    )
  })
}
