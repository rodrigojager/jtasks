// What the host tells the orchestrator by itself (plan rev. 5.8). The run changes without the orchestrator asking: a
// subagent ends without finishing and its task goes back to the queue, or waits for a process; a lock is lost; the
// attempts or the ends of a subagent run out and a task fails, or the run pauses for a person; someone else (another
// window, the person at the CLI) pauses, fails or releases. Before this, the orchestrator heard of none of it: the
// keepalive speaks only when a task is ready and nothing runs, and a failed task is not ready. Now every such
// transition is read from the run's `log.jsonl` (whoever made it: this host, another one, the CLI) and the host sends
// the orchestrator a message at once, with the run's status line, and tells the person (toast, notification). The
// same module gives the status line the hosts attach to every notification of a subagent's end.

import { counts, progressLine } from "./format.ts"
import type { Host } from "./host.ts"
import { tr } from "./i18n.ts"
import { join } from "./paths.ts"
import { awaitingWhat } from "./procs.ts"
import type { RunFile, Task, TasksFile } from "./schema.ts"
import { readRun, readTasks, runDir, type LogEntry } from "./store.ts"
import { resumeHow } from "./transient.ts"

/** Transitions the host or the core make by themselves: always told. */
const ALWAYS = new Set(["agent-ended", "await", "await-ended", "lost", "renew-lost"])
/** Transitions someone else made (another session, the CLI, the person): told when not the orchestrator's own. */
const FOREIGN = new Set(["pause", "fail", "release", "skip", "resume-release"])

/**
 * Whether a log entry is news for the orchestrator `actor` (`claude:<session>`, `opencode:<session>`): what the host or
 * the core did by itself, a task failed by anything else than an explicit `fail`, or what someone else did. What the
 * orchestrator (or one of its subagents) asked for itself is not: it read the answer.
 */
export function isAlert(entry: LogEntry, actor: string): boolean {
  const action = String(entry.action ?? "")
  if (ALWAYS.has(action)) return true
  const by = String(entry.actor ?? "")
  const own = by === actor || by.startsWith(`${actor}/`)
  if (own) return false
  return (entry.to === "failed" && action !== "fail") || FOREIGN.has(action)
}

const LOG = "log.jsonl"

/** Where a host starts reading a run's log: its end now (what happened before is not news). */
export async function logEnd(host: Host, root: string, run: string): Promise<number> {
  return ((await host.readText(join(runDir(root, run), LOG)).catch(() => undefined)) ?? "").length
}

export interface AlertRead {
  entries: LogEntry[]
  /** Where the next read starts. */
  offset: number
}

/** The whole lines of the run's log written since `offset` that the orchestrator `actor` must hear about. */
export async function readAlerts(host: Host, root: string, run: string, offset: number, actor: string): Promise<AlertRead> {
  const text = (await host.readText(join(runDir(root, run), LOG)).catch(() => undefined)) ?? ""
  // A log shorter than what was read is another file (the run archived and back): read on from its end.
  if (text.length < offset) return { entries: [], offset: text.length }
  const fresh = text.slice(offset)
  const end = fresh.lastIndexOf("\n") + 1
  const entries: LogEntry[] = []
  for (const line of fresh.slice(0, end).split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as LogEntry
      if (isAlert(entry, actor)) entries.push(entry)
    } catch {
      // A line cut by a writer: never ours to fix.
    }
  }
  return { entries, offset: offset + end }
}

/** One line of what the run is now, in the person's language: progress, pause, what runs (and waits), what failed. */
export function briefStatus(run: RunFile, tasks: TasksFile): string {
  const parts = [progressLine(tasks.tasks)]
  if (run.status === "paused") {
    const n = run.needsPerson
    parts.push(n ? tr("status.needs_person", { id: n.task, n: n.count, max: n.max }) : tr("status.paused"))
  }
  const running = tasks.tasks.filter((t) => t.status === "in_progress")
  if (running.length) parts.push(tr("status.running", { list: running.map((t) => (t.awaiting ? `${t.id} (${tr("status.awaiting_mark")})` : t.id)).join(", ") }))
  const failed = tasks.tasks.filter((t) => t.status === "failed")
  if (failed.length) parts.push(tr("status.failed", { list: failed.map((t) => t.id).join(", ") }))
  return parts.join(" · ")
}

/** The status line of a run read now (files only, no jlock), or undefined when its files are gone. */
export async function readBrief(host: Host, root: string, runId: string): Promise<string | undefined> {
  const dir = runDir(root, runId)
  const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  return run && tasks ? briefStatus(run, tasks) : undefined
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : ""
}

