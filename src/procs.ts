// The processes a task runs (plan rev. 5.8). A subagent may leave a long command running (a test suite in the
// background) and end its loop to wait for it: Claude Code reopens the same subagent when that process ends. That is
// not a death, and giving the task back then spent an attempt, freed its locks under a subagent still at work and, the
// second time, failed the task. So `jtasks exec` registers in the task the processes it starts (pid, when, the command),
// `jtasks wait <id> --pid` declares one started some other way, and `release --agent-ended` looks at them first: while
// one lives, the task waits for it in progress (`awaiting`), with its locks and without spending anything. This module
// looks at pids and keeps the task's list; the decisions are in actions.ts and awaiting.ts.

import type { Host } from "./host.ts"
import type { RunFile, Task, TaskProcess, TasksFile } from "./schema.ts"
import { appendLog, commit } from "./store.ts"

/** What the system says about a pid: alive or not (undefined: it could not tell), and its executable when it says. */
export interface Probe {
  alive: boolean | undefined
  image?: string
}

/** The answer of `tasklist /FI "PID eq <pid>" /FO CSV /NH`: one CSV line per process (`"bun.exe","1234",…`). */
export function parseTasklist(text: string, pid: number): Probe {
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim())
    if (m && Number(m[2]) === pid) return { alive: true, image: m[1]! }
  }
  // "INFO: No tasks are running…" (in the system's language): no CSV line for it.
  return { alive: false }
}

/** The last part of a path, without the folders (`/usr/bin/bun` → `bun`). */
function base(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

/** How long the system's answer about one pid is waited for. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Looks at a pid. `withImage`: the executable too (to tell a reused pid apart), from the system's own tools; without
 * it, the host's cheap answer when it has one (Node's signal 0). Windows: `tasklist`; elsewhere: `ps -p <pid>`.
 * A look that fails or is stopped at its deadline (a busy machine) could not tell (`alive: undefined`): only the
 * system's own "no such process" is `alive: false`.
 */
export async function probe(host: Host, pid: number, withImage = false): Promise<Probe> {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false }
  if (!withImage && host.alive) {
    const alive = await host.alive(pid).catch(() => undefined)
    if (alive !== undefined) return { alive }
  }
  if (host.platform === "win32") {
    const r = await host.run(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: PROBE_TIMEOUT_MS })
    return r.code === 0 ? parseTasklist(r.stdout, pid) : { alive: undefined }
  }
  const started = host.now().getTime()
  const r = await host.run(["ps", "-p", String(pid), "-o", "comm="], { timeoutMs: PROBE_TIMEOUT_MS })
  if (r.code === 127) return { alive: undefined }
  const name = r.stdout.trim()
  if (r.code === 0 && name) return { alive: true, image: base(name) }
  // A `ps` the host stopped at the deadline exits like one that found no such process: that is no answer.
  return host.now().getTime() - started >= PROBE_TIMEOUT_MS ? { alive: undefined } : { alive: false }
}

/**
 * Whether a registered process is still the one that was registered and alive: a pid the system no longer has, or
 * that now runs another executable (reused), is not. Undefined when the system could not tell.
 */
export async function procAlive(host: Host, proc: TaskProcess): Promise<boolean | undefined> {
  const p = await probe(host, proc.pid, !!proc.image)
  if (p.alive !== true) return p.alive
  if (proc.image && p.image && p.image.toLowerCase() !== proc.image.toLowerCase()) return false
  return true
}

/**
 * The processes of the list by what the system says: `live` (seen alive) and `unknown` (it could not tell: the look
 * failed or timed out). The rest were seen gone. An unknown one is never taken as ended by who decides on a wait: it
 * is looked at again on the next pass. (Every registered pid was seen alive once, by `wait --pid` or by the host that
 * started it, so a host that cannot look at pids at all has none to be unsure about.)
 */
export async function lookProcs(host: Host, procs: TaskProcess[]): Promise<{ live: TaskProcess[]; unknown: TaskProcess[] }> {
  const live: TaskProcess[] = []
  const unknown: TaskProcess[] = []
  for (const p of procs) {
    const alive = await procAlive(host, p).catch(() => undefined)
    if (alive === true) live.push(p)
    else if (alive === undefined) unknown.push(p)
  }
  return { live, unknown }
}

/** The processes of the list seen alive (one the system could not tell about is not in it). */
export async function liveProcs(host: Host, procs: TaskProcess[]): Promise<TaskProcess[]> {
  return (await lookProcs(host, procs)).live
}

