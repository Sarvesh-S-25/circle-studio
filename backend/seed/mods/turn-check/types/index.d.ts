export type TurnCheck = {
  /** seconds the turn took */
  seconds: number
  /** tool calls in the turn */
  tools: number
  /** files written or edited in the turn */
  changed: number
  /** a test command ran after the last change */
  tested: boolean
  /** how full the context window is, 0 to 100, when Claude Code says */
  percent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'turn-check': { last: TurnCheck | null; isHidden: boolean }
  }
}
