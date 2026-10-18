export type Game = {
  /** where the dot is on the track, 0 .. WIDTH - 1 */
  pos: number
  /** 1 moving right, -1 moving left */
  dir: 1 | -1
  /** the first cell of the ring, which is RING cells wide */
  ring: number
  score: number
  best: number
  /** what the last press did: '' at the start */
  said: string
  /** Claude is working (the turn has not completed yet) */
  isWorking: boolean
  startedAt: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'waiting-game': { game: Game }
  }
}
