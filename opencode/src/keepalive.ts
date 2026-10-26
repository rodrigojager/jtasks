// The keepalive in OpenCode (plan rev. 5.3): the root session (the orchestrator) going idle is the moment to decide.
// The core decides with the subagents still alive (child sessions busy, or holding a task they started); "nudge"
// becomes a synthetic message to the root session (`session.synthetic`, queued, it resumes the loop), "stalled" a
// line in the sidebar and a toast in the TUI (the view's `notice`, through the RPC's `changed`), also at once after a
// failed execution (nothing is sent then). Never after an interrupted execution (quiet until the run moves).

import { checkKeepalive, holdKeepalive, type Host, type KeepaliveDecision } from "../core/core.js"
import type { Bindings } from "./binding.ts"

export type Outcome = "succeeded" | "failed" | "interrupted"

export interface KeepaliveSink {
  /** Sends the message to the root session (a synthetic input that resumes it); absent when the host has no such call. */
  send?: (sessionID: string, text: string) => Promise<unknown>
  /** The run's view changed (a give-up to show). */
  changed: (run: string) => Promise<unknown>
  /** The root's execution failed: pauses the run when the failure is transient (then nothing else happens). */
  transient?: (root: string) => Promise<boolean>
}

/** How long a sent message counts as on its way (its execution not seen starting yet). */
const PENDING_MS = 60_000
/** The root's idle waits this long for the execution's own end (interrupted, failed) to arrive. */
export const SETTLE_MS = 300

export class RootKeepalive {
  /** Child sessions alive, by session: their root. */
  private readonly children = new Map<string, string>()
  private readonly outcome = new Map<string, Outcome | undefined>()
  private readonly pending = new Map<string, number>()
  private readonly started = new Map<string, number>()
  /** Roots whose idle is being decided now: a second idle meanwhile is the same one. */
  private readonly deciding = new Set<string>()

  constructor(
    private readonly host: Host,
    private readonly bindings: Bindings,
    private readonly sink: KeepaliveSink,
    private readonly settleMs = SETTLE_MS,
  ) {}

  /** A child session started a task (`jtasks start` or `claim`): alive until its session ends. */
  async taskStarted(sessionID: string): Promise<void> {
    if (await this.bindings.isChild(sessionID)) this.children.set(sessionID, await this.bindings.root(sessionID))
  }

  /** One event of OpenCode's stream; answers what the keepalive did on a root's idle (tests read it). */
  async onEvent(type: string, sessionID: string): Promise<KeepaliveDecision | undefined> {
    const child = await this.bindings.isChild(sessionID)
    if (type === "session.execution.started") {
      if (child) this.children.set(sessionID, await this.bindings.root(sessionID))
      else {
        this.outcome.set(sessionID, undefined)
        this.pending.delete(sessionID)
        this.started.set(sessionID, (this.started.get(sessionID) ?? 0) + 1)
      }
      return undefined
    }
    const ended = /^session\.execution\.(succeeded|failed|interrupted)$/.exec(type)?.[1] as Outcome | undefined
    if (ended) {
      if (child) this.children.delete(sessionID)
      else this.outcome.set(sessionID, ended)
      return undefined
    }
    if (type === "session.deleted") {
      this.children.delete(sessionID)
      return undefined
    }
    if (type !== "session.idle") return undefined
    if (child) {
      this.children.delete(sessionID)
      return undefined
    }
    return this.rootIdle(sessionID)
  }

  private async rootIdle(root: string): Promise<KeepaliveDecision | undefined> {
    if (!this.sink.send || this.deciding.has(root)) return undefined
    this.deciding.add(root)
    try {
      return await this.decideIdle(root)
    } finally {
      this.deciding.delete(root)
    }
  }

  private async decideIdle(root: string): Promise<KeepaliveDecision | undefined> {
    if (!this.sink.send) return undefined
    const run = await this.bindings.run(root)
    if (!run) return undefined
    // The execution's own end may arrive just after the idle: wait for it, and give up if another one started.
    const before = this.started.get(root) ?? 0
    await this.host.sleep(this.settleMs)
    if ((this.started.get(root) ?? 0) !== before) return undefined
    const since = this.pending.get(root)
    if (since !== undefined && this.host.now().getTime() - since < PENDING_MS) return undefined
    const outcome = this.outcome.get(root)
    if (outcome === "interrupted") {
      await holdKeepalive(this.host, run.root, run.run)
      return undefined
    }
    // A transient failure of the root itself (rev. 5.7): the run is paused, the keepalive stays quiet.
    if (outcome === "failed" && this.sink.transient && (await this.sink.transient(root).catch(() => false))) {
      await this.sink.changed(run.run).catch(() => undefined)
      return undefined
    }
    const liveAgents = [...this.children.values()].filter((r) => r === root).length
    // A failed execution: nothing is sent (it could fail the same way), but the sidebar says it at once.
    const cause = outcome === "failed" ? { cause: "error" as const } : {}
    const decision = await checkKeepalive(this.host, { root: run.root, run: run.run, liveAgents, actor: `opencode:${root}`, commit: true, ...cause })
    if (decision.action === "nudge") {
      this.pending.set(root, this.host.now().getTime())
      await this.sink.send(root, decision.text).catch((error) => {
        this.pending.delete(root)
        console.warn(`[jtasks] keepalive not sent: ${(error as Error).message}`)
      })
    }
    if (decision.action === "stalled") await this.sink.changed(run.run).catch(() => undefined)
    return decision
  }
}
