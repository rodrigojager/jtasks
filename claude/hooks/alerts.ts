// What the mod tells the orchestrator by itself (plan rev. 5.8): every transition of the bound run that the
// orchestrator did not ask for (a subagent's end and its task back in the queue or waiting for a process, a lost lock,
// attempts or ends of a subagent run out, a pause for a person, what another window did) is read from the run's
// log.jsonl every two seconds (and at once after the mod's own `release --agent-ended`), sent to the main loop as a
// message through the keepalive's delivery (a plugin prompt, which enters once the session is idle), with the run's
// status line, and shown to the person (toast, notification). It does not wait for a ready task. The same clock
// looks at the tasks waiting for a process every ten seconds (core's sweepAwaiting): with the agent's status from
// $.agent.list for a wait the mod declared, with the pids for one `jtasks exec`/`wait` registered.

import { alertNotice, alertText, logEnd, readAlerts, readRun, readTasks, runDir, sweepAwaiting, type Task, type ToolContext } from '../core/core.js'
import { createModHost, type Port } from './mod-host.ts'

/** What the watch needs from $ besides the port (closures built in session.start). */
export interface AlertUi {
  /** Sends the message to the main loop (the keepalive's delivery: once idle, never over a draft). */
  deliver(text: string): void
  /** Tells the person (toast, notification). */
  tell(notice: string): void
  /** The session's agents and their status ($.agent.list), or undefined when the engine does not answer. */
  agents(): Promise<{ id: string; status: string }[] | undefined>
  /** The context of a core call as the session. */
  ctx(run: string): Promise<ToolContext>
}

/** An agent in one of these is still waiting on (or doing) its work: it comes back by itself. */
const WAITING = new Set(['pending', 'running', 'waiting'])

/** The tasks waiting for a process are looked at every this many ticks of the clock (the pids cost a `tasklist`/`ps`). */
export const SWEEP_EVERY_TICKS = 5

export class AlertWatch {
  /** Where each run's log was read up to, by `<root>|<run>`. */
  private readonly offsets = new Map<string, number>()
  private busy = false
  private ticks = 0

  constructor(
    private readonly port: Port,
    private readonly ui: AlertUi,
  ) {}

  private key(root: string, run: string): string {
    return `${root}|${run}`
  }

  /** Starts reading the bound run (or `bound`) from the end of its log: what happened before is not news. */
  async start(bound?: { root: string; run: string } | null): Promise<void> {
    const b = bound ?? (await this.port.getRun())
    if (!b) return
    const key = this.key(b.root, b.run)
    if (this.offsets.has(key)) return
    this.offsets.set(key, await logEnd(createModHost(this.port, await this.port.cwd()), b.root, b.run))
  }

  /** Checks run one after the other (the clock's and the end of a subagent's): never two reads of the same lines. */
  private chain: Promise<unknown> = Promise.resolve()

  /** New transitions of the bound run: one message to the orchestrator and one notice for the person. */
  check(): Promise<string | undefined> {
    const next = this.chain.then(() => this.read())
    this.chain = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<string | undefined> {
    const bound = await this.port.getRun()
    if (!bound) return undefined
    const key = this.key(bound.root, bound.run)
    if (!this.offsets.has(key)) {
      await this.start(bound)
      return undefined
    }
    const host = createModHost(this.port, await this.port.cwd())
    const actor = `claude:${await this.port.sessionId()}`
    const read = await readAlerts(host, bound.root, bound.run, this.offsets.get(key)!, actor)
    this.offsets.set(key, read.offset)
    if (!read.entries.length) return undefined
    const dir = runDir(bound.root, bound.run)
    const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
    if (!run || !tasks) return undefined
    const text = alertText(run, tasks, read.entries, 'claude')
    this.ui.deliver(text)
    this.ui.tell(alertNotice(run, tasks, read.entries))
    return text
  }

  /** Whether the agent a task waits for is still waiting (its status), or undefined when the engine does not say. */
  private async agentWaits(task: Task): Promise<boolean | undefined> {
    const agent = task.awaiting?.agent
    if (!agent) return undefined
    const list = await this.ui.agents().catch(() => undefined)
    if (!list) return undefined
    const found = list.find((a) => a.id === agent)
    return found ? WAITING.has(found.status) : false
  }

  /** The clock (every two seconds): the waits every fifth tick, then the log. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (this.ticks++ % SWEEP_EVERY_TICKS === 0) await this.sweep()
      await this.check()
    } finally {
      this.busy = false
    }
  }

  /** One pass over the bound run's tasks waiting for a process (core's sweepAwaiting); cheap when none waits. */
  async sweep(): Promise<void> {
    const bound = await this.port.getRun()
    if (!bound) return
    const host = createModHost(this.port, await this.port.cwd())
    const tasks = await readTasks(host, runDir(bound.root, bound.run)).catch(() => undefined)
    if (!tasks?.tasks.some((t) => t.status === 'in_progress' && t.awaiting)) return
    await sweepAwaiting(await this.ui.ctx(bound.run), bound.run, (task) => this.agentWaits(task))
  }
}
