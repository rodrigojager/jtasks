// The files of a run (plan section 5) and the plan the model hands to `jtasks plan` (section 3).

export type TaskStatus = "pending" | "in_progress" | "done" | "skipped" | "failed"
export type RunStatus = "active" | "paused" | "done"
export type ToolName = "cli" | "claude" | "opencode"

export interface Acceptance {
  text: string
  done: boolean
}

export interface Hold {
  /** Informative only. */
  pid?: number
  keys: string[]
  startedAt: string
  kind: "start" | "claim"
}

export interface WaitingFor {
  key: string
  holder: string
  position: number
  via: string
}

export interface Task {
  id: string
  title: string
  what?: string
  /** Where the task came from: the spec, issue or document the plan was made from (a path or a URL). */
  source?: string
  status: TaskStatus
  dependsOn: string[]
  profile: string
  files: string[]
  claimed?: string[]
  exclusive?: boolean
  acceptance: Acceptance[]
  boundary?: string
  attempts: number
  owner?: string | null
  startedAt?: string
  finishedAt?: string
  commit?: string | null
  evidence?: string
  reason?: string
  error?: string
  holds?: Hold[]
  /** When the task went back to pending because its lock was taken away (shown as "posse perdida"). */
  lost?: string
}

export interface ClaudeProfile {
  /** The subagent type the spawn becomes, e.g. `jtasks:execute`, one of the agents the mod ships. */
  agent?: string
  model?: string
  effort?: string
  role?: string
}

export interface OpenCodeProfile {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
}

export interface Profile {
  claude?: ClaudeProfile
  opencode?: OpenCodeProfile
}

export interface TasksFile {
  version: 1
  run: string
  revision: number
  profiles: Record<string, Profile>
  tasks: Task[]
}

export interface Session {
  tool: ToolName
  id: string
  boundAt: string
}

export interface RunFile {
  version: 1
  id: string
  feature: string
  objective: string
  status: RunStatus
  created: string
  repo: { root: string; baseBranch: string; branch: string }
  worktrees: { policy: "none" }
  serialize: string[]
  maxAttempts: number
  /** How long a task's locks live if nobody gives them back (`--ttl` of every hold), e.g. `2h`. */
  holdTtl: string
  sessions: Session[]
}

/** One task as the planner writes it. */
export interface PlanTask {
  id: string
  title: string
  what?: string
  source?: string
  dependsOn?: string[]
  files?: string[]
  acceptance?: (string | { text: string; done?: boolean })[]
  profile?: string
  boundary?: string
  exclusive?: boolean
}

/** The whole plan, or one batch of it (`plan --add`). */
export interface PlanInput {
  feature?: string
  objective?: string
  /** The spec, issue or document the plan was made from; every task without its own `source` gets it. */
  source?: string
  profiles?: Record<string, Profile>
  serialize?: string[]
  maxAttempts?: number
  holdTtl?: string
  branch?: "run" | "current"
  tasks: PlanTask[]
}

export const DEFAULT_PROFILES: Record<string, Profile> = {
  execute: { claude: { agent: "jtasks:execute", model: "sonnet", effort: "medium", role: "backend-developer" }, opencode: { agent: "execute" } },
  "execute-deep": { claude: { agent: "jtasks:execute-deep", model: "opus", effort: "high" }, opencode: { agent: "execute-deep" } },
  review: { claude: { agent: "jtasks:review", model: "sonnet", effort: "high", role: "code-reviewer" }, opencode: { agent: "review" } },
}

export const DEFAULT_PROFILE = "execute"
export const DEFAULT_MAX_ATTEMPTS = 2
/** The `--ttl` of every hold: the lock expires by itself after this long if nobody gives it back. */
export const DEFAULT_HOLD_TTL = "2h"
export const DURATION = /^\d+(ms|s|m|h|d)$/
