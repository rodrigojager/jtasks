// Compact text for the model and for people: one line of progress, the frontier, the runs.

import type { RunFile, Task, TasksFile } from "./schema.ts"

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function progressLine(tasks: Task[]): string {
  const c = counts(tasks)
  const parts = [`feitas ${c.done}/${c.total} (${c.percent}%)`]
  if (c.skipped) parts.push(plural(c.skipped, "pulada", "puladas"))
  if (c.failed) parts.push(plural(c.failed, "falha", "falhas"))
  if (c.inProgress) parts.push(`${c.inProgress} em andamento`)
  parts.push(`restam ${c.remaining}`)
  return parts.join(" · ")
}

export function runLine(run: RunFile, tasks: TasksFile | undefined): string {
  const c = tasks ? counts(tasks.tasks) : undefined
  const prog = c ? `${c.done}/${c.total} (${c.percent}%)` : "sem tasks.json"
  return `${run.id} · ${run.status} · ${prog} · ${run.objective || run.feature}`
}

export function formatRunsList(runs: { run: RunFile; tasks?: TasksFile }[]): string {
  if (runs.length === 0) return "nenhuma execução neste repositório (crie uma com tasks plan)"
  return runs.map((r) => runLine(r.run, r.tasks)).join("\n")
}

export function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n")
}
