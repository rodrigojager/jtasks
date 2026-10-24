// The files of a run (plan section 5) and the plan the model hands to `tasks plan` (section 3).

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
  /** Where a detached hold writes its output (relative to the run folder). */
  out?: string
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
}

export interface ClaudeProfile {
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
  sessions: Session[]
}

/** One task as the planner writes it. */
export interface PlanTask {
  id: string
  title: string
  what?: string
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
  profiles?: Record<string, Profile>
  serialize?: string[]
  maxAttempts?: number
  branch?: "run" | "current"
  tasks: PlanTask[]
}

export const DEFAULT_PROFILES: Record<string, Profile> = {
  impl: { claude: { model: "sonnet", effort: "medium", role: "backend-developer" }, opencode: { agent: "impl" } },
  deep: { claude: { model: "opus", effort: "high" }, opencode: { agent: "impl-deep" } },
  review: { claude: { model: "sonnet", effort: "high", role: "code-reviewer" }, opencode: { agent: "review" } },
}

export const DEFAULT_PROFILE = "impl"
export const DEFAULT_MAX_ATTEMPTS = 2
