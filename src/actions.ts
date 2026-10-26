// The run's actions: next, start, status (this ticket) and, later, done/skip/fail/release/retry/claim/pause/resume.

import { assess, blockerText, ownerOf, selectReady, sharedBlocker, taskKeys, waitingOf, waitingText, type RunState } from "./frontier.ts"
import { counts, progressLine } from "./format.ts"
import {
  branchExists,
  commitExists,
  commitReachable,
  currentBranch,
  git,
  gitOk,
  hasExcludeLine,
  isMerged,
  removeExcludeLine,
  requireRepo,
  shortHead,
  status as gitStatus,
} from "./git.ts"
import type { Resident } from "./host.ts"
import {
  describeKey,
  describeOwner,
  detachedHold,
  holdArgv,
  jlockVersion,
  MIN_JLOCK,
  versionAtLeast,
  type HoldMode,
  type HoldOutcome,
  JLOCK,
  jlockBin,
  jlockEnv,
  jlockList,
  jlockRelease,
  jlockReleaseKeys,
  startHold,
  type JlockAnswer,
  type Identity,
  type JlockLock,
} from "./jlock.ts"
import { unarchive } from "./housekeeping.ts"
import { chainKeys, changedUnder, claimStats, keepEdits, lastDeadlock, ownFiles, ownKeys, patchesUnder, readLog, reapplyPatches, releasedEdits, takenSince, type ReapplyReport } from "./keep.ts"
import { clearKeepalive, keepaliveStatus, keepaliveTries, progressSignature, readKeepalive, rearmKeepalive } from "./keepalive.ts"
import { formatWhen, kindLabel, resumeText } from "./transient.ts"
import { slugify } from "./ids.ts"
import { canonical, conflicts, covers, normalizeKey } from "./keys.ts"
import { effectLine, effectsOf, globalLedger, PATCH_MOVES, readEffects, recordEffect, setEffectState, type Effect, type NewEffect } from "./ledger.ts"
import { appliedPath, applyPatch, reversePatch } from "./patches.ts"
import { caseInsensitive, dirname, join } from "./paths.ts"
import { actorOf } from "./plan.ts"
import { DEFAULT_HOLD_TTL, type Hold, type RunFile, type Task, type TasksFile, type Yielded } from "./schema.ts"
import { appendLog, clone, jtasksHome, listRuns, readRun, readTasks, runDir, runsDir, SCRATCH, withLock, writeRun, writeTasks } from "./store.ts"
import { ticketPath, writeTicket } from "./tickets.ts"
import { addUsage, defineAction, ok, ToolError, type ParsedArgs, type ToolContext, type ToolResult } from "./tool.ts"
import { normalizeFileEntry } from "./validate.ts"
import { tr } from "./i18n.ts"

// ── The run of a command ──────────────────────────────────────────────────────────────────────────────────────

/** `--run`, else the run bound to the session (or JTASKS_RUN), else the only active run of the repository. */
export async function resolveRun(ctx: ToolContext, args: ParsedArgs): Promise<RunState> {
  const root = await requireRepo(ctx.host, ctx.cwd)
  const explicit = typeof args.options.run === "string" ? args.options.run : ctx.boundRun
  const runs = await listRuns(ctx.host, root)
  let entry = explicit ? runs.find((r) => r.run.id === explicit) : undefined
  if (explicit && !entry) throw new ToolError(tr("run.not_found", { run: explicit }))
  if (!entry) {
    const active = runs.filter((r) => r.run.status !== "done")
    if (active.length > 1)
      throw new ToolError(tr("run.many", { n: active.length, ids: active.map((r) => r.run.id).join(", ") }))
    // With every run finished, the most recent one (so `status` still answers "restam 0").
    entry = active[0] ?? runs[runs.length - 1]
    if (!entry) throw new ToolError(tr("run.none"))
  }
  if (!entry.tasks) throw new ToolError(tr("run.no_tasks", { run: entry.run.id }))
  return { root, dir: entry.dir, run: entry.run, tasks: entry.tasks }
}

/** Re-reads run.json and tasks.json (inside the write lock, before deciding). */
export async function reload(ctx: ToolContext, state: RunState): Promise<RunState> {
  const run = await readRun(ctx.host, state.dir)
  const tasks = await readTasks(ctx.host, state.dir)
  if (!run || !tasks) throw new ToolError(tr("run.gone", { run: state.run.id, dir: state.dir }))
  return { ...state, run, tasks }
}

export function findTask(state: RunState, id: string | undefined): Task {
  if (!id) throw new ToolError(tr("task.no_id"), 2)
  const task = state.tasks.tasks.find((t) => t.id === id)
  if (!task) throw new ToolError(tr("task.not_found", { run: state.run.id, id }))
  return task
}

export function taskIdArg(args: ParsedArgs): string | undefined {
  return args.positionals[0] ?? (typeof args.options.task === "string" ? args.options.task : undefined)
}

export async function log(ctx: ToolContext, state: RunState, entry: Record<string, unknown> & { action: string }) {
  await appendLog(ctx.host, state.dir, { at: ctx.host.now().toISOString(), actor: actorOf(ctx), ...entry })
}

/** Locks that matter for the frontier: under the repository, and the whole machine when `*` is in play. */
async function frontierLocks(ctx: ToolContext, state: RunState): Promise<JlockLock[]> {
  const needsAll = state.tasks.tasks.some((t) => t.exclusive && (t.status === "pending" || t.status === "in_progress"))
  return needsAll ? jlockList(ctx.host) : jlockList(ctx.host, { under: state.root })
}

function residentKey(run: string, task: string) {
  return `${run}/${task}`
}

/** Keeps a hold process of this host (`eof` mode) under `<run>/<task>`; its own end (14) marks the task lost. */
export function remember(ctx: ToolContext, state: RunState, task: string, resident: Resident) {
  if (!ctx.residents) return
  const run = state.run.id
  const key = residentKey(run, task)
  ctx.residents.set(key, [...(ctx.residents.get(key) ?? []), resident])
  void resident.exited.then(async (code) => {
    const list = ctx.residents?.get(key)
    // Released by us (the list no longer has it): an expected end.
    if (!list?.includes(resident)) return
    ctx.residents!.set(
      key,
      list.filter((r) => r !== resident),
    )
    if (code === JLOCK.LOST) await markLost(ctx, state, task).catch(() => {})
    ctx.onHoldExit?.(run, task, code)
  })
}

/**
 * A hold ended with 14 (someone forced the lock, or it expired with the machine asleep): an involuntary release.
 * The task goes back to pending (or failed at maxAttempts), its own edits kept as patches (rev. 5.6; a file someone
 * else holds now is not touched), the log says `lost`.
 */
export async function markLost(ctx: ToolContext, first: RunState, id: string): Promise<boolean> {
  const changed = await withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const copy = clone(state.tasks)
    const task = copy.tasks.find((t) => t.id === id)
    if (!task || task.status !== "in_progress") return false
    const now = ctx.host.now().toISOString()
    const kept = await keepTask(ctx, state, task)
    const to = backToPending(task, state.run.maxAttempts, tr("view.lost"), now)
    task.lost = now
    const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
    await writeTicket(ctx.host, state.dir, tasks, id)
    await log(ctx, state, { action: "lost", task: id, from: "in_progress", to, ...keptLog(kept) })
    return true
  })
  if (changed) await releaseHolds(ctx, first.run.id, id).catch(() => {})
  return changed
}

export function identity(ctx: ToolContext, state: RunState, task: Task): Identity {
  const meta: Record<string, string> = { task: task.id, run: state.run.id, tool: ctx.tool }
  if (ctx.session) meta.session = ctx.session
  return { owner: ownerOf(state.run.id, task.id), group: state.run.id, intent: task.title, meta }
}

/** The mode this host holds locks in (plan section 4): what the host says, else `eof` with residents, `detach` without. */
export function holdModeOf(ctx: ToolContext): HoldMode {
  return ctx.holdMode ?? (ctx.residents ? "eof" : "detach")
}

/**
 * Takes keys for a task with a `jlock hold` and the run's ttl: `--detach` (one call, jlock's keeper holds the lock,
 * no resident) or `--release-on-eof` (a resident this host keeps alive with its standard input open). Refuses a
 * jlock older than the tool works with.
 */
export async function acquireHold(
  ctx: ToolContext,
  state: RunState,
  task: Task,
  keys: string[],
  wait: { noWait: true } | { timeoutSec: number },
  timeoutMs: number,
): Promise<HoldOutcome> {
  const version = await jlockVersion(ctx.host)
  if (!versionAtLeast(version, MIN_JLOCK)) throw new ToolError(tr("jlock.too_old", { version, minimum: MIN_JLOCK }))
  const mode = holdModeOf(ctx)
  const argv = holdArgv(ctx.host, keys, identity(ctx, state, task), wait, { mode, ttl: state.run.holdTtl ?? DEFAULT_HOLD_TTL })
  if (mode === "detach") return detachedHold(ctx.host, argv, state.root, timeoutMs)
  const resident = await ctx.host.spawn(argv, { cwd: state.root, env: jlockEnv() })
  return startHold(ctx.host, resident, timeoutMs)
}

/**
 * Gives a task's ownership back: `release` on the standard input of each hold this host keeps, then
 * `jlock release --group <run> --owner gt:<run>/<task>` for the others (jlock's own keepers of `--detach`, or
 * another window's holds). A hold told this way ends with 0; one released from outside ends with 14 by itself.
 */
export async function releaseHolds(ctx: ToolContext, run: string, task: string): Promise<string[]> {
  const key = residentKey(run, task)
  const mine = ctx.residents?.get(key) ?? []
  ctx.residents?.delete(key)
  for (const r of mine) if (await r.send("release\n")) await Promise.race([r.exited, ctx.host.sleep(5000)])
  const released = await jlockRelease(ctx.host, run, ownerOf(run, task))
  for (const r of mine) await r.stop()
  return released.keys
}

// ── next ──────────────────────────────────────────────────────────────────────────────────────────────────────

