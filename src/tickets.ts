// Tickets are a view of tasks.json, in the format of the jlock tickets: generated, never edited by hand.

import { slugify, ticketNumber } from "./ids.ts"
import type { Host } from "./host.ts"
import { join } from "./paths.ts"
import type { Task, TasksFile } from "./schema.ts"

export function ticketFileName(task: Task, index: number): string {
  return `${ticketNumber(task.id, index)}-${slugify(task.title, 40)}.md`
}

/** Ticket numbers by task id, for "Blocked by". */
function numbers(tasks: Task[]): Map<string, string> {
  return new Map(tasks.map((t, i) => [t.id, ticketNumber(t.id, i)]))
}

export function renderTicket(task: Task, index: number, all: Task[]): string {
  const nums = numbers(all)
  const blocked = task.dependsOn.length ? task.dependsOn.map((d) => nums.get(d) ?? d).join(", ") : "None (can start immediately)"
  const files = task.exclusive
    ? "(exclusive: roda sozinha)"
    : task.files.length
      ? task.files.map((f) => `\`${f}\``).join(", ")
      : "(nenhum)"
  const claimed = task.claimed?.length ? `\n\n**Claimed:** ${task.claimed.map((f) => `\`${f}\``).join(", ")}` : ""
  const lines = [
    `# ${ticketNumber(task.id, index)}: ${task.title}`,
    "",
    `**What to build:** ${task.what?.trim() || task.title}`,
    "",
    `**Blocked by:** ${blocked}`,
    "",
    `**Status:** ${task.status}`,
    "",
    `**Profile:** ${task.profile}`,
    "",
    `**Files:** ${files}${claimed}`,
    "",
  ]
  for (const a of task.acceptance) lines.push(`- [${a.done ? "x" : " "}] ${a.text}`)
  if (task.acceptance.length) lines.push("")
  if (task.commit) lines.push(`**Commit:** ${task.commit}`, "")
  if (task.evidence) lines.push(`**Evidence:** ${task.evidence}`, "")
  if (task.reason) lines.push(`**Reason:** ${task.reason}`, "")
  if (task.error) lines.push(`**Error:** ${task.error}`, "")
  if (task.boundary) lines.push(`**Scope boundary:** ${task.boundary}`, "")
  return lines.join("\n")
}

/** Writes every ticket of the run (and removes tickets of tasks that no longer exist). */
export async function writeTickets(host: Host, runDir: string, tasks: TasksFile): Promise<string[]> {
  const dir = join(runDir, "tickets")
  const names = tasks.tasks.map((t, i) => ticketFileName(t, i))
  await host.mkdir(dir)
  for (let i = 0; i < tasks.tasks.length; i++)
    await host.writeText(join(dir, names[i]!), renderTicket(tasks.tasks[i]!, i, tasks.tasks))
  for (const entry of await host.list(dir))
    if (entry.kind === "file" && entry.name.endsWith(".md") && !names.includes(entry.name)) await host.remove(join(dir, entry.name))
  return names.map((n) => join(dir, n))
}

/** Rewrites one task's ticket after a transition. */
export async function writeTicket(host: Host, runDir: string, tasks: TasksFile, id: string): Promise<void> {
  const index = tasks.tasks.findIndex((t) => t.id === id)
  if (index < 0) return
  const task = tasks.tasks[index]!
  await host.writeText(join(runDir, "tickets", ticketFileName(task, index)), renderTicket(task, index, tasks.tasks))
}

export function ticketPath(runDir: string, tasks: Task[], id: string): string | undefined {
  const index = tasks.findIndex((t) => t.id === id)
  return index < 0 ? undefined : join(runDir, "tickets", ticketFileName(tasks[index]!, index))
}
