// The keepalive (plan rev. 5.3, section 16): when the orchestrator's turn ends with no subagent running and the run
// still has a ready task (or one in progress that nobody works on), the host reopens the loop itself with a message
// to the session. The decision is this module's, the same in every host; the host only says how many of its agents
// are alive and delivers the message. What was sent lives in the run's `keepalive.json`: the same progress
// signature twice more than `tries` times means the model is not moving, and the host stops and tells the person.

import { assess, selectReady, type RunState } from "./frontier.ts"
import { counts } from "./format.ts"
import type { Host } from "./host.ts"
import { jlockList, type JlockLock } from "./jlock.ts"
import { join } from "./paths.ts"
import type { RunFile, TasksFile } from "./schema.ts"
import { appendLog, atomicWrite, readJson, readRun, readTasks, runDir, stringify } from "./store.ts"
import { tr } from "./i18n.ts"

/** Messages without progress before the host gives up and tells the person (`JTASKS_KEEPALIVE_TRIES`). */
export const DEFAULT_KEEPALIVE_TRIES = 2
export const KEEPALIVE_FILE = "keepalive.json"

/**
 * What the host did last, for the progress it saw: `nudge` (sent a message, the `tries`-th for this signature),
 * `stalled` (gave up and told the person) or `held` (the person interrupted the turn: quiet until the run moves).
 */
export interface KeepaliveMemory {
  signature: string
  action: "nudge" | "stalled" | "held"
  tries: number
  at: string
  ready?: string[]
  orphans?: string[]
  /** `error`: the turn ended on an API error or a refusal, and the host only told the person. */
  cause?: "error"
}

export interface KeepaliveInput {
  state: RunState
  /** `jlock list` under the repository (the whole machine with `*` in play): "ready" is the frontier of `next`. */
  locks: JlockLock[]
  platform: string
  /** The subagents of this session that are alive, as the host counts them. */
  liveAgents: number
  /** `<tool>:<session>` of the orchestrator: a task in progress owned by another session is someone else's work. */
  actor?: string
  last?: KeepaliveMemory
  maxTries?: number
  /** The turn ended on an API error or a refusal: nothing is sent, the person is told at once. */
  cause?: "error"
}

export type KeepaliveQuiet = "paused" | "off" | "finished" | "agents-running" | "nothing-ready" | "stalled" | "held"

export type KeepaliveDecision =
  | { action: "none"; reason: KeepaliveQuiet }
  | { action: "nudge"; text: string; signature: string; tries: number; ready: string[]; orphans: string[] }
  | { action: "stalled"; notice: string; signature: string; tries: number; ready: string[]; orphans: string[]; cause?: "error" }

/** The progress a message is sent for: what is finished and what is in progress. Any change is progress. */
export function progressSignature(tasks: TasksFile): string {
  const c = counts(tasks.tasks)
  const running = tasks.tasks
    .filter((t) => t.status === "in_progress")
    .map((t) => t.id)
    .sort()
  return `${c.done}/${c.skipped}/${c.failed}|${running.join(",")}`
}

/** An in-progress task nobody here works on: no owner, the CLI, this orchestrator or one of its (dead) subagents. */
function isOrphan(owner: string | null | undefined, actor: string | undefined): boolean {
  if (!owner || owner === "cli" || owner.startsWith("cli/")) return true
  if (!actor) return true
  return owner === actor || owner.startsWith(`${actor}/`)
}

export function keepaliveTries(host: Host): number {
  const text = host.env("JTASKS_KEEPALIVE_TRIES")?.trim()
  const raw = text ? Number(text) : NaN
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_KEEPALIVE_TRIES
}