defineAction(
  "next",
  async (ctx, args) => {
    const found = await resolveRun(ctx, args)
    // A task waiting for what it yielded takes it back first, if it is free now.
    const back = await retakeYielded(ctx, found)
    const state = back.length ? await reload(ctx, found) : found
    const platform = ctx.host.platform
    const raw = args.positionals[0] ?? (typeof args.options.limit === "string" ? args.options.limit : undefined)
    const limit = raw === undefined ? Infinity : Number(raw)
    if (!(limit > 0)) throw new ToolError(tr("next.bad_limit", { limit: String(raw) }), 2)
    const locks = await frontierLocks(ctx, state)
    const assessments = assess(state, locks, platform)
    const ready = selectReady(state, assessments, platform, limit)
    const c = counts(state.tasks.tasks)
    const blocked = assessments.filter((a) => !ready.includes(a.task))
    const items = ready.map((t) => ({
      id: t.id,
      title: t.title,
      profile: t.profile,
      acceptance: t.acceptance.map((a) => a.text),
      files: t.files,
      claimed: t.claimed ?? [],
      exclusive: !!t.exclusive,
      ticket: ticketPath(state.dir, state.tasks.tasks, t.id),
    }))
    const lines: string[] = retakenLines(back)
    if (ready.length) {
      lines.push(tr("next.ready", { n: ready.length, run: state.run.id }))
      for (const t of items) {
        const own = t.exclusive ? tr("next.exclusive") : t.files.join(", ") || tr("next.no_files")
        lines.push(tr("next.line", { id: t.id, title: t.title, profile: t.profile, own }))
        if (t.acceptance.length) lines.push(`  ${tr("next.criteria", { criteria: t.acceptance.join("; ") })}`)
        lines.push(`  ticket: ${t.ticket}`)
      }
    } else if (c.remaining === 0) lines.push(tr("next.nothing", { progress: progressLine(state.tasks.tasks) }))
    else if (state.run.status === "paused") lines.push(tr("next.paused"))
    else {
      const running = state.tasks.tasks.filter((t) => t.status === "in_progress").map((t) => t.id)
      lines.push(running.length ? tr("next.none_running", { tasks: running.join(", ") }) : tr("next.none"))
    }
    const why = blocked
      .filter((a) => a.blockers.length)
      .map((a) => `${a.task.id} ${a.blockers.map((b) => blockerText(b, state, platform)).join(" · ")}`)
    if (why.length) lines.push(tr("frontier.blocked", { list: why.join(" | ") }))
    const waiting = waitingOf(state, locks)
    if (waiting.size) lines.push(tr("frontier.waiting_list", { list: [...waiting].map(([id, w]) => `${id} ${waitingText(w, state, platform)}`).join(" | ") }))
    return ok(lines.join("\n"), {
      run: state.run.id,
      ready: items,
      blocked: blocked.map((a) => ({ id: a.task.id, reasons: a.blockers.map((b) => blockerText(b, state, platform)) })),
      remaining: c.remaining,
    })
  },
  "help.next",
)

// ── start ─────────────────────────────────────────────────────────────────────────────────────────────────────

defineAction(
  "start",
  async (ctx, args) => {
    const first = await resolveRun(ctx, args)
    const id = taskIdArg(args)
    return withLock(ctx.host, first.dir, async () => {
      const state = await reload(ctx, first)
      const task = findTask(state, id)
      if (state.run.status === "paused") throw new ToolError(tr("start.paused", { run: state.run.id }))
      if (task.status !== "pending") {
        const who = task.owner ? ` ${tr("start.owner", { owner: task.owner })}` : ""
        throw new ToolError(`${tr("start.not_pending", { id: task.id, status: task.status })}${who}`)
      }
      const byId = new Map(state.tasks.tasks.map((t) => [t.id, t]))
      const open = task.dependsOn.filter((d) => !["done", "skipped"].includes(byId.get(d)?.status ?? ""))
      if (open.length) throw new ToolError(tr("start.depends", { id: task.id, deps: open.join(", ") }))
      const mutex = sharedBlocker(state, task, ctx.host.platform)
      if (mutex?.kind === "shared") throw new ToolError(tr("start.shared", { id: task.id, path: mutex.path, other: mutex.task }))

      const keys = taskKeys(state.root, task, ctx.host.platform)
      const now = ctx.host.now().toISOString()
      let hold: Hold | undefined
      let resident: Resident | undefined
      if (keys.length) {
        const outcome = await acquireHold(ctx, state, task, keys, { noWait: true }, 15_000)
        if (outcome.answer.result !== "granted") {
          const a = outcome.answer
          const holder = typeof a.holder === "object" && a.holder ? describeOwner(a.holder.owner, state.run.id) : tr("start.other_owner")
          const key = a.failed ?? a.key ?? keys[0]!
          const via = a.via && a.via !== key ? ` (via ${describeKey(a.via, state.root, ctx.host.platform)})` : ""
          throw new ToolError(
            tr("start.busy", { id: task.id, key: describeKey(key, state.root, ctx.host.platform), holder, via }),
            1,
            { result: a.result, key, holder: a.holder, position: a.position, via: a.via },
          )
        }
        resident = outcome.resident
        hold = { keys, startedAt: now, kind: "start" }
        if (resident?.pid !== undefined) hold.pid = resident.pid
      }
      const changed = clone(state.tasks)
      const t = changed.tasks.find((x) => x.id === task.id)!
      t.status = "in_progress"
      t.attempts += 1
      t.owner = actorOf(ctx)
      t.startedAt = now
      t.holds = hold ? [hold] : []
      delete t.finishedAt
      delete t.lost
      let written: TasksFile
      try {
        written = await writeTasks(ctx.host, state.dir, changed, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, written, task.id)
      } catch (error) {
        if (keys.length) await releaseHoldsOf(ctx, state.run.id, task.id, resident, keys)
        throw error
      }
      if (resident) remember(ctx, state, task.id, resident)
      await log(ctx, state, { action: "start", task: task.id, from: "pending", to: "in_progress", keys })
      // The edits an earlier attempt left as patches (rev. 5.6) come back now, unless --fresh.
      const saved = t.patches ?? []
      let reapply: ReapplyReport | undefined
      const extra: string[] = []
      if (saved.length) {
        const again = clone(written)
        const u = again.tasks.find((x) => x.id === task.id)!
        if (args.options.fresh) {
          delete u.patches
          extra.push(tr("start.fresh", { n: saved.length, dir: join(state.dir, "patches", task.id) }))
          await log(ctx, state, { action: "fresh", task: task.id, dropped: saved.map((p) => p.patch) })
        } else {
          reapply = await reapplyPatches(ctx.host, { ...state, tasks: written }, u, () => true)
          extra.push(...reapplyLines(reapply))
          await log(ctx, state, { action: "reapply", task: task.id, ...reapplyData(reapply) })
        }
        written = await writeTasks(ctx.host, state.dir, again, written.revision)
        await writeTicket(ctx.host, state.dir, written, task.id)
      }
      const ticket = ticketPath(state.dir, changed.tasks, task.id)
      const own = keys.length ? tr("start.locked", { n: keys.length, owner: ownerOf(state.run.id, task.id) }) : tr("start.no_files")
      return ok(
        [
          tr("start.started", { id: task.id, attempt: t.attempts, own }),
          ...extra,
          `ticket: ${ticket}`,
          tr("start.hint", { id: task.id }),
        ].join("\n"),
        { run: state.run.id, task: task.id, keys, owner: t.owner, attempts: t.attempts, ticket, ...(reapply ? reapplyData(reapply) : {}) },
      )
    })
  },
  "help.start",
)

/** Gives back one hold only (its own keys): a start or claim that could not be recorded. */
async function releaseHoldsOf(ctx: ToolContext, run: string, task: string, resident: Resident | undefined, keys: string[]) {
  if (!resident || !(await resident.send("release\n"))) await jlockReleaseKeys(ctx.host, keys, ownerOf(run, task)).catch(() => {})
  if (!resident) return
  await Promise.race([resident.exited, ctx.host.sleep(3000)])
  await resident.stop()
}

// ── status ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function statusOf(ctx: ToolContext, state: RunState) {
  const platform = ctx.host.platform
  const [repoLocks, groupLocks] = await Promise.all([frontierLocks(ctx, state), jlockList(ctx.host, { group: state.run.id })])
  const assessments = assess(state, repoLocks, platform)
  const ready = selectReady(state, assessments, platform)
  const lines = [progressLine(state.tasks.tasks)]
  if (state.run.status === "paused") lines.push(tr("status.paused"))
  const pause = state.run.status === "paused" ? state.run.pause : undefined
  if (pause) lines.push(pauseStatusLine(pause, ctx.host.now()))
  const keepalive = keepaliveStatus(state.run, state.tasks, await readKeepalive(ctx.host, state.dir), keepaliveTries(ctx.host))
  if (keepalive) lines.push(keepalive)
  const running = state.tasks.tasks.filter((t) => t.status === "in_progress")
  const byKey = new Map([...repoLocks, ...groupLocks].map((l) => [l.key, l]))
  const waiting = waitingOf(state, [...byKey.values()])
  if (running.length) lines.push(tr("status.running", { list: running.map((t) => `${t.id} (${t.owner ?? "?"})`).join(" · ") }))
  if (waiting.size)
    lines.push(tr("frontier.waiting_list", { list: [...waiting].map(([id, w]) => `${id} ${waitingText(w, state, platform)}`).join(" | ") }))
  if (ready.length) lines.push(tr("status.ready", { list: ready.map((t) => t.id).join(", ") }))
  const blocked = assessments.filter((a) => a.blockers.length)
  if (blocked.length)
    lines.push(tr("frontier.blocked", { list: blocked.map((a) => `${a.task.id} ${a.blockers.map((b) => blockerText(b, state, platform)).join(" · ")}`).join(" | ") }))
  const failed = state.tasks.tasks.filter((t) => t.status === "failed")
  if (failed.length) lines.push(tr("status.failed", { list: failed.map((t) => `${t.id}: ${t.error ?? "?"}`).join(" | ") }))
  // Lost ownership: recorded by a long-lived host, or seen now (an in-progress task whose keys jlock no longer has).
  const lost = state.tasks.tasks.filter((t) => t.status === "pending" && t.lost).map((t) => t.id)
  for (const t of running) {
    const owner = ownerOf(state.run.id, t.id)
    const keys = taskKeys(state.root, t, platform)
    const held = groupLocks.filter((l) => l.holder?.owner === owner && l.holder.stale !== true).map((l) => l.key)
    if (keys.length && keys.some((k) => !held.includes(k))) lost.push(tr("status.lost_task", { id: t.id }))
  }
  if (lost.length) lines.push(tr("status.lost", { list: lost.join(", ") }))
  const locks = groupLocks.map((l) => ({
    key: describeKey(l.key, state.root, platform),
    holder: l.holder ? describeOwner(l.holder.owner, state.run.id) : null,
    queue: l.queue.map((q) => ({ owner: describeOwner(q.owner, state.run.id), position: q.position })),
  }))
  if (locks.length)
    lines.push(
      tr("status.locks", {
        run: state.run.id,
        list: locks
          .map((l) => `${l.key} → ${l.holder ?? tr("status.free")}${l.queue.length ? ` ${tr("status.queue", { n: l.queue.length, owners: l.queue.map((q) => q.owner).join(", ") })}` : ""}`)
          .join(" · "),
      }),
    )
  else lines.push(tr("status.no_locks"))
  return {
    text: lines.join("\n"),
    data: {
      run: state.run.id,
      status: state.run.status,
      keepalive: state.run.keepalive !== false,
      counts: counts(state.tasks.tasks),
      inProgress: running.map((t) => ({ id: t.id, owner: t.owner, waitingFor: waiting.get(t.id) ?? null })),
      ready: ready.map((t) => t.id),
      blocked: blocked.map((a) => ({ id: a.task.id, reasons: a.blockers.map((b) => blockerText(b, state, platform)) })),
      locks,
      ...(pause ? { pause } : {}),
    },
  }
}

