// The keepalive in Claude Code (plan rev. 5.3): at the end of the main loop's turn, the core's decision with the
// session's live subagents; a "run is idle" message through $.prompt.submit when it says so, checked again right
// before it is delivered (a turn may have moved the run meanwhile); a toast, a notification and a status line when it
// gives up, or at once after an API error or a refusal (nothing is sent then). Never on an interrupted turn (quiet
// until the run moves), never over a draft the person is typing (it waits until the box is empty and the session
// idle), never in a -p run or the SDK.

import { checkKeepalive, holdKeepalive, stalledNotice, type KeepaliveDecision } from '../core/core.js'
import { createModHost, type Port } from './mod-host.ts'

/** What the keepalive needs from $ besides the port (closures built in session.start). */
export interface KeepaliveUi {
  /** The session's agents and their status ($.agent.list), or undefined when the engine does not answer. */
  agents(): Promise<{ status: string }[] | undefined>
  /** The person's draft in the prompt box ($.prompt.read). */
  draft(): Promise<string>
  submit(text: string): Promise<unknown>
  /** The host gave up: tell the person (toast, notification, status line). */
  stalled(notice: string): void
  /** Clears the status line of an earlier give-up. */
  clear(): void
}

/** Agents whose loop can still end and wake the orchestrator. */
const ALIVE = new Set(['pending', 'running', 'waiting'])

export class Keepalive {
  /** A message is on its way (submitted, not delivered yet): never a second one. */
  private pending = false
  /** A message waits for the person's draft to go (or for the session to be idle). */
  private deferred = false
  private busy = false
  private shown = false
  /** The message of a run that left a transient pause (rev. 5.7), waiting for the session to be idle and the box empty. */
  private queued: string | undefined
  /** That message is on its way: let it through, whatever the run looks like. */
  private resuming = false

  constructor(
    private readonly port: Port,
    private readonly ui: KeepaliveUi,
    private readonly interactive: boolean,
  ) {}

  /** The subagents alive now: the engine's list, else the ones the mod saw spawned for the run. */
  private async liveAgents(run: string): Promise<number> {
    const listed = await this.ui.agents().catch(() => undefined)
    if (listed) return listed.filter((a) => ALIVE.has(a.status)).length
    return Object.values(await this.port.getAgents()).filter((a) => a.run === run).length
  }

  private async actor(): Promise<string> {
    return `claude:${await this.port.sessionId()}`
  }

  /**
   * The module (re)loaded: the status line an earlier load left is ours to keep or clear, by what the run's
   * `keepalive.json` says now.
   */
  async restore(status: (text: string | undefined) => void): Promise<void> {
    const bound = await this.port.getRun()
    const notice = bound ? await stalledNotice(createModHost(this.port, await this.port.cwd()), bound.root, bound.run).catch(() => undefined) : undefined
    this.shown = !!notice
    status(notice?.replace(/^⚠\s*/, ''))
  }

  /** A turn of the main loop started: whatever was waiting is moot (that turn's end decides again). */
  turnStarted(): void {
    this.busy = true
    this.pending = false
    this.deferred = false
    this.resuming = false
  }

  /**
   * The run left a transient pause: `text` tells the orchestrator to resume the same agents. Sent when the session is
   * idle and the box empty (a turn running, or a draft, makes it wait); never in a -p run or the SDK.
   */
  deliver(text: string): void {
    if (!this.interactive) return
    this.queued = text
    void this.flush().catch(() => undefined)
  }

  private async flush(): Promise<boolean> {
    const text = this.queued
    if (!text || this.busy || this.pending) return false
    if ((await this.ui.draft().catch(() => '')).trim()) return false
    this.queued = undefined
    this.pending = true
    this.resuming = true
    void this.ui
      .submit(text)
      .catch(() => undefined)
      .finally(() => {
        this.pending = false
      })
    return true
  }

  /** The main loop's turn ended; `reason` as `turn.complete` says it. */
  async turnEnded(reason: string): Promise<KeepaliveDecision | undefined> {
    this.busy = false
    if (!this.interactive) return undefined
    const bound = await this.port.getRun()
    if (!bound) return undefined
    if (reason === 'aborted') {
      this.deferred = false
      this.clearShown()
      await holdKeepalive(createModHost(this.port, await this.port.cwd()), bound.root, bound.run)
      return undefined
    }
    // An API error or a refusal: nothing is sent (it could fail the same way), but the person is told at once.
    if (reason === 'error' || reason === 'refusal') return this.decide('error')
    if (reason !== 'answer') return undefined
    if (this.queued && (await this.flush())) return undefined
    return this.decide()
  }

  /**
   * The clock: a message that waited for the draft goes once the box is empty and the session idle; a give-up on
   * the status line goes away once it no longer holds (the run moved, `keepalive on` or `unpause` elsewhere).
   */
  async tick(): Promise<KeepaliveDecision | undefined> {
    if (this.shown) {
      const bound = await this.port.getRun()
      const notice = bound ? await stalledNotice(createModHost(this.port, await this.port.cwd()), bound.root, bound.run).catch(() => 'keep') : undefined
      if (!notice) this.clearShown()
    }
    if (this.queued && (await this.flush())) return undefined
    if (!this.deferred || this.busy || this.pending) return undefined
    return this.decide()
  }

  private async decide(cause?: 'error'): Promise<KeepaliveDecision | undefined> {
    if (this.pending) return undefined
    const bound = await this.port.getRun()
    if (!bound) return undefined
    if (!cause && (await this.ui.draft().catch(() => '')).trim()) {
      this.deferred = true
      return undefined
    }
    this.deferred = false
    const host = createModHost(this.port, await this.port.cwd())
    const decision = await checkKeepalive(host, {
      root: bound.root,
      run: bound.run,
      liveAgents: await this.liveAgents(bound.run),
      actor: await this.actor(),
      commit: true,
      ...(cause ? { cause } : {}),
    })
    if (decision.action === 'nudge') {
      this.clearShown()
      this.pending = true
      void this.ui
        .submit(decision.text)
        .catch(() => undefined)
        .finally(() => {
          this.pending = false
        })
    } else if (decision.action === 'stalled') {
      this.shown = true
      this.ui.stalled(decision.notice)
    } else if (decision.reason !== 'stalled' && decision.reason !== 'held') this.clearShown()
    return decision
  }

  private clearShown(): void {
    if (!this.shown) return
    this.shown = false
    this.ui.clear()
  }

  /** Right before the message is delivered: still idle with work to do? (Without counting it again.) */
  async stillWanted(): Promise<boolean> {
    if (this.resuming) return true
    const bound = await this.port.getRun()
    if (!bound) return false
    const host = createModHost(this.port, await this.port.cwd())
    const decision = await checkKeepalive(host, { root: bound.root, run: bound.run, liveAgents: await this.liveAgents(bound.run), actor: await this.actor(), fresh: true })
    return decision.action !== 'none'
  }
}
