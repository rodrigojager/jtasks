// Profiles (section 13): a task's profile names an OpenCode agent (`opencode.agent`) and optionally its model.
// The `subagent` call of a task (`--task <id>` in its prompt) gets the agent of the task's profile; a profile the
// run does not have refuses the call. Agents named by the profiles get the profile's model through agent.transform.

import { readTasks, runDir, tr } from "../core/core.js"
import type { Host, Profile } from "../core/core.js"
import type { RunBinding } from "./binding.ts"

export const SUBAGENT_TOOLS = new Set(["subagent", "task"])

export function taskOfPrompt(prompt: string): { run?: string; task?: string } {
  const task = /--task[=\s]+([^\s]+)/.exec(prompt)?.[1]
  const run = /--run[=\s]+([^\s]+)/.exec(prompt)?.[1]
  return { run, task }
}

export interface SpawnDecision {
  agent?: string
  error?: string
}

/** Which agent a subagent call of a task must use, or why it is refused. */
export async function agentFor(host: Host, binding: RunBinding, prompt: string): Promise<SpawnDecision> {
  const { run, task } = taskOfPrompt(prompt)
  if (!task) return {}
  if (run && run !== binding.run) return { error: tr("spawn.other_run", { run, bound: binding.run }) }
  const tasks = await readTasks(host, runDir(binding.root, binding.run)).catch(() => undefined)
  const t = tasks?.tasks.find((x) => x.id === task)
  if (!tasks || !t) return { error: tr("task.not_found", { run: binding.run, id: task }) }
  const profile = tasks.profiles[t.profile]
  if (!profile) return { error: tr("spawn.unknown_profile", { profile: t.profile, profiles: Object.keys(tasks.profiles).join(", ") }) }
  return profile.opencode?.agent ? { agent: profile.opencode.agent } : {}
}

export interface AgentEditorLike {
  get(id: string): { model?: unknown } | undefined
  update(id: string, update: (agent: { model?: unknown }) => void): void
}

/** The profiles whose agent the editor does not know, as `[profile, agent]` pairs (the plan is created anyway). */
export function missingAgents(editor: Pick<AgentEditorLike, "get">, profiles: Record<string, Profile>): [string, string][] {
  const missing: [string, string][] = []
  for (const [name, profile] of Object.entries(profiles)) {
    const agent = profile.opencode?.agent
    if (agent && !editor.get(agent)) missing.push([name, agent])
  }
  return missing
}

/** The warning line for a profile whose agent does not exist. */
export function agentMissingLine(profile: string, agent: string): string {
  return tr("profiles.agent_missing", { profile, agent })
}

/** Gives each agent named by a profile the profile's model, when the profile has one and the agent exists. */
export function applyProfileModels(editor: AgentEditorLike, profiles: Record<string, Profile>): string[] {
  const changed: string[] = []
  for (const profile of Object.values(profiles)) {
    const agent = profile.opencode?.agent
    const model = profile.opencode?.model
    if (!agent || !model || !editor.get(agent)) continue
    editor.update(agent, (a) => {
      a.model = { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
    })
    changed.push(agent)
  }
  return changed
}