/** The status line of a transient pause: why, what it kept and when it ends. */
function pauseStatusLine(pause: NonNullable<RunFile["pause"]>, now: Date): string {
  const kept = pause.tasks.length ? tr("pause.kept", { list: pause.tasks.map((t) => t.id).join(", ") }) : tr("pause.kept_none")
  const when = pause.resumeAt ? tr("pause.when_at", { at: formatWhen(pause.resumeAt, now) }) : tr("pause.when_person")
  return tr("status.auto_paused", { kind: kindLabel(pause.kind), detail: pause.detail, kept, when })
}

defineAction(
  "status",
  async (ctx, args) => {
    const state = await resolveRun(ctx, args)
    const s = await statusOf(ctx, state)
    if (!args.options.claims) return ok(s.text, s.data)
    // --claims (rev. 5.6): the run's most contested files, from its log.
    const claims = await claimStats(ctx.host, state, (k) => describeKey(k, state.root, ctx.host.platform))
    const lines = [s.text, claims.length ? tr("status.claims", { run: state.run.id }) : tr("status.claims_none")]
    for (const c of claims) {
      const parts = [tr("status.claims_claims", { n: c.claims })]
      if (c.timeouts) parts.push(tr("status.claims_timeouts", { n: c.timeouts }))
      if (c.deadlocks) parts.push(tr("status.claims_deadlocks", { n: c.deadlocks }))
      if (c.yields) parts.push(tr("status.claims_yields", { n: c.yields }))
      lines.push(`  ${c.file}: ${parts.join(" · ")} (${c.tasks.join(", ")})`)
    }
    return ok(lines.join("\n"), { ...s.data, claims })
  },
  "help.status",
)

addUsage("help.status.claims")

addUsage("help.status.run")

// ── Ownership and the working tree ────────────────────────────────────────────────────────────────────────────

/** The task's ownership as relative paths: files and claims; `.` (everything) when exclusive. */
export function possession(task: Task): string[] {
  return task.exclusive ? ["."] : [...task.files, ...(task.claimed ?? [])]
}

function inPossession(path: string, own: string[], insensitive: boolean): boolean {
  const p = insensitive ? path.toLowerCase() : path
  return own.some((o) => {
    const x = insensitive ? o.toLowerCase() : o
    return x === "." || covers(x, p)
  })
}

export interface TreeSplit {
  /** Changes inside the task's ownership: what its commit takes. */
  inside: string[]
  /** Changes inside what another task or program owns right now (parallel work in the same checkout). */
  others: string[]
  /** Changes nobody owns: they block the task's done. */
  outside: string[]
  /**
   * Changes a released task left on disk (rev. 5.6: the fallback when they could not be kept as patches, or a run
   * from before): they neither block the done nor go in its commit.
   */
  released: { task: string; files: string[] }[]
}

/**
 * The working tree's changes, split by ownership: the task's own; another in-progress task's of this run, or
 * a key someone else holds in jlock under the repository (parallel work in the same checkout); and nobody's.
 * The run's own folder never counts.
 */
export async function splitChanges(ctx: ToolContext, state: RunState, task: Task, withOthers = true): Promise<TreeSplit> {
  const insensitive = caseInsensitive(ctx.host.platform)
  const own = possession(task)
  const otherOwn: string[] = []
  const otherKeys: string[] = []
  if (withOthers) {
    for (const t of state.tasks.tasks) if (t.id !== task.id && t.status === "in_progress") otherOwn.push(...possession(t))
    const owner = ownerOf(state.run.id, task.id)
    for (const l of await jlockList(ctx.host, { under: state.root }))
      if (l.holder && l.holder.owner !== owner && l.holder.stale !== true) otherKeys.push(l.key)
  }
  const out: TreeSplit = { inside: [], others: [], outside: [], released: [] }
  const left = withOthers ? await releasedEdits(ctx.host, state) : new Map<string, string>()
  for (const e of await gitStatus(ctx.host, state.root)) {
    if (e.path.startsWith(`${SCRATCH}/`) || e.path === SCRATCH) continue
    let list = out.outside
    if (inPossession(e.path, own, insensitive)) list = out.inside
    else if (inPossession(e.path, otherOwn, insensitive)) list = out.others
    else {
      const key = normalizeKey(e.path, state.root, ctx.host.platform)
      const by = left.get(insensitive ? e.path.toLowerCase() : e.path)
      if (otherKeys.some((k) => covers(k, key))) list = out.others
      else if (by) {
        let group = out.released.find((g) => g.task === by)
        if (!group) out.released.push((group = { task: by, files: [] }))
        list = group.files
      }
    }
    if (!list.includes(e.path)) list.push(e.path)
  }
  return out
}

/** The task's keys that jlock no longer shows as held by its owner. */
export async function missingKeys(ctx: ToolContext, state: RunState, task: Task): Promise<string[]> {
  const keys = taskKeys(state.root, task, ctx.host.platform)
  if (!keys.length) return []
  const owner = ownerOf(state.run.id, task.id)
  const locks = await jlockList(ctx.host, { group: state.run.id })
  const held = new Set(locks.filter((l) => l.holder?.owner === owner && l.holder.stale !== true).map((l) => l.key))
  return keys.filter((k) => !held.has(k))
}

/**
 * Takes keys for a task without waiting: all at once, else one by one (a key someone else holds does not cost the
 * free ones). Answers the keys that were refused.
 */
export async function takeKeys(ctx: ToolContext, state: RunState, task: Task, keys: string[]): Promise<string[]> {
  if (!keys.length) return []
  const take = async (some: string[]) => {
    const outcome = await acquireHold(ctx, state, task, some, { noWait: true }, 5_000)
    if (outcome.answer.result !== "granted") return false
    if (outcome.resident) remember(ctx, state, task.id, outcome.resident)
    return true
  }
  if (await take(keys)) return []
  if (keys.length === 1) return keys
  const refused: string[] = []
  for (const key of keys) if (!(await take([key]))) refused.push(key)
  return refused
}

/**
 * Takes again, without waiting, the keys of a task whose hold expired, unless another task of the run took them
 * meanwhile; answers the ones still missing.
 */
export async function retakeMissing(ctx: ToolContext, state: RunState, task: Task): Promise<string[]> {
  const missing = await missingKeys(ctx, state, task)
  if (!missing.length) return []
  const taken = await takenSince(ctx.host, state.dir, task.id, missing)
  const refused = [...taken, ...(await takeKeys(ctx, state, task, missing.filter((k) => !taken.includes(k))))]
  const retaken = missing.filter((k) => !refused.includes(k))
  if (retaken.length) await log(ctx, state, { action: "retake", task: task.id, keys: retaken })
  return refused
}

function textArg(args: ParsedArgs, name: string): string | undefined {
  const v = args.options[name]
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/** Keeps `run.json`'s status in step with the tasks: `done` when nothing remains, `active` again otherwise. */
async function syncRunStatus(ctx: ToolContext, state: RunState, tasks: Task[]) {
  const run = await readRun(ctx.host, state.dir)
  if (!run || run.status === "paused") return
  const remaining = counts(tasks).remaining
  const status = remaining === 0 ? "done" : "active"
  if (run.status !== status) await writeRun(ctx.host, state.dir, { ...run, status })
}

interface Transition {
  task: Task
  tasks: TasksFile
  state: RunState
}

/**
 * One transition under the run's write lock: re-read, `change` decides (throwing to refuse) and edits the copy,
 * then tasks.json, the ticket, the log and run.json's status are written.
 */
async function transition(
  ctx: ToolContext,
  args: ParsedArgs,
  action: string,
  change: (task: Task, state: RunState) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
): Promise<Transition> {
  const first = await resolveRun(ctx, args)
  const id = taskIdArg(args)
  return withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const original = findTask(state, id)
    const copy = clone(state.tasks)
    const task = copy.tasks.find((t) => t.id === original.id)!
    const from = task.status
    const extra = (await change(task, state)) ?? {}
    const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
    await writeTicket(ctx.host, state.dir, tasks, task.id)
    await log(ctx, state, { action, task: task.id, from, to: task.status, ...extra })
    await syncRunStatus(ctx, state, tasks.tasks)
    return { task, tasks, state: { ...state, tasks } }
  })
}

function closeTask(task: Task, status: Task["status"], now: string) {
  task.status = status
  task.owner = null
  task.finishedAt = now
  delete task.holds
}

