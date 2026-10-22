import type { Register } from 'claude-code'

import type { Status } from '../types'

const IDLE_FRAMES = ['(ò_ó)', '(ò_ó)', '(-_ó)', '(ò_ó)', '(ó_ò)']
/** Matches grugart.ts FRAME_MS: grug's next pose every 450 ms. */
const FRAME_MS = 450

let argv: string[] | null = null
let status: Status = {}
let busy = false
let frame = 0
let notified = ''
let lastRefresh = 0
let shown = ''
/** While idle the numbers barely move: refresh every 2 min instead of every 15 s (each refresh starts a node process). */
const IDLE_REFRESH_MS = 120000

/** Tell grug the plugin really loaded / drew (`grug doctor` reports it). Once per session each; failures ignored. */
let drew = false
async function ping($: any, kind: string) {
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
  } catch {
    /* grug missing or busy: keep the last numbers */
  }
}

/** The one footer entry below the prompt: grug acting out his job, a short caveman line, the saving. Kept short so the
 *  footer does not cut it; the full alert goes to a toast. */
export function line(s: Status, f: number): string {
  const frames = s.grug?.frames?.length ? s.grug.frames : IDLE_FRAMES
  const parts = [`${frames[f % frames.length]} ${s.grug?.short ?? (busy ? 'WATCH CLAUDE' : 'grug on')}`]
  if (s.savedPct !== undefined && s.savedPct > 0) parts.push(`${Math.round(s.savedPct * 100)}% saved`)
  if (s.tokens && s.limit && s.tokens / s.limit >= 0.75) parts.push(`ctx ${Math.round(s.tokens / 1000)}k`)
  return parts.join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void ping($, 'session')
    await refresh($)
    $.clock.every(FRAME_MS, () => {
      frame += 1
      const l = status.quiet ? '' : line(status, frame)
      if (l === shown) return
      shown = l
      $.ui.status(l || undefined)
      if (l && !drew) {
        drew = true
        void ping($, 'render')
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
}
