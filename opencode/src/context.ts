// The protocol and the run's progress line, in every model request of a bound session (and in compaction), so
// that the list survives compaction. Read from tasks.json/run.json only: no jlock call per request.

import { progressLine, protocolText, readRun, readTasks, runDir, tr } from "../core/core.js"
import type { Host } from "../core/core.js"
import type { RunBinding } from "./binding.ts"

export const CONTEXT_SOURCE = "goal-tasks"

export async function contextText(host: Host, binding: RunBinding): Promise<string | undefined> {
  const dir = runDir(binding.root, binding.run)
  const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  if (!run || !tasks) return undefined
  const summary = run.status === "paused" ? `${tr("status.paused")} · ${progressLine(tasks.tasks)}` : progressLine(tasks.tasks)
  return protocolText(run.id, summary, "the subagent tool, agent = the task's profile agent")
}

/** Replaces our part of the system prompt (never two copies, never a stale one). */
export function injectSystem(
  system: { type: "text"; text: string; metadata?: Record<string, unknown> }[],
  text: string | undefined,
): void {
  for (let i = system.length - 1; i >= 0; i--) if (system[i]?.metadata?.["source"] === CONTEXT_SOURCE) system.splice(i, 1)
  if (text) system.push({ type: "text", text, metadata: { source: CONTEXT_SOURCE } })
}