/** What a task leaving `in_progress` without a commit did with its edits (rev. 5.6). */
export interface Kept {
  /** Files whose edit is now a patch (back to HEAD in the tree). */
  saved: string[]
  /** Files left on disk: their patch could not be made. */
  left: string[]
  /** Files never touched: their key is someone else's now. */
  untouched: string[]
}

/**
 * A task leaving `in_progress` without a commit (release, agent-ended, resume, lost, fail, skip): the edits of its
 * own files are kept as patches and the files go back to HEAD, so no other task inherits them; what it had yielded
 * goes back into its ownership. Edits the copy of the task; the caller writes tasks.json.
 */
async function keepTask(ctx: ToolContext, state: RunState, task: Task): Promise<Kept> {
  const changed = await changedUnder(ctx.host, state, ownKeys(state, task, ctx.host.platform))
  const { mine, untouched } = await ownFiles(ctx.host, state, task, changed)
  const report = await keepEdits(ctx.host, state, task, mine, "release")
  takeBackEntries(task, (task.yielded ?? []).map((y) => y.key), state.root, ctx.host.platform)
  return { saved: report.saved.map((p) => p.file), left: report.kept, untouched }
}

/** The answer's tail about the edits of a task that left `in_progress`. */
function keptNote(k: Kept): string {
  const parts: string[] = []
  if (k.saved.length) parts.push(tr("changes.saved", { list: k.saved.join(", ") }))
  if (k.left.length) parts.push(tr("changes.left", { list: k.left.join(", ") }))
  if (k.untouched.length) parts.push(tr("changes.untouched", { list: k.untouched.join(", ") }))
  return parts.map((p) => `; ${p}`).join("")
}

function keptLog(k: Kept) {
  return { uncommitted: k.left, saved: k.saved, untouched: k.untouched }
}

const NOTHING_KEPT: Kept = { saved: [], left: [], untouched: [] }

async function giveBack(ctx: ToolContext, run: string, task: string): Promise<string> {
  try {
    await releaseHolds(ctx, run, task)
    return tr("release.given_back")
  } catch (error) {
    return tr("release.failed", { message: (error as Error).message, run, owner: ownerOf(run, task) })
  }
}

// ── claim ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `60s`, `2m`, `500ms`, `90` (seconds). */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim())
  if (!m) throw new ToolError(tr("duration.bad", { value: raw }), 2)
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return Math.round(unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000)
}

/** jlock's deadlock chain with our owners shortened (`gt:<run>/T04` → `T04`). */
export function chainText(chain: string, run: string): string {
  return chain.replace(/gt:([^\s/]+)\/([^\s)]+)/g, (_, r: string, t: string) => (r === run ? t : `${r}/${t}`))
}

/**
 * When the files a task asks for came back to it by themselves (the yield's queue took them back) since its last
 * yield: which, and what their reapply did, read off the run's log. Undefined otherwise.
 */
async function cameBack(ctx: ToolContext, state: RunState, task: string, files?: string[]): Promise<Retaken | undefined> {
  let found: Retaken | undefined
  for (const e of await readLog(ctx.host, state.dir)) {
    if (e.task !== task) continue
    if (e.action === "yield") found = undefined
    else if (e.action === "reclaim") {
      const back = (Array.isArray(e.files) ? e.files : []).filter((f): f is string => typeof f === "string" && (!files || files.includes(f)))
      if (!back.length) continue
      const list = (v: unknown) => (Array.isArray(v) ? v : [])
      found = {
        task,
        files: back,
        reapply: {
          applied: list((e as Record<string, unknown>).reapplied).filter((f): f is string => typeof f === "string"),
          conflicts: list((e as Record<string, unknown>).conflicts) as ReapplyReport["conflicts"],
          failed: list((e as Record<string, unknown>).failed) as ReapplyReport["failed"],
        },
      }
    }
  }
  return found
}

defineAction(
  "claim",
  async (ctx, args) => {
    const first = await resolveRun(ctx, args)
    const task = findTask(first, taskIdArg(args))
    // Without files: what the task yielded (rev. 5.6), the same queue as any claim.
    const raw = args.positionals.length > 1 ? args.positionals.slice(1) : (task.yielded ?? []).map((y) => y.path)
    if (!raw.length) {
      const back = task.status === "in_progress" ? await cameBack(ctx, first, task.id) : undefined
      if (!back) throw new ToolError(tr("claim.no_file", { id: task.id }), 2)
      return ok([tr("claim.came_back", { files: back.files.join(", ") }), ...reapplyLines(back.reapply)].join("\n"), { task: task.id, granted: [], ...reapplyData(back.reapply) })
    }
    if (task.status !== "in_progress") throw new ToolError(tr("claim.not_running", { id: task.id, status: task.status }))
    const platform = ctx.host.platform
    const files: string[] = []
    const errors: string[] = []
    for (const r of raw) {
      const entry = normalizeFileEntry(r)
      if (entry.error) errors.push(entry.error)
      else if (entry.path && !files.includes(entry.path)) files.push(entry.path)
    }
    if (errors.length) throw new ToolError(tr("claim.refused", { errors: errors.join("; ") }))
    const current = taskKeys(first.root, task, platform)
    const wanted = files.filter((f) => {
      const key = normalizeKey(f, first.root, platform)
      return !current.some((k) => covers(k, key))
    })
    if (!wanted.length) {
      const back = await cameBack(ctx, first, task.id, files)
      const text = [tr("claim.already", { id: task.id, files: files.join(", ") }), ...(back ? [tr("claim.came_back", { files: back.files.join(", ") }), ...reapplyLines(back.reapply)] : [])]
      return ok(text.join("\n"), { task: task.id, granted: [], ...(back ? reapplyData(back.reapply) : {}) })
    }
    const keys = canonical(wanted.map((f) => normalizeKey(f, first.root, platform)))
    const timeoutMs = parseDuration(typeof args.options.timeout === "string" ? args.options.timeout : "60s")
    const began = ctx.host.now().getTime()
    const outcome = await acquireHold(ctx, first, task, keys, { timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)) }, timeoutMs + 15_000)
    const waited = ((ctx.host.now().getTime() - began) / 1000).toFixed(1)
    const a = outcome.answer
    const holderOf = (h: JlockAnswer["holder"]) => (typeof h === "object" && h ? describeOwner(h.owner, first.run.id) : typeof h === "string" ? describeOwner(h, first.run.id) : "?")

    if (a.result === "timeout") {
      const key = a.failed ?? a.key ?? keys[0]!
      const via = a.via && a.via !== key ? ` (via ${describeKey(a.via, first.root, platform)})` : ""
      await log(ctx, first, { action: "claim-timeout", task: task.id, keys, waitedSec: Number(waited) })
      throw new ToolError(
        tr("claim.timeout", {
          id: task.id,
          waited,
          key: describeKey(key, first.root, platform),
          holder: holderOf(a.holder),
          via,
          position: a.position ?? "?",
          files: wanted.join(" "),
        }),
        1,
        { result: "timeout", key, holder: holderOf(a.holder), position: a.position, via: a.via },
      )
    }
    if (a.result === "deadlock") {
      await log(ctx, first, { action: "claim-deadlock", task: task.id, keys, chain: a.chain })
      throw new ToolError(
        tr("claim.deadlock", { chain: chainText(a.chain ?? "", first.run.id), id: task.id }),
        1,
        { result: "deadlock", chain: a.chain, yield: task.id },
      )
    }
    if (a.result !== "granted") throw new ToolError(tr("claim.odd", { result: a.result, id: task.id }))

    const resident = outcome.resident
    try {
      const done = await withLock(ctx.host, first.dir, async () => {
        const state = await reload(ctx, first)
        const copy = clone(state.tasks)
        const t = copy.tasks.find((x) => x.id === task.id)!
        if (t.status !== "in_progress") throw new ToolError(tr("claim.left", { id: task.id, status: t.status }))
        // What it had yielded goes back where it was; the rest joins `claimed`.
        const back = takeBackEntries(t, keys, state.root, platform)
        const more = wanted.filter((f) => !back.includes(f) && !(t.claimed ?? []).includes(f))
        if (more.length) t.claimed = [...(t.claimed ?? []), ...more]
        const hold: Hold = { keys, startedAt: ctx.host.now().toISOString(), kind: "claim" }
        if (resident?.pid !== undefined) hold.pid = resident.pid
        t.holds = [...(t.holds ?? []), hold]
        const reapply = await reapplyPatches(ctx.host, state, t, patchesUnder(state, platform, keys))
        const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, tasks, task.id)
        await log(ctx, state, { action: "claim", task: task.id, files: wanted, keys, waitedSec: Number(waited), ...reapplyData(reapply) })
        return { t, reapply }
      })
      if (resident) remember(ctx, first, task.id, resident)
      const text = [tr("claim.granted", { id: task.id, files: wanted.join(", "), waited, own: possession(done.t).join(", ") }), ...reapplyLines(done.reapply)]
      return ok(text.join("\n"), {
        task: task.id,
        granted: wanted,
        keys,
        waitedSec: Number(waited),
        ...reapplyData(done.reapply),
      })
    } catch (error) {
      await releaseHoldsOf(ctx, first.run.id, task.id, resident, keys).catch(() => {})
      throw error
    }
  },
  "help.claim",
)

// ── yield (rev. 5.6) ──────────────────────────────────────────────────────────────────────────────────────────

/** Puts the yielded entries `keys` cover back in the task's ownership, in the lists they came from; answers them. */
function takeBackEntries(task: Task, keys: string[], root: string, platform: string): string[] {
  const back: string[] = []
  const left: Yielded[] = []
  for (const y of task.yielded ?? []) {
    if (!keys.some((k) => covers(k, normalizeKey(y.path, root, platform)))) {
      left.push(y)
      continue
    }
    const list = y.from === "files" ? task.files : (task.claimed ??= [])
    if (!list.includes(y.path)) list.push(y.path)
    back.push(y.path)
  }
  if (left.length) task.yielded = left
  else delete task.yielded
  return back
}

