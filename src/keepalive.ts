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
import { appendLog, atomicWrite, readJson, readRun, readTasks, runDir, stringify, type LogEntry } from "./store.ts"
import { tr } from "./i18n.ts"
import { agentOfOwner, resumeHow } from "./transient.ts"

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
  /** The subagent each orphan had (its owner's `agent:<id>`), for "resume agent <id>". */
  agents?: Record<string, string>
  /** The host that decided (`claude`, `opencode`): how an agent is resumed there. */
  tool?: string
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
  | { action: "nudge"; text: string; signature: string; tries: number; ready: string[]; orphans: string[]; agents: Record<string, string> }
  | { action: "stalled"; notice: string; signature: string; tries: number; ready: string[]; orphans: string[]; agents: Record<string, string>; cause?: "error" }

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
  // A task waiting for its process (rev. 5.8) is no orphan: its subagent comes back when the process ends.
  const orphanTasks = state.tasks.tasks.filter((t) => t.status === "in_progress" && !t.awaiting && isOrphan(t.owner, input.actor))
  const orphans = orphanTasks.map((t) => t.id)
  if (!ready.length && !orphans.length) return { action: "none", reason: "nothing-ready" }
  const agents: Record<string, string> = {}
  for (const t of orphanTasks) {
    const agent = agentOfOwner(t.owner)
    if (agent) agents[t.id] = agent
  }
  const tool = toolOf(input.actor)
  const signature = progressSignature(state.tasks)
  const last = input.last?.signature === signature ? input.last : undefined
  if (last?.action === "held") return { action: "none", reason: "held" }
  if (last?.action === "stalled") return { action: "none", reason: "stalled" }
  const what = keepaliveWhat(ready, orphans, agents, tool)
  if (input.cause === "error")
    return { action: "stalled", notice: tr("keepalive.error", { run: run.id, what }), signature, tries: last?.tries ?? 0, ready, orphans, agents, cause: "error" }
  const tries = (last?.tries ?? 0) + 1
  const max = input.maxTries ?? DEFAULT_KEEPALIVE_TRIES
  if (tries > max) {
    return { action: "stalled", notice: tr("keepalive.stalled", { run: run.id, what, tries: max }), signature, tries, ready, orphans, agents }
  }
  return { action: "nudge", text: nudgeText(run, state.tasks, ready, orphans, agents, tool), signature, tries, ready, orphans, agents }
}

/** The host of an actor (`claude:<session>` → `claude`). */
function toolOf(actor: string | undefined): string | undefined {
  return actor ? actor.split(":")[0] : undefined
}

/** The tool a person resumes an agent with in each host (a name, the same in every language). */
const RESUME_TOOL: Record<string, string> = { claude: "SendMessage", opencode: "task_id" }

/**
 * What is left, for the person (their language): the ready tasks "to do"; a task in progress with no agent on it as
 * such, never "to do", with the agent to resume when its owner names one.
 */
export function keepaliveWhat(ready: string[], orphans: string[], agents: Record<string, string> = {}, tool?: string): string {
  const parts: string[] = []
  if (ready.length) parts.push(tr("keepalive.what_ready", { list: ready.join(", ") }))
  for (const id of orphans) {
    const agent = agents[id]
    const how = tool ? RESUME_TOOL[tool] : undefined
    parts.push(agent && how ? tr("keepalive.what_orphan_agent", { id, agent, how }) : tr("keepalive.what_orphan", { id }))
  }
  return parts.join("; ")
}

/** The message that reopens the loop: for the model, so English in every language (plan section 21). */
export function nudgeText(run: RunFile, tasks: TasksFile, ready: string[], orphans: string[], agents: Record<string, string> = {}, tool?: string): string {
  const c = counts(tasks.tasks)
  const head = [`jtasks: run ${run.id} is idle`, `done ${c.done}/${c.total}`, `${c.remaining} left`]
  if (ready.length) head.push(`ready: ${ready.join(", ")}`)
  head.push("no subagent is running")
  const lines = [head.join(" · ") + "."]
  for (const id of orphans) {
    const agent = agents[id]
    lines.push(
      agent
        ? `${id} is in progress with no agent running: its subagent ${agent} ended its loop without finishing it. Resume that same subagent (${resumeHow(tool, agent)}) if its work is not over; ` +
            `otherwise continue it yourself, or call jtasks release ${id} and open a subagent for it. Do not call jtasks wait on it.`
        : `${id} is in progress and no subagent is running: continue it yourself, or call jtasks release ${id} and open a subagent for it.`,
    )
  }
  lines.push(
    "This is a fact read from tasks.json now, not from the conversation's summary. Continue the protocol now: call jtasks next and open the subagents. " +
      "If something depends on the person, call jtasks pause and ask them.",
  )
  return lines.join("\n")
}

