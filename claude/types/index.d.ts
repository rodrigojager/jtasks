// The jtasks mod's $.state contract.

/** The run bound to this session (subagents share it). */
export type BoundRun = {
  run: string
  /** The repository root of the run. */
  root: string
}

/** The task a subagent works on (from its spawn's `--task`, or its own `jtasks start`). */
export type AgentTask = {
  run: string
  task: string
  /** The effort of the task's profile, set on every model request of the subagent's loop. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** One checklist line of the pane (the core's ViewLine). */
export type PaneLine = {
  mark: string
  id: string
  title: string
  detail: string
  state: 'done' | 'running' | 'waiting' | 'ready' | 'blocked' | 'skipped' | 'failed'
}

/** What the pane draws (the core's View): a run's checklist, or the repository's runs when none is bound. */
export type PaneView =
  | {
      kind: 'run'
      run: string
      paused: boolean
      done: number
      total: number
      skipped: number
      failed: number
      remaining: number
      percent: number
      lines: PaneLine[]
    }
  | { kind: 'runs'; runs: { id: string; status: string; done: number; total: number; percent: number }[] }

declare module 'claude-code' {
  interface PluginState {
    'jtasks': {
      run: BoundRun | null
      collapsed: boolean
      view: Shaped<PaneView | null>
      agents: Record<string, AgentTask>
    }
  }
}