/** What a reapply did, as lines of an answer. */
export function reapplyLines(r: ReapplyReport): string[] {
  const lines: string[] = []
  if (r.applied.length) lines.push(tr("patch.reapplied", { files: r.applied.join(", ") }))
  if (r.conflicts.length) lines.push(tr("patch.conflicts", { list: r.conflicts.map((c) => `${c.file} (${c.patch})`).join(", ") }))
  if (r.failed.length) lines.push(tr("patch.failed", { list: r.failed.map((c) => `${c.file} (${c.patch})`).join(", ") }))
  return lines
}

function reapplyData(r: ReapplyReport) {
  return { reapplied: r.applied, conflicts: r.conflicts, failed: r.failed.map((f) => ({ file: f.file, patch: f.patch })) }
}

export interface Retaken {
  task: string
  files: string[]
  reapply: ReapplyReport
}

/**
 * The queue a `yield` waits in: the keys the run's tasks in progress yielded are taken back without waiting where
 * they are free now, with their patches reapplied. Runs after another task gives keys back (done, release, skip,
 * fail), on `next`, and on each pass of a host that stays open (`only` limits it to that host's tasks). Never throws.
 */
export async function retakeYielded(ctx: ToolContext, first: RunState, only?: (task: Task) => boolean): Promise<Retaken[]> {
  const out: Retaken[] = []
  const platform = ctx.host.platform
  let state0: RunState
  try {
    state0 = await reload(ctx, first)
  } catch {
    return out
  }
  for (const task of state0.tasks.tasks) {
    if (task.status !== "in_progress" || !task.yielded?.length || (only && !only(task))) continue
    try {
      const keys = canonical(task.yielded.map((y) => y.key))
      const refused = await takeKeys(ctx, state0, task, keys)
      const granted = keys.filter((k) => !refused.includes(k))
      if (!granted.length) continue
      const back = await withLock(ctx.host, first.dir, async () => {
        const state = await reload(ctx, first)
        const copy = clone(state.tasks)
        const t = copy.tasks.find((x) => x.id === task.id)
        if (!t || t.status !== "in_progress") return undefined
        const files = takeBackEntries(t, granted, state.root, platform)
        t.holds = [...(t.holds ?? []), { keys: granted, startedAt: ctx.host.now().toISOString(), kind: "claim" }]
        const reapply = await reapplyPatches(ctx.host, state, t, patchesUnder(state, platform, granted))
        const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, tasks, t.id)
        await log(ctx, state, { action: "reclaim", task: t.id, keys: granted, files, ...reapplyData(reapply) })
        return { task: t.id, files, reapply }
      })
      if (back) out.push(back)
      else await jlockReleaseKeys(ctx.host, granted, ownerOf(state0.run.id, task.id)).catch(() => {})
    } catch {
      // Left for the next pass.
    }
  }
  return out
}

/** One line per task that took back what it had yielded. */
function retakenLines(list: Retaken[]): string[] {
  return list.map((r) => [tr("yield.came_back", { id: r.task, files: r.files.join(", ") }), ...reapplyLines(r.reapply)].join("; "))
}

defineAction(
  "yield",
  async (ctx, args) => {
    const first = await resolveRun(ctx, args)
    const task = findTask(first, taskIdArg(args))
    if (task.status !== "in_progress") throw new ToolError(tr("yield.not_running", { id: task.id, status: task.status }))
    if (task.exclusive) throw new ToolError(tr("yield.exclusive", { id: task.id }))
    const platform = ctx.host.platform
    const owner = ownerOf(first.run.id, task.id)
    const current = taskKeys(first.root, task, platform)
    const keys: string[] = []
    const raw = args.positionals.slice(1)
    if (raw.length) {
      for (const r of raw) {
        const entry = normalizeFileEntry(r)
        if (entry.error) throw new ToolError(tr("yield.refused", { errors: entry.error }))
        const key = normalizeKey(entry.path!, first.root, platform)
        const outer = current.find((k) => covers(k, key))
        if (!outer) throw new ToolError(tr("yield.not_owned", { id: task.id, file: r }))
        if (outer !== key) throw new ToolError(tr("yield.inside", { id: task.id, file: r, folder: describeKey(outer, first.root, platform) }))
        keys.push(key)
      }
    } else {
      // Without files: the keys of the task that close the cycle of its last claim refused for a deadlock.
      const chain = await lastDeadlock(ctx.host, first.dir, task.id)
      keys.push(...(chain ? chainKeys(chain, owner) : []).filter((k) => current.includes(k)))
      if (!keys.length) throw new ToolError(tr("yield.nothing", { id: task.id }), 2)
    }
    const wanted = canonical(keys)
    const done = await withLock(ctx.host, first.dir, async () => {
      const state = await reload(ctx, first)
      const copy = clone(state.tasks)
      const t = copy.tasks.find((x) => x.id === task.id)!
      if (t.status !== "in_progress") throw new ToolError(tr("yield.not_running", { id: t.id, status: t.status }))
      const changed = await changedUnder(ctx.host, state, wanted)
      const { mine, untouched } = await ownFiles(ctx.host, state, t, changed)
      const report = await keepEdits(ctx.host, state, t, mine, "yield")
      // A key whose edits could not be kept aside is not given back: the task that takes it would commit them.
      const given = wanted.filter((k) => !report.kept.some((f) => covers(k, normalizeKey(f, state.root, platform))))
      const at = ctx.host.now().toISOString()
      const yielded: Yielded[] = []
      for (const from of ["files", "claimed"] as const) {
        const stay: string[] = []
        for (const e of from === "files" ? t.files : (t.claimed ?? [])) {
          const key = given.find((g) => covers(g, normalizeKey(e, state.root, platform)))
          if (key) yielded.push({ path: e, from, key, at })
          else stay.push(e)
        }
        if (from === "files") t.files = stay
        else if (stay.length) t.claimed = stay
        else delete t.claimed
      }
      if (yielded.length) t.yielded = [...(t.yielded ?? []), ...yielded]
      if (t.holds) t.holds = t.holds.map((h) => ({ ...h, keys: h.keys.filter((k) => !given.includes(k)) })).filter((h) => h.keys.length)
      const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
      await writeTicket(ctx.host, state.dir, tasks, t.id)
      await log(ctx, state, { action: "yield", task: t.id, keys: given, files: yielded.map((y) => y.path), saved: report.saved.map((p) => p.file), untouched, kept: report.kept })
      return { given, yielded, report, untouched }
    })
    if (done.given.length) await jlockReleaseKeys(ctx.host, done.given, owner)
    const files = done.yielded.map((y) => y.path)
    const lines: string[] = []
    if (files.length) {
      const saved = done.report.saved.length
        ? tr("yield.saved", { list: done.report.saved.map((p) => `${p.file} → ${join(first.dir, p.patch)}`).join(", ") })
        : tr("yield.no_edits")
      lines.push(tr("yield.done", { id: task.id, files: files.join(", "), saved }), tr("yield.hint", { id: task.id }))
    }
    if (done.untouched.length) lines.push(tr("yield.untouched", { files: done.untouched.join(", ") }))
    if (done.report.kept.length) lines.push(tr("yield.kept", { files: done.report.kept.join(", ") }))
    return {
      ok: files.length > 0,
      code: files.length > 0 ? 0 : 1,
      text: lines.join("\n"),
      data: {
        run: first.run.id,
        task: task.id,
        yielded: files,
        keys: done.given,
        saved: done.report.saved.map((p) => ({ file: p.file, patch: join(first.dir, p.patch) })),
        untouched: done.untouched,
        kept: done.report.kept,
      },
    }
  },
  "help.yield",
)

// ── done ──────────────────────────────────────────────────────────────────────────────────────────────────────

defineAction(
  "done",
  async (ctx, args) => {
    const evidence = textArg(args, "evidence")
    let commit: string | null = null
    let claimed: string[] = []
    let leftByOthers: TreeSplit["released"] = []
    const t = await transition(ctx, args, "done", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(tr("task.not_running", { id: task.id, status: task.status }))
      if (!evidence) throw new ToolError(tr("done.no_evidence", { id: task.id }), 2)
      const branch = await currentBranch(ctx.host, state.root)
      if (branch !== state.run.repo.branch)
        throw new ToolError(tr("done.wrong_branch", { branch: branch ?? tr("done.detached"), run_branch: state.run.repo.branch }))
      const split = await splitChanges(ctx, state, task)
      leftByOthers = split.released
      if (split.outside.length)
        throw new ToolError(
          tr("done.outside", { id: task.id, files: split.outside.join(", ") }),
          1,
          { outside: split.outside },
        )
      // A hold that expired (the run's holdTtl) while nobody else took its keys is taken back, not refused.
      const missing = await retakeMissing(ctx, state, task)
      if (missing.length)
        throw new ToolError(
          tr("done.lost", { keys: missing.map((k) => describeKey(k, state.root, ctx.host.platform)).join(", "), id: task.id }),
          1,
          { missing },
        )
      if (split.inside.length) {
        await gitOk(ctx.host, state.root, ["add", "-A", "--", ...split.inside])
        await gitOk(ctx.host, state.root, ["commit", "-q", "-m", `${task.id}: ${task.title}`])
        commit = await shortHead(ctx.host, state.root)
        await recordEffect(ctx.host, state.dir, {
          run: state.run.id,
          task: task.id,
          type: "commit",
          repo: state.root,
          ref: commit,
          branch: state.run.repo.branch,
          undo: { kind: "git-revert", ref: commit },
        })
      }
      claimed = task.claimed ?? []
      closeTask(task, "done", ctx.host.now().toISOString())
      task.commit = commit
      task.evidence = evidence
      for (const a of task.acceptance) a.done = true
      return { evidence, commit }
    })
    const released = await giveBack(ctx, t.state.run.id, t.task.id)
    const what = commit ? `commit ${commit} (${t.task.id}: ${t.task.title})` : tr("done.no_commit")
    const lines = [tr("done.done", { id: t.task.id, what, released }), progressLine(t.tasks.tasks)]
    if (claimed.length) lines.push(tr("done.claimed", { files: claimed.join(", ") }))
    for (const g of leftByOthers) lines.push(tr("done.released_edits", { id: g.task, files: g.files.join(", ") }))
    lines.push(...retakenLines(await retakeYielded(ctx, t.state)))
    return ok(lines.join("\n"), { run: t.state.run.id, task: t.task.id, commit, counts: counts(t.tasks.tasks), claimed, releasedEdits: leftByOthers })
  },
  "help.done",
)