/**
 * Work on the tasks, as the log records it: what a subagent (or anyone) does on a task, and what the host does when
 * one ends or comes back. The keepalive's own entries, renewals and pauses are not.
 */
const ACTIVITY = new Set(["start", "claim", "procs", "await", "await-back", "await-ended", "agent-ended", "done", "fail", "skip", "release", "yield", "retake", "reclaim", "lost"])

/**
 * Whether the log has work on the tasks after `since` (the last message): then the same signature is no stall, it is
 * a task whose subagent works in rounds (waits for its process, comes back, waits again). The orchestrator's own
 * `procs` (a `jtasks wait` of its own) is not: answering the message with it would loop the messages.
 */
export function hadActivity(entries: LogEntry[], since: string, actor?: string): boolean {
  const from = Date.parse(since)
  if (Number.isNaN(from)) return false
  return entries.some((e) => {
    const action = String(e.action ?? "")
    if (!ACTIVITY.has(action)) return false
    if (action === "procs" && actor && e.actor === actor) return false
    const at = Date.parse(String(e.at ?? ""))
    return !Number.isNaN(at) && at > from
  })
}

/** The run's log, line by line (a line cut by a writer is skipped). */
async function readLog(host: Host, dir: string): Promise<LogEntry[]> {
  const text = (await host.readText(join(dir, "log.jsonl")).catch(() => undefined)) ?? ""
  const out: LogEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      // never ours to fix
    }
  }
  return out
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
  let last = check.fresh ? undefined : await readKeepalive(host, dir)
  // Work went on since the last message (a subagent claimed, waited, came back, finished…) though the signature did
  // not move: the count starts over. A hold (the person's Esc) is theirs to lift, never the log's.
  if (last && last.action !== "held" && hadActivity(await readLog(host, dir), last.at, check.actor)) last = undefined
  const decision = keepaliveDecision({ state, locks, platform: host.platform, liveAgents: check.liveAgents, actor: check.actor, last, maxTries: keepaliveTries(host), cause: check.cause })
  if (check.commit && decision.action !== "none") {
    const at = host.now().toISOString()
    const memory: KeepaliveMemory = { signature: decision.signature, action: decision.action, tries: decision.tries, at, ready: decision.ready, orphans: decision.orphans }
    if (Object.keys(decision.agents).length) memory.agents = decision.agents
    const tool = toolOf(check.actor)
    if (tool) memory.tool = tool
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
  const what = keepaliveWhat(memory.ready ?? [], memory.orphans ?? [], memory.agents, memory.tool)
  if (memory.action === "stalled") return tr(memory.cause === "error" ? "status.keepalive_error" : "status.keepalive_stalled", { what, tries: maxTries })
  if (memory.action === "held") return tr("status.keepalive_held")
  return tr("status.keepalive_nudged", { at: memory.at, tries: memory.tries, max: maxTries })
}

/** The line of the sidebar when the host gave up on the progress the run is at now (cleared by any progress). */
export function keepaliveNotice(run: RunFile, tasks: TasksFile, memory: KeepaliveMemory | undefined): string | undefined {
  if (memory?.action !== "stalled" || run.status !== "active" || run.keepalive === false) return undefined
  if (memory.signature !== progressSignature(tasks) || counts(tasks.tasks).remaining === 0) return undefined
  return tr("view.stalled", { what: keepaliveWhat(memory.ready ?? [], memory.orphans ?? [], memory.agents, memory.tool) })
}

/** The sidebar's line for a run read now, or undefined when the host has not given up on it as it stands. */
export async function stalledNotice(host: Host, root: string, runId: string): Promise<string | undefined> {
  const dir = runDir(root, runId)
  const [run, tasks, memory] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined), readKeepalive(host, dir)])
  return run && tasks ? keepaliveNotice(run, tasks, memory) : undefined
}