/** The decision at the end of the orchestrator's turn (pure: the host reads the files and jlock, then calls this). */
export function keepaliveDecision(input: KeepaliveInput): KeepaliveDecision {
  const { state } = input
  const run = state.run
  const c = counts(state.tasks.tasks)
  if (run.status === "paused") return { action: "none", reason: "paused" }
  if (run.status === "done" || c.remaining === 0) return { action: "none", reason: "finished" }
  if (run.keepalive === false) return { action: "none", reason: "off" }
  if (input.liveAgents > 0) return { action: "none", reason: "agents-running" }
  const ready = selectReady(state, assess(state, input.locks, input.platform), input.platform).map((t) => t.id)
  const orphans = state.tasks.tasks.filter((t) => t.status === "in_progress" && isOrphan(t.owner, input.actor)).map((t) => t.id)
  if (!ready.length && !orphans.length) return { action: "none", reason: "nothing-ready" }
  const signature = progressSignature(state.tasks)
  const last = input.last?.signature === signature ? input.last : undefined
  if (last?.action === "held") return { action: "none", reason: "held" }
  if (last?.action === "stalled") return { action: "none", reason: "stalled" }
  const what = [...ready, ...orphans].join(", ")
  if (input.cause === "error")
    return { action: "stalled", notice: tr("keepalive.error", { run: run.id, what }), signature, tries: last?.tries ?? 0, ready, orphans, cause: "error" }
  const tries = (last?.tries ?? 0) + 1
  const max = input.maxTries ?? DEFAULT_KEEPALIVE_TRIES
  if (tries > max) {
    return { action: "stalled", notice: tr("keepalive.stalled", { run: run.id, what, tries: max }), signature, tries, ready, orphans }
  }
  return { action: "nudge", text: nudgeText(run, state.tasks, ready, orphans), signature, tries, ready, orphans }
}

/** The message that reopens the loop: for the model, so English in every language (plan section 21). */
export function nudgeText(run: RunFile, tasks: TasksFile, ready: string[], orphans: string[]): string {
  const c = counts(tasks.tasks)
  const head = [`jtasks: run ${run.id} is idle`, `done ${c.done}/${c.total}`, `${c.remaining} left`]
  if (ready.length) head.push(`ready: ${ready.join(", ")}`)
  head.push("no subagent is running")
  const lines = [head.join(" · ") + "."]
  for (const id of orphans)
    lines.push(`${id} is in progress and no subagent is running: continue it yourself, or call jtasks release ${id} and open a subagent for it.`)
  lines.push(
    "This is a fact read from tasks.json now, not from the conversation's summary. Continue the protocol now: call jtasks next and open the subagents. " +
      "If something depends on the person, call jtasks pause and ask them.",
  )
  return lines.join("\n")
}

export async function readKeepalive(host: Host, dir: string): Promise<KeepaliveMemory | undefined> {
  return readJson<KeepaliveMemory>(host, join(dir, KEEPALIVE_FILE)).catch(() => undefined)
}

export async function writeKeepalive(host: Host, dir: string, memory: KeepaliveMemory): Promise<void> {
  await atomicWrite(host, join(dir, KEEPALIVE_FILE), stringify(memory))
}

/** Forgets what was sent: the next end of turn starts counting again (a real unpause, `keepalive on` from off). */
export async function clearKeepalive(host: Host, dir: string): Promise<void> {
  await host.remove(join(dir, KEEPALIVE_FILE)).catch(() => {})
}

/**
 * Watches a run the host gave up on (or went quiet on) again: forgets only a give-up or a hold, never the count of
 * messages already sent, so a model that answers "run is idle" with this command cannot loop the messages.
 */
export async function rearmKeepalive(host: Host, dir: string): Promise<void> {
  const memory = await readKeepalive(host, dir)
  if (memory && memory.action !== "nudge") await clearKeepalive(host, dir)
}

export interface KeepaliveCheck {
  root: string
  run: string
  liveAgents: number
  actor?: string
  /** Decide as if nothing had been sent yet: only "is the run still idle with work to do?" (a message about to be delivered). */
  fresh?: boolean
  /** Record a nudge or a give-up in `keepalive.json` and the run's log (the end of a turn); a check only reads. */
  commit?: boolean
  /** The turn ended on an API error or a refusal (`keepaliveDecision`'s `cause`). */
  cause?: "error"
}