// ── skip / fail / release / retry ─────────────────────────────────────────────────────────────────────────────

defineAction(
  "skip",
  async (ctx, args) => {
    const reason = textArg(args, "reason")
    let wasRunning = false
    let kept = NOTHING_KEPT
    const t = await transition(ctx, args, "skip", async (task, state) => {
      if (!["pending", "in_progress", "failed"].includes(task.status)) throw new ToolError(tr("skip.cannot", { id: task.id, status: task.status }))
      if (!reason) throw new ToolError(tr("skip.no_reason", { id: task.id }), 2)
      wasRunning = task.status === "in_progress"
      if (wasRunning) kept = await keepTask(ctx, state, task)
      closeTask(task, "skipped", ctx.host.now().toISOString())
      task.reason = reason
      return { reason, ...keptLog(kept) }
    })
    const released = wasRunning ? `; ${await giveBack(ctx, t.state.run.id, t.task.id)}` : ""
    const back = wasRunning ? retakenLines(await retakeYielded(ctx, t.state)) : []
    return ok([`${tr("skip.done", { id: t.task.id, reason: reason! })}${released}${keptNote(kept)}`, progressLine(t.tasks.tasks), ...back].join("\n"), {
      run: t.state.run.id,
      task: t.task.id,
      ...keptLog(kept),
    })
  },
  "help.skip",
)

defineAction(
  "fail",
  async (ctx, args) => {
    const error = textArg(args, "error")
    let kept = NOTHING_KEPT
    const t = await transition(ctx, args, "fail", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(tr("task.not_running", { id: task.id, status: task.status }))
      if (!error) throw new ToolError(tr("fail.no_error", { id: task.id }), 2)
      kept = await keepTask(ctx, state, task)
      closeTask(task, "failed", ctx.host.now().toISOString())
      task.error = error
      return { error, ...keptLog(kept) }
    })
    const released = await giveBack(ctx, t.state.run.id, t.task.id)
    const back = retakenLines(await retakeYielded(ctx, t.state))
    return ok([`${tr("fail.done", { id: t.task.id, error: error! })}; ${released}${keptNote(kept)}`, progressLine(t.tasks.tasks), ...back].join("\n"), {
      run: t.state.run.id,
      task: t.task.id,
      ...keptLog(kept),
    })
  },
  "help.fail",
)

/** In progress → pending (or failed at maxAttempts). Used by release, resume, lost (their edits: `keepTask`). */
export function backToPending(task: Task, maxAttempts: number, why: string, now: string): "pending" | "failed" {
  task.owner = null
  delete task.holds
  if (task.attempts >= maxAttempts) {
    task.status = "failed"
    task.error = tr("attempts.exhausted", { why, attempts: task.attempts, max: maxAttempts })
    task.finishedAt = now
    return "failed"
  }
  task.status = "pending"
  delete task.startedAt
  return "pending"
}

defineAction(
  "release",
  async (ctx, args) => {
    let kept = NOTHING_KEPT
    let to: string = "pending"
    // --agent-ended: the host saw the subagent's loop end with its task still in progress (logged as such).
    const ended = !!args.options["agent-ended"]
    const t = await transition(ctx, args, ended ? "agent-ended" : "release", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(tr("task.not_running", { id: task.id, status: task.status }))
      kept = await keepTask(ctx, state, task)
      to = backToPending(task, state.run.maxAttempts, tr(ended ? "release.agent_ended" : "release.released"), ctx.host.now().toISOString())
      return keptLog(kept)
    })
    const released = await giveBack(ctx, t.state.run.id, t.task.id)
    const where = to === "failed" ? tr("release.failed_now", { error: t.task.error ?? "" }) : tr("release.pending", { attempts: t.task.attempts, max: t.state.run.maxAttempts })
    const back = retakenLines(await retakeYielded(ctx, t.state))
    return ok([`${t.task.id} ${where}; ${released}${keptNote(kept)}`, progressLine(t.tasks.tasks), ...back].join("\n"), {
      run: t.state.run.id,
      task: t.task.id,
      status: t.task.status,
      ...keptLog(kept),
    })
  },
  "help.release",
)

function reopen(task: Task) {
  if (task.status !== "skipped" && task.status !== "failed") throw new ToolError(tr("retry.cannot", { id: task.id, status: task.status }))
  task.status = "pending"
  delete task.reason
  delete task.error
  delete task.finishedAt
  delete task.startedAt
  task.owner = null
}

defineAction(
  "retry",
  async (ctx, args) => {
    if (args.options["all-failed"]) {
      const first = await resolveRun(ctx, args)
      const reopened = await withLock(ctx.host, first.dir, async () => {
        const state = await reload(ctx, first)
        const copy = clone(state.tasks)
        const ids: string[] = []
        for (const task of copy.tasks)
          if (task.status === "failed") {
            reopen(task)
            task.attempts = 0
            ids.push(task.id)
          }
        if (!ids.length) return { ids, tasks: state.tasks }
        const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
        for (const id of ids) {
          await writeTicket(ctx.host, state.dir, tasks, id)
          await log(ctx, state, { action: "retry", task: id, from: "failed", to: "pending" })
        }
        await syncRunStatus(ctx, state, tasks.tasks)
        return { ids, tasks }
      })
      const text = reopened.ids.length ? tr("retry.reopened", { list: reopened.ids.join(", ") }) : tr("retry.none")
      return ok(`${text}\n${progressLine(reopened.tasks.tasks)}`, { reopened: reopened.ids })
    }
    const t = await transition(ctx, args, "retry", (task) => {
      reopen(task)
      task.attempts = 0
    })
    return ok(`${tr("retry.done", { id: t.task.id })}\n${progressLine(t.tasks.tasks)}`, { run: t.state.run.id, task: t.task.id })
  },
  "help.retry",
)

// ── pause / unpause / resume ──────────────────────────────────────────────────────────────────────────────────

async function setPaused(ctx: ToolContext, args: ParsedArgs, paused: boolean) {
  const first = await resolveRun(ctx, args)
  return withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const from = state.run.status
    const status = paused ? "paused" : counts(state.tasks.tasks).remaining === 0 ? "done" : "active"
    const run: RunFile = { ...state.run, status }
    // A pause by hand over a transient one: the host no longer resumes it by itself (the tasks stay kept).
    if (paused && run.pause?.resumeAt) {
      const { resumeAt: _gone, ...pause } = run.pause
      run.pause = pause
    }
    if (JSON.stringify(run) !== JSON.stringify(state.run)) await writeRun(ctx.host, state.dir, run)
    // Really unpaused (it was paused), the keepalive counts again from zero; an unpause of a run that was not
    // paused changes nothing, so it cannot reset the count.
    if (!paused && from === "paused") await clearKeepalive(ctx.host, state.dir)
    await log(ctx, state, { action: paused ? "pause" : "unpause", from, to: status })
    return { ...state, run }
  })
}

/** What leaving a transient pause did: the text for the orchestrator and the keys others took meanwhile. */
export interface LeftPause {
  state: RunState
  /** English, for the model: which tasks are still in progress and which agent to resume for each. */
  text: string
  kept: string[]
  lost: Record<string, string[]>
}

/**
 * Leaves a pause made by a transient failure (rev. 5.7): the run is active again, the tasks kept in progress take
 * back whatever lock expired meanwhile (renewal stops with the host), and the orchestrator is told to resume the same
 * agents. `due`: only when the pause's `resumeAt` has come (the host's clock); `auto`: counted in `pauseStreak`.
 * Undefined when the run is not in such a pause (or it is not due yet).
 */
export async function leavePause(ctx: ToolContext, first: RunState, opts: { due?: Date; auto?: boolean; how?: string } = {}): Promise<LeftPause | undefined> {
  return withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const pause = state.run.pause
    if (state.run.status !== "paused" || !pause) return undefined
    if (opts.due && (!pause.resumeAt || Date.parse(pause.resumeAt) > opts.due.getTime())) return undefined
    const run: RunFile = { ...state.run, status: counts(state.tasks.tasks).remaining === 0 ? "done" : "active" }
    delete run.pause
    const signature = progressSignature(state.tasks)
    if (opts.auto) run.pauseStreak = { signature, n: state.run.pauseStreak?.signature === signature ? state.run.pauseStreak.n + 1 : 1 }
    else delete run.pauseStreak
    await writeRun(ctx.host, state.dir, run)
    await clearKeepalive(ctx.host, state.dir)
    const next = { ...state, run }
    const inProgress = state.tasks.tasks.filter((t) => t.status === "in_progress")
    const lost: Record<string, string[]> = {}
    for (const t of inProgress) {
      const refused = await retakeMissing(ctx, next, t).catch(() => [] as string[])
      if (refused.length) lost[t.id] = refused.map((k) => describeKey(k, state.root, ctx.host.platform))
    }
    const how = opts.how ?? (opts.auto ? "due" : "unpause")
    await log(ctx, state, { action: opts.auto ? "auto-resume" : "unpause", how, kind: pause.kind, kept: inProgress.map((t) => t.id), ...(Object.keys(lost).length ? { lost } : {}) })
    return { state: next, text: resumeText(run, pause, inProgress, ctx.tool, lost), kept: inProgress.map((t) => t.id), lost }
  })
}

defineAction(
  "pause",
  async (ctx, args) => {
    const state = await setPaused(ctx, args, true)
    const running = state.tasks.tasks.filter((t) => t.status === "in_progress").map((t) => t.id)
    const tail = running.length ? `; ${tr("pause.running", { list: running.join(", ") })}` : ""
    return ok(`${tr("pause.done", { run: state.run.id })}${tail}`, { run: state.run.id, status: "paused" })
  },
  "help.pause",
)

