// The pause a host makes by itself on a transient failure of the provider (plan rev. 5.7), and the way back. The
// classifier is ./transient.ts; this module writes run.json under the run's lock. A host calls `pauseForFailure` when
// a subagent (or the orchestrator) died on a transient failure, in place of `release --agent-ended`: the run is
// paused, every task in progress stays in progress with its locks (the host keeps renewing them while it lives), and
// the subagent's place in the host is kept. `resumeIfDue` (the host's clock) and `resumeNow` (a reset the host
// detected) leave the pause and answer the text that tells the orchestrator to resume the same agents.

import { leavePause, log, reload, resolveRun, type LeftPause } from "./actions.ts"
import { progressSignature } from "./keepalive.ts"
import type { AutoPause } from "./schema.ts"
import { writeRun, withLock } from "./store.ts"
import type { ToolContext } from "./tool.ts"
import { pausedTasks, resumeAtOf, type Classification } from "./transient.ts"
import { actorOf } from "./plan.ts"

export interface PauseRequest {
  run: string
  /** The failure, classified: only a transient one pauses. */
  failure: Extract<Classification, { transient: true }>
  /** The task whose subagent died, and that subagent (Claude Code's agent id, OpenCode's child session). */
  task?: string
  agent?: string
}

/**
 * Pauses the run for a transient failure, or adds to the pause it is already in (the latest reset wins). A run that
 * is done is left alone; a run paused by hand stays so (no automatic resume), with the tasks recorded. Answers the
 * pause as written, or undefined when nothing was done.
 */
export async function pauseForFailure(ctx: ToolContext, req: PauseRequest): Promise<AutoPause | undefined> {
  let first
  try {
    first = await resolveRun(ctx, { action: "pause", positionals: [], options: { run: req.run } })
  } catch {
    return undefined
  }
  return withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const run = { ...state.run }
    if (run.status === "done") return undefined
    const now = ctx.host.now()
    const inProgress = state.tasks.tasks.filter((t) => t.status === "in_progress")
    const named = req.task ? { task: req.task, ...(req.agent ? { agent: req.agent } : {}) } : undefined
    const before = run.status === "paused" ? run.pause : undefined
    const byHand = run.status === "paused" && !before
    const signature = progressSignature(state.tasks)
    const streak = run.pauseStreak?.signature === signature ? run.pauseStreak.n : 0
    const resets = [before?.resetAt, req.failure.resetAt].filter((x): x is string => !!x).sort()
    const resetAt = resets.at(-1)
    const tasks = pausedTasks(inProgress, named).map((t) => {
      // An agent an earlier failure named is kept when this one names none.
      const earlier = before?.tasks.find((b) => b.id === t.id)
      return !t.agent && earlier?.agent ? { ...t, agent: earlier.agent } : t
    })
    const pause: AutoPause = {
      kind: req.failure.kind,
      detail: req.failure.detail,
      at: before?.at ?? now.toISOString(),
      streak,
      tasks,
      by: actorOf({ ...ctx, agent: undefined }),
    }
    if (resetAt) pause.resetAt = resetAt
    const resumeAt = byHand || (before && !before.resumeAt) ? undefined : resumeAtOf(resetAt, streak, now)
    if (resumeAt) pause.resumeAt = resumeAt
    run.status = "paused"
    run.pause = pause
    await writeRun(ctx.host, state.dir, run)
    await log(ctx, state, {
      action: "auto-pause",
      kind: pause.kind,
      detail: pause.detail,
      kept: tasks.map((t) => t.id),
      ...(req.task ? { task: req.task } : {}),
      ...(resetAt ? { resetAt } : {}),
      ...(resumeAt ? { resumeAt } : {}),
      streak,
    })
    return pause
  })
}

async function stateOf(ctx: ToolContext, run: string) {
  try {
    return await resolveRun(ctx, { action: "unpause", positionals: [], options: { run } })
  } catch {
    return undefined
  }
}

/** The host's clock: leaves the transient pause once its `resumeAt` has come. */
export async function resumeIfDue(ctx: ToolContext, run: string): Promise<LeftPause | undefined> {
  const state = await stateOf(ctx, run)
  const pause = state?.run.status === "paused" ? state.run.pause : undefined
  if (!state || !pause?.resumeAt || Date.parse(pause.resumeAt) > ctx.host.now().getTime()) return undefined
  return leavePause(ctx, state, { due: ctx.host.now(), auto: true })
}

/**
 * A reset the host detected (Claude Code's `quota_auto_resume_fired`): leaves a transient pause of a limit or quota at
 * once, unless the person paused it by hand meanwhile (no `resumeAt`).
 */
export async function resumeNow(ctx: ToolContext, run: string, how: string): Promise<LeftPause | undefined> {
  const state = await stateOf(ctx, run)
  const pause = state?.run.status === "paused" ? state.run.pause : undefined
  if (!state || !pause?.resumeAt) return undefined
  return leavePause(ctx, state, { auto: true, how })
}
