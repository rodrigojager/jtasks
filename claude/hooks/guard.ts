// The ownership guard of the mod: the core's rule (src/guard.ts), decided from tasks.json without asking jlock. A
// subagent bound to a task edits only inside its ownership and runs no mutating git; nobody edits the run's own
// files by hand.

import { checkEdit, checkShell, readTasks, runDir, type Host, type Verdict } from '../core/core.js'
import type { AgentTask, BoundRun } from '../types'

export type GuardedCall =
  | { tool: 'Edit' | 'Write' | 'MultiEdit'; file_path: string }
  | { tool: 'NotebookEdit'; notebook_path: string }
  | { tool: 'Bash'; command: string }

/** The verdict on one call of the main agent (no task) or of a subagent (its task, when it has one in progress). */
export async function judgeCall(host: Host, cwd: string, bound: BoundRun, agent: AgentTask | undefined, call: GuardedCall): Promise<Verdict> {
  let task
  if (agent && agent.run === bound.run) {
    const tasks = await readTasks(host, runDir(bound.root, bound.run))
    task = tasks?.tasks.find((t) => t.id === agent.task && t.status === 'in_progress')
  }
  const ctx = { root: bound.root, platform: host.platform, cwd, task, home: host.env('HOME') ?? host.env('USERPROFILE') }
  if (call.tool === 'Bash') return checkShell(ctx, call.command)
  return checkEdit(ctx, call.tool === 'NotebookEdit' ? call.notebook_path : call.file_path)
}
