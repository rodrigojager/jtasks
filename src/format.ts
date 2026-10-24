// Compact text for the model and for people: one line of progress, the frontier, the runs.

import type { RunFile, Task, TasksFile } from "./schema.ts"
import { tr } from "./i18n.ts"

export interface Counts {
  total: number
  done: number
  skipped: number
  failed: number
  inProgress: number
  pending: number
  /** Neither done nor skipped: what the goal still waits for. */
  remaining: number
  percent: number
}

export function counts(tasks: Task[]): Counts {
  const c = { total: tasks.length, done: 0, skipped: 0, failed: 0, inProgress: 0, pending: 0 }
  for (const t of tasks) {
    if (t.status === "done") c.done++
    else if (t.status === "skipped") c.skipped++
    else if (t.status === "failed") c.failed++
    else if (t.status === "in_progress") c.inProgress++
    else c.pending++
  }
  return { ...c, remaining: c.total - c.done - c.skipped, percent: progress(c.done, c.total) }
}

/** `floor(done / total × 100)`. */
export function progress(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((done / total) * 100)
}

export function progressLine(tasks: Task[]): string {
  const c = counts(tasks)
  const parts = [tr("progress.done", { done: c.done, total: c.total, percent: c.percent })]
  if (c.skipped) parts.push(tr("progress.skipped", { n: c.skipped }))
  if (c.failed) parts.push(tr("progress.failed", { n: c.failed }))
  if (c.inProgress) parts.push(tr("progress.running", { n: c.inProgress }))
  parts.push(tr("progress.remaining", { n: c.remaining }))
  return parts.join(" · ")
}

export function runLine(run: RunFile, tasks: TasksFile | undefined): string {
  const c = tasks ? counts(tasks.tasks) : undefined
  const prog = c ? `${c.done}/${c.total} (${c.percent}%)` : tr("runs.no_tasks_file")
  return `${run.id} · ${run.status} · ${prog} · ${run.objective || run.feature}`
}

export function formatRunsList(runs: { run: RunFile; tasks?: TasksFile }[]): string {
  if (runs.length === 0) return tr("runs.none")
  return runs.map((r) => runLine(r.run, r.tasks)).join("\n")
}

/**
 * The execution protocol (section 12), injected into the system prompt while a run is bound to the session. It
 * is for the model, so it is English in every language; it quotes the tool's own answers ("restam 0") in the
 * language the tool speaks. `spawn` names how the host opens a subagent.
 */
export function protocolText(run: string, summary: string, spawn: string): string {
  const finished = tr("progress.remaining", { n: 0 })
  const paused = tr("view.paused")
  return [
    `jtasks: bound run ${run} · ${summary}`,
    "Protocol:",
    "1. Call jtasks next.",
    `2. For each task it returns, open a subagent (${spawn}) with the profile it names, all in the same response (in parallel). ` +
      `The prompt carries only: --run ${run} --task <id>, the title, the criteria, the ownership (the files it may touch), the ticket's path, and ` +
      '"call jtasks start <id> first; if you need another file, jtasks claim <id> <file>; do not run git; ' +
      'at the end, jtasks done <id> --evidence with the evidence, or jtasks fail <id> --error".',
    `3. When they finish, call jtasks status. "${finished}" → the goal is met, with that output as the evidence. "${paused}" → stop. Otherwise go back to step 1.`,
    "4. Never edit tasks.json, the tickets or git by hand; only through the jtasks tool.",
  ].join("\n")
}

export function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n")
}
