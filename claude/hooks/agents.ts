// Subagents of a task (section 13): the spawn of a subagent whose prompt carries `--task <id>` becomes the agent and
// gets the model of the task's profile, with the profile's role in its prompt (`--role <id>`, the convention the roles mod
// reads) and the profile's effort on every model request of its loop; a profile the run does not have refuses the spawn. The `serialize` commands of the run, in a subagent's
// Bash, run through `jlock run` (one at a time on the machine).

import { readRun, readTasks, runDir, serializeEntry, serializeKey, type Host, tr } from '../core/core.js'
import type { BoundRun } from '../types'

export function taskOfPrompt(prompt: string): { run?: string; task?: string } {
  const task = /--task[=\s]+([^\s]+)/.exec(prompt)?.[1]
  const run = /--run[=\s]+([^\s]+)/.exec(prompt)?.[1]
  return { run, task }
}

export interface SpawnDecision {
  task?: string
  agent?: string
  model?: string
  effort?: Effort
  prompt?: string
  error?: string
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** A profile's effort as a level Claude Code takes, or nothing for any other text. */
export function effortOf(text: string | undefined): Effort | undefined {
  return text && EFFORTS.includes(text) ? (text as Effort) : undefined
}

/** What the spawn of a task's subagent must become, or why it is refused; `{}` for a spawn of no task. */
export async function spawnDecision(host: Host, bound: BoundRun, prompt: string): Promise<SpawnDecision> {
  const { run, task } = taskOfPrompt(prompt)
  if (!task) return {}
  if (run && run !== bound.run) return { error: tr('spawn.other_run', { run, bound: bound.run }) }
  const tasks = await readTasks(host, runDir(bound.root, bound.run)).catch(() => undefined)
  const t = tasks?.tasks.find((x) => x.id === task)
  if (!tasks || !t) return { error: tr('task.not_found', { run: bound.run, id: task }) }
  const profile = tasks.profiles[t.profile]
  if (!profile) return { error: tr('spawn.unknown_profile', { profile: t.profile, profiles: Object.keys(tasks.profiles).join(', ') }) }
  const c = profile.claude ?? {}
  const role = c.role ? `--role ${c.role} ` : ''
  const out: SpawnDecision = { task, prompt: `${role}${prompt}` }
  if (c.agent) out.agent = c.agent
  if (c.model) out.model = c.model
  const effort = effortOf(c.effort)
  if (effort) out.effort = effort
  return out
}

/** A POSIX single-quoted word. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** The command a subagent's Bash runs: through `jlock run` when it falls under the run's `serialize`. */
export async function serializedCommand(host: Host, bound: BoundRun, command: string, owner: string): Promise<string | undefined> {
  const run = await readRun(host, runDir(bound.root, bound.run)).catch(() => undefined)
  const entry = run ? serializeEntry(run.serialize, command) : undefined
  if (!entry) return undefined
  const key = serializeKey(bound.root, entry)
  return `jlock run ${quote(key)} --owner ${quote(owner)} --group ${quote(bound.run)} --intent ${quote(command)} -- sh -c ${quote(command)}`
}
