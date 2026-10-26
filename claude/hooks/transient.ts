// Transient failures in Claude Code (plan rev. 5.7). A loop that dies on an API error ends with `turn.complete`
// `reason: 'error'`, which carries no text; the classic StopFailure event carries the kind Claude Code gave it
// (`rate_limit`, `overloaded`, `server_error`, `authentication_failed`…), `error_details` and, in
// `last_assistant_message`, the error as the conversation shows it ("API Error: You've hit your session limit ·
// resets 12:50am"); with `agent_id` when it fired inside a subagent. This module keeps the last one of each loop and,
// at the loop's end, classifies it with the core's tables (with the turn's answer and the loop's last message as
// more text, when they are the rendered error). A StopFailure that arrives after its loop's end is still heard: the
// caller learns of it through `late`. A transient one pauses the run with the task kept (the caller keeps the
// subagent's place); the clock (`resumeAt`) or Claude Code's own `quota_auto_resume_fired` notification ends it.

import { classifyFailure, type Classification, type ProviderFailure } from '../core/core.js'

/** The main loop's key among the failures. */
export const MAIN = '(main)'

/** How long a subagent's end waits for its StopFailure, when the end came first. */
export const STOP_FAILURE_WAIT_MS = 1500
/** A StopFailure this long after its loop's end still counts for it. */
export const LATE_MS = 15_000

/** An error as Claude Code shows it in the conversation (`API Error: …`, the usage-limit lines). */
const RENDERED_ERROR = /^\s*(?:API Error\b|Claude AI usage limit reached|You've hit your \w+ limit|\S+ limit reached\s*[·∙])/i

interface Seen {
  kind?: string
  texts: string[]
  at: number
}

/** The classic event a hook hands us, as far as this module reads it. */
export interface StopFailureEvent {
  error?: string
  error_details?: string
  last_assistant_message?: string
  agent_id?: string
}

export class FailureWatch {
  private readonly seen = new Map<string, Seen>()
  /** Loops that ended on an error before their StopFailure: when it arrives, `late` hears it. */
  private readonly ended = new Map<string, number>()

  constructor(
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => Date,
    /** A StopFailure that came after its loop ended on an error, classified (the main loop's: `agentId` undefined). */
    private readonly late: (agentId: string | undefined, failure: Classification) => void,
  ) {}

  /** A StopFailure: kept for the end of its loop (the main one, or the subagent's), or handed to `late`. */
  stopFailure(e: StopFailureEvent): void {
    const key = e.agent_id ?? MAIN
    const texts = [e.last_assistant_message, e.error_details].filter((t): t is string => typeof t === 'string' && !!t.trim())
    const seen: Seen = { ...(e.error ? { kind: e.error } : {}), texts, at: this.now().getTime() }
    const ended = this.ended.get(key)
    this.ended.delete(key)
    if (ended !== undefined && seen.at - ended < LATE_MS) {
      this.late(e.agent_id, classifyFailure(this.failureOf(seen, []), this.now()))
      return
    }
    this.seen.set(key, seen)
  }

  private failureOf(seen: Seen | undefined, more: string[]): ProviderFailure {
    const failure: ProviderFailure = { texts: [...(seen?.texts ?? []), ...more] }
    if (seen?.kind) failure.kind = seen.kind
    return failure
  }

  /**
   * The failure that ended a loop (`agentId` absent: the main one), classified. `answer` is the turn's answer, `last`
   * reads the loop's last message (both count only when they are the error as Claude Code renders it: a subagent's
   * own words about rate limits or timeouts in the code it works on must not pause the run). `wait`: how long to wait
   * for a StopFailure that has not arrived yet (if it comes later still, `late` hears it).
   */
  async classify(agentId: string | undefined, answer: string, last: () => Promise<string | undefined>, wait = 0): Promise<Classification> {
    const key = agentId ?? MAIN
    for (let waited = 0; !this.seen.has(key) && waited < wait; waited += 100) await this.sleep(100)
    const seen = this.seen.get(key)
    this.seen.delete(key)
    const fresh = seen && this.now().getTime() - seen.at < 10 * 60_000 ? seen : undefined
    const more = [answer, await last().catch(() => undefined)].filter((t): t is string => !!t && RENDERED_ERROR.test(t))
    const failure = classifyFailure(this.failureOf(fresh, more), this.now())
    if (!fresh && !failure.transient) this.ended.set(key, this.now().getTime())
    return failure
  }
}
