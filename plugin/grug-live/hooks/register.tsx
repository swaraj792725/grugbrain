import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Status } from '../types'

/** The numbers and grug's scene; the band above the prompt reads it, so a write redraws grug's stage. */
const statusAtom = atom({ plugin: 'grug-live', key: 'status' } as const, {})

let argv: string[] | null = null
let status: Status = {}
let busy = false
let notified = ''
let lastRefresh = 0
let shown = ''
/** While idle the numbers barely move: refresh every 2 min instead of every 15 s (each refresh starts a node process). */
const IDLE_REFRESH_MS = 120000
/** The desktop footer cuts an entry at about 45 chars after the `grug-live` label. */
const FOOTER_MAX = 45

/** The stage frame: the app sizes an interactive Svg to the default 300x150 unless told, so give it the band's
 *  width (cells x an estimate of the app's px per cell; `grug doctor` shows the cells seen) and one strip high. The
 *  drawing slices to fill any frame, cave at the left, so a wrong estimate only shows more or less of the scene. */
const PX_PER_CELL = 8
const STAGE_PX = 72

/** Tell grug the plugin really loaded / drew (`grug doctor` reports it). Once per session each; failures ignored. */
let drew = false
let staged = false
async function ping($: any, kind: string) {
  try {
    if (!argv) argv = JSON.parse(await $.fs.read(`${$.plugin.root}/grug.json`)).argv
    await $.process.run([...argv!.slice(0, -1), 'live-ping', ...kind.split(' ')], { timeoutMs: 4000 })
  } catch {
    /* grug missing: nothing to report */
  }
}

/** The footer entry below the prompt: what grug is doing and the numbers, plain text (the picture is the band above).
 *  Weekly dollars go first when it would not fit; the full alert goes to a toast. */
export function line(s: Status): string {
  const parts = [s.grug?.short ?? (busy ? 'WATCH CLAUDE' : 'grug on')]
  if (s.savedPct !== undefined && s.savedPct > 0) parts.push(`${Math.round(s.savedPct * 100)}% saved`)
  const usd = s.netUsd !== undefined && s.netUsd >= 1 ? `$${Math.round(s.netUsd)}/wk` : ''
  if (usd) parts.push(usd)
  if (s.tokens && s.limit && s.tokens / s.limit >= 0.75) parts.push(`ctx ${Math.round(s.tokens / 1000)}k`)
  const l = parts.join(' · ')
  return l.length > FOOTER_MAX && usd ? parts.filter(p => p !== usd).join(' · ') : l
}

function show($: any) {
  const l = status.quiet ? '' : line(status)
  if (l === shown) return
  shown = l
  $.ui.status(l || undefined)
  if (l && !drew) {
    drew = true
    void ping($, 'render')
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
    show($)
    await update($, statusAtom, () => status)
  } catch {
    /* grug missing or busy: keep the last numbers */
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void ping($, 'session')
    await refresh($)
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

  /** The band above the prompt: only grug's stage, animated by SMIL in the app's sandboxed frame; no words. The
   *  terminal draws no SVG, and a survey or the terminal's own grug status line come first. */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const s = await read($, statusAtom)
    const g = s.grug
    if (s.quiet || !g?.svg) return next(e)
    const cols = e.viewport?.columns ?? e.props.bodyColumns + 5
    if (!staged) {
      staged = true
      void ping($, `band ${cols} ${e.props.bodyColumns}`)
    }
    const { Svg } = $.ui.resolve(e)
    return <Svg source={g.svg} alt={g.say} width={Math.round(cols * PX_PER_CELL)} height={STAGE_PX} isInteractive />
  })
}