/** Reads the run (files and jlock), decides and, with `commit`, records what the host is about to do. */
export async function checkKeepalive(host: Host, check: KeepaliveCheck): Promise<KeepaliveDecision> {
  const dir = runDir(check.root, check.run)
  const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  if (!run || !tasks) return { action: "none", reason: "finished" }
  const state: RunState = { root: check.root, dir, run, tasks }
  // Cheap answers first, with no jlock call: paused, finished, off, agents alive, or nothing ready even with every
  // lock free (locks only take ready tasks away).
  const quick = keepaliveDecision({ state, locks: [], platform: host.platform, liveAgents: check.liveAgents, actor: check.actor, maxTries: 0 })
  if (quick.action === "none") return quick
  const star = tasks.tasks.some((t) => t.exclusive && (t.status === "pending" || t.status === "in_progress"))
  const locks = await (star ? jlockList(host) : jlockList(host, { under: check.root })).catch(() => [])
  const last = check.fresh ? undefined : await readKeepalive(host, dir)
  const decision = keepaliveDecision({ state, locks, platform: host.platform, liveAgents: check.liveAgents, actor: check.actor, last, maxTries: keepaliveTries(host), cause: check.cause })
  if (check.commit && decision.action !== "none") {
    const at = host.now().toISOString()
    const memory: KeepaliveMemory = { signature: decision.signature, action: decision.action, tries: decision.tries, at, ready: decision.ready, orphans: decision.orphans }
    if (decision.action === "stalled" && decision.cause) memory.cause = decision.cause
    await writeKeepalive(host, dir, memory)
    const actor = check.actor ?? "host"
    const cause = decision.action === "stalled" && decision.cause ? { cause: decision.cause } : {}
    await appendLog(host, dir, { at, actor, action: `keepalive-${decision.action}`, tries: decision.tries, ready: decision.ready, orphans: decision.orphans, ...cause }).catch(() => {})
  }
  return decision
}

/** The person interrupted the orchestrator: no message until the run moves (a later end of turn with progress). */
export async function holdKeepalive(host: Host, root: string, runId: string): Promise<void> {
  const dir = runDir(root, runId)
  const tasks = await readTasks(host, dir).catch(() => undefined)
  if (!tasks) return
  await writeKeepalive(host, dir, { signature: progressSignature(tasks), action: "held", tries: 0, at: host.now().toISOString() })
}

/** The keepalive line of `jtasks status`: off, or what the host did for the progress the run is at now. */
export function keepaliveStatus(run: RunFile, tasks: TasksFile, memory: KeepaliveMemory | undefined, maxTries: number): string | undefined {
  if (run.keepalive === false) return tr("status.keepalive_off")
  // A transient pause has its own line; nothing the keepalive did before it counts while it lasts.
  if (run.status === "paused" && run.pause) return undefined
  if (!memory || memory.signature !== progressSignature(tasks) || counts(tasks.tasks).remaining === 0) return undefined
  const what = [...(memory.ready ?? []), ...(memory.orphans ?? [])].join(", ")
  if (memory.action === "stalled") return tr(memory.cause === "error" ? "status.keepalive_error" : "status.keepalive_stalled", { what, tries: maxTries })
  if (memory.action === "held") return tr("status.keepalive_held")
  return tr("status.keepalive_nudged", { at: memory.at, tries: memory.tries, max: maxTries })
}

/** The line of the sidebar when the host gave up on the progress the run is at now (cleared by any progress). */
export function keepaliveNotice(run: RunFile, tasks: TasksFile, memory: KeepaliveMemory | undefined): string | undefined {
  if (memory?.action !== "stalled" || run.status !== "active" || run.keepalive === false) return undefined
  if (memory.signature !== progressSignature(tasks) || counts(tasks.tasks).remaining === 0) return undefined
  return tr("view.stalled", { what: [...(memory.ready ?? []), ...(memory.orphans ?? [])].join(", ") })
}

/** The sidebar's line for a run read now, or undefined when the host has not given up on it as it stands. */
export async function stalledNotice(host: Host, root: string, runId: string): Promise<string | undefined> {
  const dir = runDir(root, runId)
  const [run, tasks, memory] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined), readKeepalive(host, dir)])
  return run && tasks ? keepaliveNotice(run, tasks, memory) : undefined
}
