// A simulated host for race tests (ticket 60): the real Node host underneath, with each actor's calls recorded in one
// shared order, an optional clock skew (an actor whose clock runs ahead sees everybody else's work as old), and hooks
// that hold a call back until something else happened (or a deadline passed). The interleavings are written in terms
// of what any implementation does (reading tasks.json, running git, looking at a pid), never of its internals, so the
// same test runs against the old write lock and against the events.

import type { Host } from "../src/host.ts"

export interface Call {
  actor: string
  op: string
  /** The path, or the command line for `run`. */
  arg: string
  phase: "before" | "after"
  result?: unknown
}

export class Schedule {
  readonly calls: Call[] = []
  private wakers: (() => void)[] = []

  record(call: Call) {
    this.calls.push(call)
    const w = this.wakers
    this.wakers = []
    for (const f of w) f()
  }

  /** Whether a call matching `pred` happened (its `after`, unless asked for `before`). */
  saw(pred: (c: Call) => boolean): boolean {
    return this.calls.some(pred)
  }

  /** Resolves once `pred` holds, or after `ms` (a hold-back must never deadlock an implementation that serializes). */
  async until(pred: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!pred()) {
      const left = deadline - Date.now()
      if (left <= 0) return false
      await new Promise<void>((resolve) => {
        this.wakers.push(resolve)
        setTimeout(resolve, Math.min(left, 100))
      })
    }
    return true
  }
}

export interface ActorOptions {
  /** Added to the clock: an actor that sees every lock as stale (a holder stalled for longer than the stale limit). */
  skewMs?: number
  /** Called before every call of the actor; awaiting it holds the call back. */
  before?: (op: string, arg: string, args: unknown[]) => Promise<void> | void
}

const norm = (p: unknown) => String(p).replace(/\\/g, "/")

/** The host one actor of a race uses. */
export function actorHost(base: Host, actor: string, schedule: Schedule, opts: ActorOptions = {}): Host {
  const wrap =
    <A extends unknown[], R>(op: string, f: (...args: A) => Promise<R>, argOf: (...args: A) => string) =>
    async (...args: A): Promise<R> => {
      const arg = argOf(...args)
      schedule.record({ actor, op, arg, phase: "before" })
      await opts.before?.(op, arg, args)
      const result = await f(...args)
      schedule.record({ actor, op, arg, phase: "after", result })
      return result
    }
  const path = (p: string) => norm(p)
  const host: Host = {
    ...base,
    platform: base.platform,
    now: () => new Date(Date.now() + (opts.skewMs ?? 0)),
    readText: wrap("readText", (p: string) => base.readText(p), path),
    writeText: wrap("writeText", (p: string, t: string) => base.writeText(p, t), path),
    appendText: wrap("appendText", (p: string, t: string) => base.appendText(p, t), path),
    rename: wrap("rename", (a: string, b: string) => base.rename(a, b), (_a, b) => norm(b)),
    remove: wrap("remove", (p: string, o?: { recursive?: boolean }) => base.remove(p, o), path),
    mkdir: wrap("mkdir", (p: string) => base.mkdir(p), path),
    mkdirExclusive: wrap("mkdirExclusive", (p: string) => base.mkdirExclusive(p), path),
    list: wrap("list", (p: string) => base.list(p), path),
    stat: wrap("stat", (p: string) => base.stat(p), path),
    run: wrap("run", (argv: readonly string[], o?: Parameters<Host["run"]>[1]) => base.run(argv, o), (argv) => argv.join(" ")),
    spawn: wrap("spawn", (argv: readonly string[], o?: Parameters<Host["spawn"]>[1]) => base.spawn(argv, o), (argv) => argv.join(" ")),
  }
  if (base.alive) host.alive = wrap("alive", (pid: number) => base.alive!(pid), (pid) => String(pid))
  return host
}

/** Whether a call looks at a pid (Node's signal 0, tasklist or ps): where the processes of a task are read. */
export function looksAtPid(op: string, arg: string): boolean {
  return op === "alive" || (op === "run" && /^(tasklist|ps) /.test(arg))
}