defineAction("unpause", async (ctx, args) => {
  const first = await resolveRun(ctx, args)
  // A transient pause: the tasks kept in progress take their locks back, and the answer says which agent to resume.
  const left = await leavePause(ctx, first)
  if (left) {
    const s = left.state
    const lines = [tr("unpause.done", { run: s.run.id, status: s.run.status }), progressLine(s.tasks.tasks)]
    if (left.kept.length) lines.push(tr("unpause.kept", { list: left.kept.join(", ") }), left.text)
    return ok(lines.join("\n"), { run: s.run.id, status: s.run.status, kept: left.kept, lost: left.lost, resume: left.text })
  }
  const state = await setPaused(ctx, args, false)
  return ok(`${tr("unpause.done", { run: state.run.id, status: state.run.status })}\n${progressLine(state.tasks.tasks)}`, { run: state.run.id, status: state.run.status })
})

defineAction(
  "resume",
  async (ctx, args) => {
    const wanted = args.positionals[0] ?? (typeof args.options.run === "string" ? args.options.run : undefined)
    let back: string | undefined
    if (args.options["from-archive"]) {
      if (!wanted) throw new ToolError(tr("resume.which"), 2)
      back = await unarchive(ctx, wanted)
    }
    const first = await resolveRun(ctx, { ...args, options: { ...args.options, ...(wanted ? { run: wanted } : {}) } })
    const keepOwners = !!args.options["keep-owners"]
    const released: { id: string; to: string; uncommitted: string[]; kept: Kept }[] = []
    const kept: string[] = []
    const state = await withLock(ctx.host, first.dir, async () => {
      const state = await reload(ctx, first)
      const now = ctx.host.now().toISOString()
      const run = { ...state.run }
      if (run.status === "paused") run.status = counts(state.tasks.tasks).remaining === 0 ? "done" : "active"
      // A transient pause (rev. 5.7) kept its tasks in progress: their expired locks are taken back, not released.
      const transient = state.run.status === "paused" && !!state.run.pause
      delete run.pause
      if (ctx.session && !run.sessions.some((s) => s.tool === ctx.tool && s.id === ctx.session))
        run.sessions = [...run.sessions, { tool: ctx.tool, id: ctx.session, boundAt: now }]
      const copy = clone(state.tasks)
      for (const task of copy.tasks) {
        if (task.status !== "in_progress") continue
        const keys = taskKeys(state.root, task, ctx.host.platform)
        const missing = keys.length ? await missingKeys(ctx, state, task) : []
        if (keepOwners || !keys.length || missing.length === 0) {
          kept.push(task.id)
          continue
        }
        if (transient && (await retakeMissing(ctx, state, task).catch(() => missing)).length === 0) {
          kept.push(task.id)
          continue
        }
        const edits = await keepTask(ctx, state, task)
        const to = backToPending(task, run.maxAttempts, tr("resume.no_locks_reason"), now)
        released.push({ id: task.id, to, uncommitted: edits.left, kept: edits })
      }
      const tasks = released.length ? await writeTasks(ctx.host, state.dir, copy, state.tasks.revision) : state.tasks
      if (JSON.stringify(run) !== JSON.stringify(state.run)) await writeRun(ctx.host, state.dir, run)
      for (const r of released) {
        await writeTicket(ctx.host, state.dir, tasks, r.id)
        await log(ctx, state, { action: "resume-release", task: r.id, from: "in_progress", to: r.to, ...keptLog(r.kept) })
      }
      await log(ctx, state, { action: "resume", released: released.map((r) => r.id), kept })
      // Only a resume that leaves a pause starts the count over (released tasks are progress anyway).
      if (state.run.status === "paused") await clearKeepalive(ctx.host, state.dir)
      return { ...state, run, tasks }
    })
    // Whatever is left of a released task's locks (a stale holder) goes back too.
    for (const r of released) await jlockRelease(ctx.host, state.run.id, ownerOf(state.run.id, r.id)).catch(() => {})
    const lines = [...(back ? [back] : []), tr("resume.bound", { run: state.run.id })]
    for (const r of released)
      lines.push(`${tr("resume.released", { id: r.id, to: r.to })}${keptNote(r.kept)}`)
    if (kept.length) lines.push(tr(keepOwners ? "resume.kept_flag" : "resume.kept_live", { list: kept.join(", ") }))
    const s = await statusOf(ctx, state)
    lines.push(s.text)
    const releasedData = released.map((r) => ({ id: r.id, to: r.to, ...keptLog(r.kept) }))
    return ok(lines.join("\n"), { ...s.data, released: releasedData, kept }, { bind: state.run.id })
  },
  "help.resume",
)

// ── keepalive ─────────────────────────────────────────────────────────────────────────────────────────────────

defineAction(
  "keepalive",
  async (ctx, args) => {
    const wanted = args.positionals[0]
    if (wanted !== "on" && wanted !== "off") throw new ToolError(tr("keepalive.usage"), 2)
    const on = wanted === "on"
    const first = await resolveRun(ctx, args)
    const state = await withLock(ctx.host, first.dir, async () => {
      const state = await reload(ctx, first)
      const from = state.run.keepalive !== false
      const run = { ...state.run, keepalive: on }
      if (from !== on || state.run.keepalive === undefined) await writeRun(ctx.host, state.dir, run)
      // On again: a give-up (or a hold) is forgotten, so the run is watched again; from off, everything is.
      if (on && !from) await clearKeepalive(ctx.host, state.dir)
      else if (on) await rearmKeepalive(ctx.host, state.dir)
      await log(ctx, state, { action: "keepalive", from: from ? "on" : "off", to: wanted })
      return { ...state, run }
    })
    return ok(tr(on ? "keepalive.on" : "keepalive.off", { run: state.run.id }), { run: state.run.id, keepalive: on })
  },
  "help.keepalive",
)

// ── exec (serialize) ──────────────────────────────────────────────────────────────────────────────────────────

/** The `serialize` entry a command line falls under: the same command, or one with more arguments. */
export function serializeEntry(serialize: string[], command: string): string | undefined {
  const norm = command.trim().replace(/\s+/g, " ")
  return serialize.find((e) => {
    const entry = e.trim().replace(/\s+/g, " ")
    return norm === entry || norm.startsWith(`${entry} `)
  })
}

export function serializeKey(root: string, entry: string): string {
  const repo = root.replace(/[\/]+$/, "").split(/[\/]/).pop() ?? "repo"
  return `name:gt/${slugify(repo, 40)}/${slugify(entry, 60)}`
}

defineAction(
  "exec",
  async (ctx, args) => {
    const argv = args.positionals
    if (!argv.length) throw new ToolError(tr("exec.no_command"), 2)
    const state = await resolveRun(ctx, args).catch(() => undefined)
    const root = state?.root ?? (await requireRepo(ctx.host, ctx.cwd))
    const command = argv.join(" ")
    const entry = state ? serializeEntry(state.run.serialize, command) : undefined
    const full = entry
      ? [
          jlockBin(ctx.host),
          "run",
          serializeKey(root, entry),
          "--owner",
          // One owner per exec: two with the same owner would both be granted at once.
          `gt:${state!.run.id}/exec-${ctx.host.now().getTime().toString(36)}${Math.floor(ctx.host.random() * 46656).toString(36)}`,
          "--group",
          state!.run.id,
          "--intent",
          command,
          "--json",
          "--",
          ...argv,
        ]
      : [...argv]
    const r = await ctx.host.run(full, { cwd: ctx.cwd, timeoutMs: 10 * 60_000, env: jlockEnv() })
    const how = entry ? tr("exec.serialized", { key: serializeKey(root, entry) }) : tr("exec.direct")
    const output = `${r.stdout}${r.stderr}`.replace(/\s+$/, "")
    return { ok: r.code === 0, code: r.code, text: `${output}${output ? "\n" : ""}[${tr("exec.exit", { how, code: r.code })}]`, data: { code: r.code, serialized: !!entry } }
  },
  "help.exec",
)

// ── ledger / undo / effects ───────────────────────────────────────────────────────────────────────────────────

defineAction(
  "ledger",
  async (ctx, args) => {
    const insensitive = caseInsensitive(ctx.host.platform)
    if (args.options["all-projects"]) {
      const all = await readEffects(ctx.host, globalLedger(ctx.host))
      const active = all.filter((e) => e.state === "active").length
      const lines = [tr("ledger.global", { file: globalLedger(ctx.host), n: all.length, active })]
      for (const repo of [...new Set(all.map((e) => e.repo))]) {
        lines.push(`${repo}:`)
        for (const e of all.filter((x) => x.repo === repo)) lines.push(`  ${effectLine(e)}`)
      }
      return ok(lines.join("\n"), { effects: all })
    }
    const root = await requireRepo(ctx.host, ctx.cwd)
    const run = typeof args.options.run === "string" ? args.options.run : ctx.boundRun
    const effects = await effectsOf(ctx.host, { repo: root, run }, insensitive)
    const active = effects.filter((e) => e.state === "active").length
    const scope = run ? tr("ledger.of_run", { run }) : tr("ledger.of_repo", { root })
    const lines = [tr("ledger.header", { scope, n: effects.length, active }), ...effects.map(effectLine)]
    return ok(lines.join("\n"), { effects })
  },
  "help.ledger",
)

function dirtyFiles(entries: { path: string }[]): string[] {
  return entries.map((e) => e.path).filter((p) => !p.startsWith(`${SCRATCH}/`) && p !== SCRATCH)
}

