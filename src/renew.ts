// A task's locks outliving the run's `holdTtl` (plan rev. 5.4, 5.5): jlock's `--ttl` expires a hold that long after it
// was granted, even with its owner alive. So a host that stays open (the mod, the plugin) renews the holds of its
// tasks in progress shortly before they expire: with jlock 0.2.0, `jlock renew` pushes the deadline back in place
// (the lock is never let go, the same hold keeps it); with an older jlock, it gives them back and takes them again
// at once (`release`, then `hold --no-wait`). And `done` takes back its own keys whose hold expired when nobody else
// took them meanwhile. The ttl stays what it was for: the net under a window that died (nobody renews). Each pass also
// takes back, as soon as they are free, the keys this host's tasks gave back with `jtasks yield` (rev. 5.6).

import { log, reload, releaseHolds, resolveRun, retakeMissing, retakeYielded, takeKeys } from "./actions.ts"
import { ownerOf, taskKeys, type RunState } from "./frontier.ts"
import { canRenew, jlockList, jlockRenew, type JlockLock } from "./jlock.ts"
import type { Task } from "./schema.ts"
import { DEFAULT_HOLD_TTL } from "./schema.ts"
import { readTasks, withLock } from "./store.ts"
import type { ToolContext } from "./tool.ts"

/** How often a long-lived host looks at its holds. */
export const RENEW_EVERY_MS = 60_000
/** At most this long before the expiry, a hold is renewed. */
export const RENEW_MARGIN_MS = 10 * 60_000

/** `30m`, `2h`, `1d`, `500ms` (the plan's DURATION) in milliseconds. */
export function ttlMs(ttl: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(ttl.trim())
  if (!m) return 0
  const n = Number(m[1])
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"]
}

/**
 * How long before the expiry a hold is renewed: ten minutes, or half the ttl when it is short, and never less than
 * two passes of the host (an expiry must not fall between them).
 */
export function renewMargin(ttl: number, every = RENEW_EVERY_MS): number {
  return Math.min(RENEW_MARGIN_MS, Math.max(Math.floor(ttl / 2), 2 * every))
}

/**
 * `fresh`: nothing to do. `renewed`: a new deadline (in place, or given back and taken again). `retaken`: keys whose hold had
 * expired, taken again. `lost`: someone else holds one of them now (the others are kept; `status` and `done` say
 * so). `none`: the task has no keys.
 */
export type RenewResult = "fresh" | "renewed" | "retaken" | "lost" | "none"

/**
 * When the earliest of these holds expires (epoch ms), or undefined when none has a deadline: jlock's `expires`
 * (which counts `jlock renew`) when it says, else `since + ttl_secs` (a jlock before 0.2.0).
 */
export function earliestExpiry(locks: JlockLock[]): number | undefined {
  let out: number | undefined
  for (const l of locks) {
    const h = l.holder
    if (!h) continue
    let at: number
    if (h.expires !== undefined) {
      if (h.expires === null) continue
      at = Date.parse(h.expires)
    } else {
      const since = h.since ? Date.parse(h.since) : NaN
      if (typeof h.ttl_secs !== "number") continue
      at = since + h.ttl_secs * 1000
    }
    if (!Number.isFinite(at)) continue
    out = out === undefined ? at : Math.min(out, at)
  }
  return out
}

/** What a task's holds need, from one `jlock list --group` of the run. */
export function renewalNeed(state: RunState, task: Task, locks: JlockLock[], platform: string, now: number, every = RENEW_EVERY_MS): "none" | "fresh" | "retake" | "renew" {
  const keys = taskKeys(state.root, task, platform)
  if (!keys.length) return "none"
  const owner = ownerOf(state.run.id, task.id)
  const mine = locks.filter((l) => l.holder?.owner === owner && l.holder.stale !== true)
  const held = new Set(mine.map((l) => l.key))
  if (keys.some((k) => !held.has(k))) return "retake"
  const expiry = earliestExpiry(mine)
  const margin = renewMargin(ttlMs(state.run.holdTtl ?? DEFAULT_HOLD_TTL), every)
  return expiry === undefined || expiry - now > margin ? "fresh" : "renew"
}