/** A command line cut for the task's list and the messages. */
export function shortCommand(command: string, max = 120): string {
  const one = command.trim().replace(/\s+/g, " ")
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * Whether a registration by `agent` (the subagent that calls, undefined for the orchestrator, the CLI or a host) ends
 * the task's wait: only the agent that waits (or, when the wait names none, a subagent) is back at work. The
 * orchestrator declaring the same pids (T17, run fase3 of FlashEvents) is not the agent coming back.
 */
export function endsWait(task: Task, agent: string | undefined): boolean {
  const a = task.awaiting
  if (!a || !agent) return false
  return a.agent ? a.agent === agent : true
}

/**
 * Adds processes to an in-progress task (one with the same pid is replaced). The subagent the task waits for
 * registering a process is at work again: the wait for its earlier process is over (`awaiting` cleared). Anyone else
 * (the orchestrator, another agent) leaves the wait as it is, with the new pids added to it. With `inline` (the
 * orchestrator's `jtasks wait --pid`), a task the caller owns itself and that waits for no subagent waits for these
 * processes of its own (`awaiting.inline`). Answers the task as
 * written (`awaiting` still there when the wait goes on), or undefined when it is not in progress any more.
 */
export async function registerProcs(
  host: Host,
  dir: string,
  taskId: string,
  procs: TaskProcess[],
  actor: string,
  agent?: string,
  opts: { inline?: boolean } = {},
): Promise<Task | undefined> {
  let back = false
  let inline = false
  const c = await commit(
    host,
    dir,
    (draft) => {
      const task = draft.tasks.tasks.find((t) => t.id === taskId)
      if (!task || task.status !== "in_progress") return undefined
      const pids = new Set(procs.map((p) => p.pid))
      task.procs = [...(task.procs ?? []).filter((p) => !pids.has(p.pid)), ...procs]
      back = endsWait(task, agent)
      // `inline`: the orchestrator waits for a process of its own on a task it runs itself (owner = caller, no
      // subagent). The task waits for it, watched like a subagent's wait. A wait a subagent left is never turned into it.
      inline = !back && !!opts.inline && !agent && task.owner === actor && (!task.awaiting || !!task.awaiting.inline)
      if (back) delete task.awaiting
      else if (inline) {
        const before = task.awaiting?.pids ?? []
        const added = procs.map((p) => p.pid).filter((pid) => !before.includes(pid))
        task.awaiting = { since: task.awaiting?.since ?? host.now().toISOString(), pids: [...before, ...added], inline: true }
      } else if (task.awaiting) {
        // Still waiting: for these too (a process the orchestrator saw is one more to wait for, never one less).
        const added = procs.map((p) => p.pid).filter((pid) => !task.awaiting!.pids.includes(pid))
        if (added.length) {
          task.awaiting.pids = [...task.awaiting.pids, ...added]
          delete task.awaiting.endedAt
        }
      }
      return task.id
    },
    { actor, action: "procs" },
  )
  if (!c.result) return undefined
  const at = host.now().toISOString()
  if (back) await appendLog(host, dir, { at, actor, action: "await-back", task: taskId, how: "procs" }).catch(() => {})
  await appendLog(host, dir, { at, actor, action: "procs", task: taskId, pids: procs.map((p) => p.pid), by: procs[0]?.by ?? "exec", ...(inline ? { inline: true } : {}) }).catch(() => {})
  return c.tasks.tasks.find((t) => t.id === taskId)
}

/** Takes processes off a task's list (its `exec` ended); a task no longer in progress has no list. */
export async function unregisterProcs(host: Host, dir: string, taskId: string, pids: number[]): Promise<void> {
  await commit(
    host,
    dir,
    (draft) => {
      const t = draft.tasks.tasks.find((x) => x.id === taskId)
      if (!t?.procs?.some((p) => pids.includes(p.pid))) return
      t.procs = t.procs.filter((p) => !pids.includes(p.pid))
      if (!t.procs.length) delete t.procs
    },
    { action: "unprocs" },
  )
}

/** The run's grace after a waited process ended, in milliseconds. */
export function awaitGraceMs(run: RunFile, fallback: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec((run.awaitGrace ?? fallback).trim())
  if (!m) return 5 * 60_000
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"]
}

/** What a task waits for, short: `pid 1234 (bun test)` or the host's word. */
export function awaitingWhat(task: Task): string {
  const a = task.awaiting
  if (!a) return ""
  const parts = a.pids.map((pid) => {
    const p = task.procs?.find((x) => x.pid === pid)
    return p ? `pid ${pid} (${shortCommand(p.command, 60)})` : `pid ${pid}`
  })
  if (a.host) parts.push(shortCommand(a.host, 80))
  return parts.join(", ")
}