/** Undoes one effect (or refuses with a ToolError, changing nothing). Returns what was done. */
async function undoEffect(ctx: ToolContext, root: string, e: Effect, force: boolean): Promise<string> {
  const { host } = ctx
  const dir = runDir(root, e.run)
  switch (e.undo.kind) {
    case "git-revert": {
      const ref = e.undo.ref ?? e.ref!
      const dirty = dirtyFiles(await gitStatus(host, root))
      if (dirty.length) throw new ToolError(tr("undo.dirty", { id: e.id, files: dirty.join(", ") }))
      if (!(await commitExists(host, root, ref))) throw new ToolError(tr("undo.no_commit", { id: e.id, ref }))
      const r = await git(host, root, ["revert", "--no-edit", ref])
      if (r.code !== 0) {
        await git(host, root, ["revert", "--abort"])
        throw new ToolError(tr("undo.revert_failed", { id: e.id, ref, message: (r.stderr || r.stdout).trim() }))
      }
      const head = await shortHead(host, root)
      const branch = (await currentBranch(host, root)) ?? "HEAD"
      const effect: NewEffect = { run: e.run, type: "commit", repo: root, ref: head, branch, undo: { kind: "git-revert", ref: head }, reverts: e.id }
      if (e.task) effect.task = e.task
      await recordEffect(host, dir, effect)
      return tr("undo.reverted", { id: e.id, ref, head })
    }
    case "git-branch-delete": {
      const branch = e.ref!
      if (!(await branchExists(host, root, branch))) return tr("undo.no_branch", { id: e.id, branch })
      const base = e.from ?? "main"
      if (!force && !(await isMerged(host, root, branch, base)))
        throw new ToolError(tr("undo.unmerged", { id: e.id, branch, base }))
      if ((await currentBranch(host, root)) === branch) {
        const dirty = dirtyFiles(await gitStatus(host, root))
        if (dirty.length) throw new ToolError(tr("undo.branch_dirty", { id: e.id, branch, files: dirty.join(", ") }))
        await gitOk(host, root, ["switch", "-q", base])
      }
      await gitOk(host, root, ["branch", "-D", branch])
      return tr("undo.branch_removed", { id: e.id, branch, base })
    }
    case "remove-line": {
      const others = (await host.list(runsDir(root))).filter((d) => d.kind === "dir" && d.name !== e.run)
      if (others.length && !force)
        throw new ToolError(tr("undo.exclude_shared", { id: e.id, line: e.line ?? "", runs: others.map((d) => d.name).join(", ") }))
      const removed = await removeExcludeLine(host, root, e.line ?? ".scratch/")
      return tr(removed ? "undo.line_removed" : "undo.line_absent", { id: e.id, path: e.path ?? "" })
    }
    case "rmdir": {
      const target = e.path ?? dir
      const tasks = await readTasks(host, target).catch(() => undefined)
      const running = tasks?.tasks.filter((t) => t.status === "in_progress").map((t) => t.id) ?? []
      if (running.length) throw new ToolError(tr("undo.run_busy", { id: e.id, tasks: running.join(", ") }))
      await host.remove(target, { recursive: true })
      return tr("undo.dir_removed", { id: e.id, dir: target })
    }
    case "remove-file": {
      // A saved patch (rev. 5.6): wherever it is now, saved or applied.
      for (const f of e.patch ? [e.patch, appliedPath(e.patch)] : []) await host.remove(f).catch(() => {})
      return tr("undo.patch_removed", { id: e.id, patch: e.patch ?? "" })
    }
    case "apply-patch": {
      // A file put back to HEAD: its edit comes back from the patch, never over another task's work.
      const patch = await patchFile(host, e)
      const file = e.path ?? ""
      const tasks = await readTasks(host, dir).catch(() => undefined)
      const other = tasks?.tasks.find((t) => t.status === "in_progress" && t.id !== e.task && inPossession(file, possession(t), caseInsensitive(host.platform)))
      if (other && !force) throw new ToolError(tr("undo.patch_owned", { id: e.id, file, task: other.id }))
      if ((await gitStatus(host, root)).some((x) => x.path === file)) throw new ToolError(tr("undo.patch_dirty", { id: e.id, file }))
      const r = await applyPatch(host, root, patch, [file])
      if (r.result === "failed") throw new ToolError(tr("undo.patch_failed", { id: e.id, file, message: r.message }))
      return tr(r.result === "conflict" ? "undo.patch_conflict" : "undo.patch_applied", { id: e.id, file, patch })
    }
    case "reverse-patch": {
      const patch = await patchFile(host, e)
      if (!(await reversePatch(host, root, patch))) throw new ToolError(tr("undo.reverse_failed", { id: e.id, file: e.path ?? "", patch }))
      return tr("undo.patch_reversed", { id: e.id, file: e.path ?? "" })
    }
    default:
      throw new ToolError(tr("undo.none", { id: e.id, type: e.type, kind: e.undo.kind }))
  }
}

/** The patch file of an effect, where it is now (saved, or moved to `applied/`). */
async function patchFile(host: ToolContext["host"], e: Effect): Promise<string> {
  for (const f of e.patch ? [e.patch, appliedPath(e.patch)] : []) if (await host.stat(f)) return f
  throw new ToolError(tr("undo.no_patch", { id: e.id, patch: e.patch ?? "" }))
}

/** Undoes effects newest first; stops at the first refusal, saying what was already undone. */
async function undoMany(ctx: ToolContext, root: string, effects: Effect[], force: boolean) {
  const done: string[] = []
  for (const e of [...effects].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    try {
      done.push(await undoEffect(ctx, root, e, force))
    } catch (error) {
      if (error instanceof ToolError && done.length)
        throw new ToolError(`${done.join("\n")}\n${tr("undo.stopped", { message: error.message })}`, error.code, { undone: done })
      throw error
    }
    await setEffectState(ctx.host, runDir(root, e.run), e.run, e.id, "undone")
  }
  return done
}

/** A global effect (`g-…`, an install by `doctor --fix`): removes the file it installed (and its folder, when empty). */
async function undoGlobal(ctx: ToolContext, id: string): Promise<ToolResult> {
  const { host } = ctx
  const e = (await readEffects(host, globalLedger(host))).find((x) => x.id === id && x.state === "active")
  if (!e) throw new ToolError(tr("undo.no_global", { id }))
  if (e.undo.kind !== "remove-file" || !e.path) throw new ToolError(tr("undo.none", { id: e.id, type: e.type, kind: e.undo.kind }))
  await host.remove(e.path)
  const parent = dirname(e.path)
  if (!(await host.list(parent)).length) await host.remove(parent, { recursive: true }).catch(() => {})
  await setEffectState(host, jtasksHome(host), e.run, e.id, "undone")
  return ok(tr("undo.file_removed", { id: e.id, file: e.path }), { undone: [e.id] })
}

defineAction(
  "undo",
  async (ctx, args) => {
    const force = !!args.options.force
    const id = args.positionals[0]
    if (id?.startsWith("g-")) return undoGlobal(ctx, id)
    const taskId = typeof args.options.task === "string" ? args.options.task : undefined
    const insensitive = caseInsensitive(ctx.host.platform)
    if (!id && !taskId) {
      const runId = typeof args.options.run === "string" ? args.options.run : undefined
      if (!runId) throw new ToolError(tr("undo.which"), 2)
      const root = await requireRepo(ctx.host, ctx.cwd)
      // Moving an edit between the tree and a patch is undone one by one only (undo <e-id>).
      const effects = (await effectsOf(ctx.host, { repo: root, run: runId }, insensitive)).filter((e) => e.state === "active" && !PATCH_MOVES.includes(e.type))
      if (!effects.length) return ok(tr("undo.run_clean", { run: runId }), { undone: [] })
      const done = await undoMany(ctx, root, effects, force)
      return ok(`${tr("undo.run_done", { run: runId })}\n${done.join("\n")}`, { undone: done })
    }
    const state = await resolveRun(ctx, args)
    const all = (await effectsOf(ctx.host, { repo: state.root, run: state.run.id }, insensitive)).filter((e) => e.state === "active")
    if (id) {
      const e = all.find((x) => x.id === id)
      if (!e) throw new ToolError(tr("undo.no_effect", { id, run: state.run.id }))
      const done = await undoMany(ctx, state.root, [e], force)
      return ok(done.join("\n"), { undone: done })
    }
    const task = findTask(state, taskId)
    if (task.status === "in_progress") throw new ToolError(tr("undo.task_running", { id: task.id }))
    const effects = all.filter((e) => e.task === task.id && !e.reverts && e.type !== "patch" && !PATCH_MOVES.includes(e.type))
    if (!effects.length) throw new ToolError(tr("undo.task_clean", { id: task.id }))
    const done = await undoMany(ctx, state.root, effects, force)
    const t = await transition(ctx, { ...args, positionals: [task.id] }, "undo", (x) => {
      if (x.status === "done") {
        x.status = "pending"
        x.commit = null
        delete x.evidence
        delete x.finishedAt
        delete x.startedAt
        for (const a of x.acceptance) a.done = false
      }
      return { undone: done }
    })
    return ok(`${done.join("\n")}\n${task.id} → ${t.task.status}\n${progressLine(t.tasks.tasks)}`, { undone: done, task: task.id, status: t.task.status })
  },
  "help.undo",
)

defineAction(
  "effects",
  async (ctx, args) => {
    if (!args.options.check) throw new ToolError(tr("effects.usage"), 2)
    const { host } = ctx
    const root = await requireRepo(host, ctx.cwd)
    const run = typeof args.options.run === "string" ? args.options.run : ctx.boundRun
    const effects = (await effectsOf(host, { repo: root, run }, caseInsensitive(host.platform))).filter((e) => e.state === "active")
    const gone: string[] = []
    const leftovers: string[] = []
    for (const e of effects) {
      let present = true
      if (e.type === "branch") present = await branchExists(host, root, e.ref!)
      else if (e.type === "commit") present = await commitReachable(host, root, e.ref!)
      else if (e.type === "exclude") present = await hasExcludeLine(host, root, e.line ?? ".scratch/")
      else if (e.type === "dir") present = !!(await host.stat(e.path!))
      else if (e.type === "archive") present = !!(await host.stat(e.to!))
      else if (e.type === "patch") present = !!(await host.stat(e.patch!)) || !!(await host.stat(appliedPath(e.patch!)))
      if (!present) {
        await setEffectState(host, runDir(root, e.run), e.run, e.id, "gone")
        gone.push(effectLine({ ...e, state: "gone" }))
      } else if (e.type !== "dir" && e.type !== "archive" && !(await host.stat(runDir(root, e.run)))) leftovers.push(effectLine(e))
    }
    const lines = [tr("effects.checked", { n: effects.length })]
    lines.push(gone.length ? `${tr("effects.gone")}\n${gone.map((l) => `  ${l}`).join("\n")}` : tr("effects.none_gone"))
    if (leftovers.length) lines.push(`${tr("effects.leftovers")}\n${leftovers.map((l) => `  ${l}`).join("\n")}`)
    return ok(lines.join("\n"), { checked: effects.length, gone, leftovers })
  },
  "help.effects",
)
