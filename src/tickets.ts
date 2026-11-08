// Tickets are a view of tasks.json, in the format of the jlock tickets: generated, never edited by hand.

import { slugify, ticketNumber } from "./ids.ts"
import type { Host } from "./host.ts"
import { isAbsolute, join, normalize } from "./paths.ts"
import type { PlanTask, RunContext, RunFile, Task, TasksFile } from "./schema.ts"
import { tr } from "./i18n.ts"

export function ticketFileName(task: Task, index: number): string {
  return `${ticketNumber(task.id, index)}-${slugify(task.title, 40)}.md`
}

/** Ticket numbers by task id, for "Blocked by". */
function numbers(tasks: Task[]): Map<string, string> {
  return new Map(tasks.map((t, i) => [t.id, ticketNumber(t.id, i)]))
}

// ── The run's common brief (0.6.0) ────────────────────────────────────────────────────────────────────────────

/** The one file, in the run's folder, that holds the run's common brief. */
export const BRIEF_FILE = "brief.md"

/**
 * The brief's text as the tool keeps it: no BOM, `\n` line ends, no blank lines before the text, no trailing
 * whitespace after it. Everything in between is kept verbatim.
 */
export function normalizeBrief(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd()
}

/**
 * Reads the brief a plan, batch or `context --set` points to (absolute, or relative to `cwd`). A file that cannot be
 * read, or holds only whitespace, is an error the planner can act on.
 */
export async function loadBrief(host: Host, cwd: string, path: string): Promise<{ text?: string; file: string; error?: string }> {
  const file = isAbsolute(path) ? normalize(path) : join(cwd, path)
  let raw: string | undefined
  try {
    raw = (await host.stat(file))?.kind === "file" ? await host.readText(file) : undefined
  } catch {
    raw = undefined
  }
  if (raw === undefined) return { file, error: tr("plan.brief_missing", { file }) }
  const text = normalizeBrief(raw)
  if (!text) return { file, error: tr("plan.brief_empty", { file }) }
  return { text, file }
}

/** Keeps the brief in the run's folder (`brief.md`), or removes it when the run has none. */
export async function storeBrief(host: Host, runDir: string, text: string | undefined): Promise<void> {
  const file = join(runDir, BRIEF_FILE)
  if (text === undefined) {
    if (await host.stat(file)) await host.remove(file)
    return
  }
  if ((await host.readText(file)) !== `${text}\n`) await host.writeText(file, `${text}\n`)
}

/**
 * The run's brief, read from its folder when the context has one. `null` when the context names a brief but the file
 * is gone (the ticket then says so instead of silently leaving it out).
 */
export async function readRunBrief(host: Host, runDir: string, context: RunContext | undefined): Promise<string | null | undefined> {
  if (!context?.brief) return undefined
  const raw = await host.readText(join(runDir, BRIEF_FILE))
  return raw === undefined ? null : normalizeBrief(raw)
}

/**
 * The `## Context` section of a ticket (0.5.0, brief and consult in 0.6.0): first the run's common brief, verbatim;
 * then what is this task's own after the run's (the summaries, **Read first**, **If in doubt, consult** with the
 * reason for each document, **Constraints**), so the agent that runs the task, which starts with a fresh context,
 * has everything it needs and nothing it does not. Pure: the same context, task and brief give the same bytes. Empty
 * (no section) when nothing is said. `brief` is the brief's text (`null`: named but missing).
 */
export function renderContext(run: RunContext | undefined, task: RunContext | undefined, brief?: string | null): string[] {
  const summaries = [run?.summary, task?.summary].filter((s): s is string => !!s)
  const read: string[] = []
  for (const p of [...(run?.read ?? []), ...(task?.read ?? [])]) if (!read.includes(p)) read.push(p)
  const consult: { path: string; why: string }[] = []
  for (const c of [...(run?.consult ?? []), ...(task?.consult ?? [])])
    if (!read.includes(c.path) && !consult.some((k) => k.path === c.path)) consult.push(c)
  const constraints: string[] = []
  for (const c of [...(run?.constraints ?? []), ...(task?.constraints ?? [])]) if (!constraints.includes(c)) constraints.push(c)
  if (brief === undefined || brief === "") brief = undefined
  if (brief === undefined && !summaries.length && !read.length && !consult.length && !constraints.length) return []
  const lines = ["## Context", ""]
  if (brief === null) lines.push(`**Brief:** missing (\`${BRIEF_FILE}\` in the run's folder; see \`jtasks context\`)`, "")
  else if (brief !== undefined) lines.push(brief, "")
  for (const s of summaries) lines.push(s, "")
  if (read.length) lines.push("**Read first:**", "", ...read.map((p) => `- \`${p}\``), "")
  if (consult.length) lines.push("**If in doubt, consult:**", "", ...consult.map((c) => `- \`${c.path}\`: ${c.why}`), "")
  if (constraints.length) lines.push("**Constraints:**", "", ...constraints.map((c) => `- ${c}`), "")
  return lines
}

export function renderTicket(task: Task, index: number, all: Task[], context?: RunContext, brief?: string | null): string {
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
    ...(task.source ? [`**Source:** ${task.source}`, ""] : []),
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
  lines.push(...renderContext(context, task.context, brief))
  return lines.join("\n")
}

/** Writes every ticket of the run (and removes tickets of tasks that no longer exist). */
export async function writeTickets(host: Host, runDir: string, tasks: TasksFile, context?: RunContext): Promise<string[]> {
  const dir = join(runDir, "tickets")
  const names = tasks.tasks.map((t, i) => ticketFileName(t, i))
  const brief = await readRunBrief(host, runDir, context)
  await host.mkdir(dir)
  for (let i = 0; i < tasks.tasks.length; i++)
    await host.writeText(join(dir, names[i]!), renderTicket(tasks.tasks[i]!, i, tasks.tasks, context, brief))
  for (const entry of await host.list(dir))
    if (entry.kind === "file" && entry.name.endsWith(".md") && !names.includes(entry.name)) await host.remove(join(dir, entry.name))
  return names.map((n) => join(dir, n))
}

/** What a ticket is rendered from: the run's folder, its run.json (for the context) and its tasks. */
export interface TicketState {
  dir: string
  run: Pick<RunFile, "context">
  tasks: TasksFile
}

/** Rewrites one task's ticket after a transition. */
export async function writeTicket(host: Host, state: TicketState, id: string): Promise<void> {
  const { tasks } = state
  const index = tasks.tasks.findIndex((t) => t.id === id)
  if (index < 0) return
  const task = tasks.tasks[index]!
  const brief = await readRunBrief(host, state.dir, state.run.context)
  await host.writeText(join(state.dir, "tickets", ticketFileName(task, index)), renderTicket(task, index, tasks.tasks, state.run.context, brief))
}

export function ticketPath(runDir: string, tasks: Task[], id: string): string | undefined {
  const index = tasks.findIndex((t) => t.id === id)
  return index < 0 ? undefined : join(runDir, "tickets", ticketFileName(tasks[index]!, index))
}

// ── Reading tickets back (`jtasks import`, `jtasks validate <dir>`) ─────────────────────────────────────────────

export interface ParsedTicket {
  file: string
  task: PlanTask
  /** The status written in the ticket (informative: an import always starts pending). */
  status?: string
  /** What was missing or guessed. */
  notes: string[]
}

const FIELD = /^\*\*([^*]+?):\*\*\s*(.*)$/

/** Reads one ticket in the jlock / to-jtasks format. */
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

  const source = fields.get("source") ?? fields.get("parent")
  if (source) task.source = source

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