/**
 * A new deadline for a task's holds. With `jlock renew`, in place: the lock is never let go; a key it could not renew
 * (expired meanwhile, or taken) is taken back like on a `done`. Before jlock 0.2.0: given back and taken again at once
 * (anyone queued for a key gets it first).
 */
async function renewTask(ctx: ToolContext, state: RunState, task: Task): Promise<RenewResult> {
  const keys = taskKeys(state.root, task, ctx.host.platform)
  if (await canRenew(ctx.host)) {
    const ttl = state.run.holdTtl ?? DEFAULT_HOLD_TTL
    await jlockRenew(ctx.host, state.run.id, ownerOf(state.run.id, task.id), ttl)
    // Without keys, `renew` skips the ones the owner no longer holds: whatever is missing is taken back here.
    const refused = await retakeMissing(ctx, state, task)
    await log(ctx, state, refused.length ? { action: "renew-lost", task: task.id, keys, refused } : { action: "renew", task: task.id, keys, ttl })
    return refused.length ? "lost" : "renewed"
  }
  await releaseHolds(ctx, state.run.id, task.id)
  const refused = await takeKeys(ctx, state, task, keys)
  await log(ctx, state, refused.length ? { action: "renew-lost", task: task.id, keys, refused } : { action: "renew", task: task.id, keys })
  return refused.length ? "lost" : "renewed"
}

/**
 * One pass of a long-lived host over a run: every task in progress whose owner `mine` accepts (this session and its
 * subagents) gets its holds renewed before they expire, or taken again when they did. The run's write lock is taken
 * per task and only around the release and the new hold, after re-reading the task (no `done` or `release` of it
 * runs in between); and if the task left `in_progress` anyway (a lock broken as stale), what was taken is given back.
 * Never throws: a failure is logged and left for the next pass.
 */
export async function renewRun(
  ctx: ToolContext,
  run: string,
  mine: (owner: string) => boolean,
  every = RENEW_EVERY_MS,
): Promise<{ task: string; result: RenewResult }[]> {
  let first: RunState
  try {
    first = await resolveRun(ctx, { action: "renew", positionals: [], options: { run } })
  } catch {
    return []
  }
  const candidates = first.tasks.tasks.filter((t) => t.status === "in_progress" && t.owner && mine(t.owner))
  if (!candidates.length) return []
  const locks = await jlockList(ctx.host, { group: run }).catch(() => undefined)
  if (!locks) return []
  const out: { task: string; result: RenewResult }[] = []
  for (const candidate of candidates) {
    const need = renewalNeed(first, candidate, locks, ctx.host.platform, ctx.host.now().getTime(), every)
    if (need === "none" || need === "fresh") {
      out.push({ task: candidate.id, result: need })
      continue
    }
    let result: RenewResult = "fresh"
    try {
      result = await withLock(ctx.host, first.dir, async () => {
        const state = await reload(ctx, first)
        const task = state.tasks.tasks.find((t) => t.id === candidate.id)
        if (!task || task.status !== "in_progress" || task.owner !== candidate.owner) return "fresh"
        if (need === "renew") return renewTask(ctx, state, task)
        return (await retakeMissing(ctx, state, task)).length ? "lost" : "retaken"
      })
      if (result === "renewed" || result === "retaken" || result === "lost") {
        const after = (await readTasks(ctx.host, first.dir).catch(() => undefined))?.tasks.find((t) => t.id === candidate.id)
        if (after?.status !== "in_progress") await releaseHolds(ctx, run, candidate.id).catch(() => [])
      }
    } catch (error) {
      await log(ctx, first, { action: "renew-failed", task: candidate.id, error: (error as Error).message }).catch(() => {})
    }
    out.push({ task: candidate.id, result })
  }
  // The queue of `yield` (rev. 5.6): what this host's tasks gave back is taken back as soon as it is free.
  await retakeYielded(ctx, first, (t) => !!t.owner && mine(t.owner))
  return out
}
