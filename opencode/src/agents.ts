// A subagent that ends with its task still in progress (section 9, "agente morto"): its child session goes idle
// or is deleted; the task bound to that session goes through the core's `release --agent-ended`, as the mod does on
// turn.complete. Rev. 5.8: while a process the task registered (`jtasks exec`, `jtasks wait`) lives, the task waits for
// it in progress with its locks (the session keeps its binding); otherwise it goes back to the queue without spending
// an attempt, and at the run's `maxAgentEnded` it fails and the run pauses for a person. Unless `kept` says the
// session died on a transient failure and the run was paused with the task kept (rev. 5.7).

import { readTasks, runDir, type Host, type ToolResult } from "../core/core.js"
import type { Bindings } from "./binding.ts"

export type SessionEnd = "idle" | "deleted"

/**
 * What to do when a session ends. Only a child session (a subagent's) that started a task counts: the root session
 * going idle is the orchestrator waiting, not a death. The task is released only while it is still in progress and
 * owned by that session; a task the subagent finished (done, skip, fail) is left alone.
 */
export async function onSessionEnded(
  host: Host,
  bindings: Bindings,
  sessionID: string,
  end: SessionEnd,
  call: (sessionID: string, command: string) => Promise<ToolResult>,
  kept?: (task: string) => Promise<boolean>,
): Promise<ToolResult | undefined> {
  if (end === "idle" && !(await bindings.isChild(sessionID))) return undefined
  const bound = await bindings.task(sessionID)
  if (!bound) return undefined
  const run = await bindings.run(sessionID)
  if (!run || run.run !== bound.run) return undefined
  const tasks = await readTasks(host, runDir(run.root, run.run)).catch(() => undefined)
  const task = tasks?.tasks.find((t) => t.id === bound.task)
  if (!task || task.status !== "in_progress" || !task.owner?.endsWith(`/agent:${sessionID}`)) return undefined
  if (kept && (await kept(task.id).catch(() => false))) return undefined
  return call(sessionID, `release ${task.id} --agent-ended`)
}
