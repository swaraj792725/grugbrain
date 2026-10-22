export type GrugScene = { act: string; say: string; short: string; frames: string[]; svg?: string }

export type Status = {
  savedPct?: number
  netUsd?: number
  tokens?: number
  limit?: number
  idleMs?: number
  recent?: string
  alerts?: string[]
  quiet?: boolean
  grug?: GrugScene
}

declare module 'claude-code' {
  interface PluginState {
    'grug-live': { status: Status }
  }
}
