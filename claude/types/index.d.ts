// The goal-tasks mod's $.state contract.

/** The run bound to this session (subagents share it). */
export type BoundRun = {
  run: string
  /** The repository root of the run. */
  root: string
}

declare module 'claude-code' {
  interface PluginState {
    'goal-tasks': {
      run: BoundRun | null
      collapsed: boolean
    }
  }
}
