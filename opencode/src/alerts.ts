// What the plugin tells the orchestrator by itself (plan rev. 5.8): every transition of a run that the root session
// did not ask for (a subagent's session ending with its task back in the queue or waiting for a process, the process
// ending, a lost lock, attempts or ends of a subagent run out, a pause for a person, what another window did) is
// read from the run's log.jsonl on a timer, and sent to each root session bound to it as a synthetic message (queued:
// it resumes the session), with the run's status line; the TUI gets an `alert` event and shows a toast. OpenCode does
// not reopen a child session when its process ends, so the message about that names the session to resume
// (`task_id`). And the result of every subagent call carries the run's status line read at its end.

import { alertNotice, alertText, logEnd, readAlerts, readBrief, readRun, readTasks, runDir, type Host } from "../core/core.js"

export interface AlertSink {
  /** Sends the message to a root session (a synthetic input that resumes it); absent when the host has no such call. */
  send?: (sessionID: string, text: string) => Promise<unknown>
  /** Tells the person: the TUI's toast, through the RPC's `alert` event. */
  alert: (run: string, notice: string) => Promise<unknown>
}

export class RunAlerts {
  /** Where each root session read each run's log up to, by `<run>|<root session>`. */
  private readonly offsets = new Map<string, number>()

  constructor(
    private readonly host: Host,
    private readonly sink: AlertSink,
  ) {}

  /** A root session works on a run: its alerts start where the log is now (what happened before is not news). */
  async watch(run: { run: string; root: string }, session: string): Promise<void> {
    const key = `${run.run}|${session}`
    if (this.offsets.has(key)) return
    this.offsets.set(key, await logEnd(this.host, run.root, run.run))
  }

  /** New transitions for one root session: one message to it and one notice for the person. Answers the message. */
  async check(run: { run: string; root: string }, session: string): Promise<string | undefined> {
    const key = `${run.run}|${session}`
    const offset = this.offsets.get(key)
    if (offset === undefined) {
      await this.watch(run, session)
      return undefined
    }
    const read = await readAlerts(this.host, run.root, run.run, offset, `opencode:${session}`)
    this.offsets.set(key, read.offset)
    if (!read.entries.length) return undefined
    const dir = runDir(run.root, run.run)
    const [file, tasks] = await Promise.all([readRun(this.host, dir).catch(() => undefined), readTasks(this.host, dir).catch(() => undefined)])
    if (!file || !tasks) return undefined
    const text = alertText(file, tasks, read.entries, "opencode")
    const notice = alertNotice(file, tasks, read.entries)
    console.warn(`[jtasks] ${notice}`)
    await this.sink.alert(run.run, notice).catch(() => undefined)
    await this.sink.send?.(session, text).catch((error) => console.warn(`[jtasks] alert not sent: ${(error as Error).message}`))
    return text
  }
}

/** The status line appended to a subagent call's result (English frame, the tool's words inside). */
export async function statusTail(host: Host, run: { run: string; root: string }): Promise<string | undefined> {
  const brief = await readBrief(host, run.root, run.run).catch(() => undefined)
  return brief ? `\n\njtasks status of run ${run.run}, read now from tasks.json: ${brief}` : undefined
}