/** What one entry tells the orchestrator (English, for the model). */
export function alertLine(e: LogEntry, tasks: Task[], tool: string | undefined, grace: string): string {
  const id = String(e.task ?? "")
  const task = tasks.find((t) => t.id === id)
  const agent = typeof e.agent === "string" ? e.agent : task?.awaiting?.agent
  switch (e.action) {
    case "await": {
      const what = task?.awaiting ? awaitingWhat(task) : [list(e.pids) && `pid ${list(e.pids)}`, typeof e.host === "string" ? e.host : ""].filter(Boolean).join(", ")
      return (
        `${id}: its subagent's loop ended while a process it started still runs (${what || "its background work"}). ${id} stays in progress with its ` +
        `locks and no attempt spent, waiting for that process: do not release it and do not open another subagent for it; the subagent comes back when the process ends.`
      )
    }
    case "await-ended": {
      const how = agent ? resumeHow(tool, agent) : "the same subagent"
      const by = tool === "claude" ? `Claude Code normally reopens that subagent by itself; if it does not, resume it now (${how})` : `Resume that same subagent now (${how})`
      return `${id}: the process its subagent waited for ended. ${by}, so it reads the result and finishes. If it does not come back within ${grace}, ${id} goes back to the queue.`
    }
    case "agent-ended": {
      const n = Number(e.agentEnded ?? 0)
      const max = Number(e.max ?? 0)
      const why = e.expired ? "did not come back after its process ended" : "ended without finishing"
      if (e.to === "failed")
        return `${id}: its subagent ${why}, ${n} times (the run's limit ${max}): ${id} failed and the run is paused for a person. Tell the user; do not start tasks. When they decide: jtasks retry ${id}, then jtasks unpause.`
      return `${id}: its subagent ${why}: back to pending, ready to start again with a new subagent (ends without finishing: ${n} of ${max}; no attempt spent).`
    }
    case "lost":
      return `${id}: its locks were taken away (forced by someone, or expired): ${e.to === "failed" ? `failed (${task?.error ?? "attempts used up"})` : "back to pending"}.`
    case "renew-lost":
      return `${id}: some of its locks are held by someone else now (${list(e.refused)}): its subagent must claim them again before done.`
    case "pause":
      return `the run was paused by ${e.actor}.`
    default:
      if (e.to === "failed") return `${id}: failed (${e.action} by ${e.actor}): ${task?.error ?? ""}`.trim()
      return `${id}: ${e.action} by ${e.actor} (now ${e.to ?? "?"}).`
  }
}

/**
 * The message the host sends the orchestrator for new alerts (English, for the model): one line per entry, the run's
 * status line, and what to do now.
 */
export function alertText(run: RunFile, tasks: TasksFile, entries: LogEntry[], tool: string | undefined): string {
  const grace = run.awaitGrace ?? "5m"
  const lines = [`jtasks: run ${run.id} changed without your asking (read from the run's log now, not from the conversation):`]
  for (const e of entries) lines.push(`- ${alertLine(e, tasks.tasks, tool, grace)}`)
  lines.push(`Status now: ${briefStatus(run, tasks)}`)
  const c = counts(tasks.tasks)
  if (run.status === "paused") lines.push("The run is paused: do not call jtasks next or start. Tell the user what happened and wait for them.")
  else if (c.remaining === 0) lines.push("Nothing is left: confirm with jtasks status.")
  else lines.push("Go on with the protocol: jtasks next for whatever is ready, and leave the tasks waiting for a process alone.")
  return lines.join("\n")
}

/** What a message the host sent the orchestrator is about: alerts, the keepalive's nudge, the end of a transient pause. */
export type DeliveryKind = "alert" | "idle" | "resume" | "other"

/** The kind of a message the host sent (alertText, nudgeText, resumeText), read from its head line. */
export function deliveryKind(text: string): DeliveryKind {
  const head = /jtasks: run \S+ (changed without your asking|is idle|is active again)/.exec(text)?.[1]
  if (head === "changed without your asking") return "alert"
  if (head === "is idle") return "idle"
  if (head === "is active again") return "resume"
  return "other"
}

/**
 * What the person sees in place of a message the host sent the orchestrator (a few words, in their language): the
 * model reads the whole text, the person has the toast and the pane for the details.
 */
export function deliveryLabel(text: string): string {
  return tr(`delivery.${deliveryKind(text)}`)
}

/** What the person reads (toast, notification), in their language: one short phrase per entry. */
export function alertNotice(run: RunFile, tasks: TasksFile, entries: LogEntry[]): string {
  const parts = entries.map((e) => {
    const id = String(e.task ?? "")
    const task = tasks.tasks.find((t) => t.id === id)
    if (e.action === "agent-ended" && e.to === "failed") return tr("alert.needs_person", { run: run.id, id, n: Number(e.agentEnded ?? 0) })
    if (e.to === "failed") return tr("alert.failed", { id, error: task?.error ?? String(e.action) })
    switch (e.action) {
      case "await":
        return tr("alert.await", { id, what: task?.awaiting ? awaitingWhat(task) : list(e.pids) || String(e.host ?? "") })
      case "await-ended":
        return tr("alert.await_ended", { id })
      case "agent-ended":
        return tr("alert.agent_ended", { id, n: Number(e.agentEnded ?? 0), max: Number(e.max ?? 0) })
      case "lost":
        return tr("alert.lost", { id })
      case "renew-lost":
        return tr("alert.renew_lost", { id })
      case "pause":
        return tr("alert.paused_by", { run: run.id, actor: String(e.actor) })
      default:
        return tr("alert.by_other", { id, action: String(e.action), actor: String(e.actor) })
    }
  })
  return parts.join(" · ")
}
