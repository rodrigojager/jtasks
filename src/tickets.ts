// Tickets are a view of tasks.json, in the format of the jlock tickets: generated, never edited by hand.

import { slugify, ticketNumber } from "./ids.ts"
import type { Host } from "./host.ts"
import { join } from "./paths.ts"
import type { PlanTask, Task, TasksFile } from "./schema.ts"
import { tr } from "./i18n.ts"

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
    ? tr("ticket.exclusive")
    : task.files.length
      ? task.files.map((f) => `\`${f}\``).join(", ")
      : tr("ticket.none")
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

// ── Reading tickets back (`tasks import`, `tasks validate <dir>`) ─────────────────────────────────────────────

export interface ParsedTicket {
  file: string
  task: PlanTask
  /** The status written in the ticket (informative: an import always starts pending). */
  status?: string
  /** What was missing or guessed. */
  notes: string[]
}

const FIELD = /^\*\*([^*]+?):\*\*\s*(.*)$/

/** Reads one ticket in the jlock / to-tickets format. */
export function parseTicket(text: string, file: string, index: number): ParsedTicket {
  const notes: string[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const fields = new Map<string, string>()
  const acceptance: string[] = []
  let heading: { num: string; title: string } | undefined
  let current: string | undefined
  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^#\s+(\d+)\s*[:.\-–]\s*(.+)$/.exec(line)
    if (h && !heading) {
      heading = { num: h[1]!, title: h[2]!.trim() }
      current = undefined
      continue
    }
    const crit = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (crit) {
      acceptance.push(crit[2]!.trim())
      current = undefined
      continue
    }
    const f = FIELD.exec(line)
    if (f) {
      current = f[1]!.trim().toLowerCase()
      fields.set(current, f[2]!.trim())
      continue
    }
    if (!line.trim() || line.startsWith("#")) {
      current = undefined
      continue
    }
    if (current) fields.set(current, `${fields.get(current)} ${line.trim()}`.trim())
  }
  const fromName = /^(\d+)-(.+)\.md$/i.exec(file.split("/").pop() ?? file)
  const num = heading?.num ?? fromName?.[1] ?? String(index + 1)
  if (!heading) notes.push(tr("import.no_heading"))
  const id = `T${String(Number(num)).padStart(2, "0")}`
  const title = heading?.title ?? fromName?.[2]?.replace(/-/g, " ") ?? id
  const task: PlanTask = { id, title }

  const what = fields.get("what to build")
  if (what) task.what = what
  else notes.push(tr("import.no_what"))

  const blocked = fields.get("blocked by")
  if (blocked === undefined) notes.push(tr("import.no_blocked"))
  else if (!/^(none|nenhum|nenhuma|-)\b/i.test(blocked)) {
    const deps = [...blocked.matchAll(/\b(\d{1,3})\b/g)].map((m) => `T${String(Number(m[1])).padStart(2, "0")}`)
    task.dependsOn = [...new Set(deps)]
  }

  const files = fields.get("files")
  if (files === undefined) {
    task.exclusive = true
    notes.push(tr("import.no_files"))
  } else if (/exclusive/i.test(files) && !files.includes("`")) task.exclusive = true
  else task.files = [...files.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)

  const profile = fields.get("profile")
  if (profile) task.profile = profile
  if (acceptance.length) task.acceptance = acceptance
  else notes.push(tr("import.no_criteria"))
  const boundary = fields.get("scope boundary")
  if (boundary) task.boundary = boundary
  const parsed: ParsedTicket = { file, task, notes }
  const status = fields.get("status")
  if (status) parsed.status = status
  return parsed
}

/** Every `*.md` ticket of a folder, in name order. */
export async function readTicketsDir(host: Host, dir: string): Promise<ParsedTicket[]> {
  const names = (await host.list(dir)).filter((e) => e.kind === "file" && /\.md$/i.test(e.name)).map((e) => e.name)
  names.sort()
  const out: ParsedTicket[] = []
  for (let i = 0; i < names.length; i++) {
    const text = (await host.readText(join(dir, names[i]!))) ?? ""
    out.push(parseTicket(text, names[i]!, i))
  }
  return out
}

export function ticketReadLine(t: ParsedTicket): string {
  const k = t.task
  const deps = k.dependsOn?.length ? k.dependsOn.join(", ") : "-"
  const own = k.exclusive ? "exclusive" : k.files?.length ? k.files.join(", ") : tr("ticket.none")
  const crit = k.acceptance?.length ?? 0
  const tail = t.notes.length ? `\n    ${tr("import.missing", { notes: t.notes.join("; ") })}` : ""
  return `${tr("import.line", { file: t.file, id: k.id, title: k.title, deps, own, n: crit })}${tail}`
}
