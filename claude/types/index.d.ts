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
  /** Its loop died on a transient failure and the run was paused with its task kept (rev. 5.7): resume it, never open another. */
  paused?: boolean
  /** Its loop ended while a process of its task ran (rev. 5.8): the task waits in progress; its next turn ends the wait. */
  awaiting?: boolean
  /** Commands it started in the background (Bash `run_in_background`) since its turn began (rev. 5.8). */
  background?: string[]
}

/** One checklist line of the pane (the core's ViewLine). */
export type PaneLine = {
  mark: string
  id: string
  title: string
  detail: string
  state: 'done' | 'running' | 'waiting' | 'ready' | 'blocked' | 'skipped' | 'failed'
  /** A short note the row adds (rev. 5.6): what a task waits for after a yield, or its saved edits. */
  note?: string
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
      /** The keepalive gave up on the run as it stands: one line under the tasks. */
      notice?: string
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
