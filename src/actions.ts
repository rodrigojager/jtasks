// The run's actions: next, start, status (this ticket) and, later, done/skip/fail/release/retry/claim/pause/resume.

import { assess, blockerText, ownerOf, selectReady, taskKeys, waitingOf, waitingText, type RunState } from "./frontier.ts"
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
  holdArgv,
  JLOCK,
  jlockBin,
  jlockList,
  jlockRelease,
  jlockReleaseKeys,
  startHold,
  type JlockAnswer,
  type Identity,
  type JlockLock,
} from "./jlock.ts"
import { unarchive } from "./housekeeping.ts"
import { slugify } from "./ids.ts"
import { canonical, covers, normalizeKey } from "./keys.ts"
import { effectLine, effectsOf, globalLedger, readEffects, recordEffect, setEffectState, type Effect, type NewEffect } from "./ledger.ts"
import { caseInsensitive, join } from "./paths.ts"
import { actorOf } from "./plan.ts"
import type { Hold, Task, TasksFile } from "./schema.ts"
import { appendLog, clone, listRuns, readRun, readTasks, runDir, runsDir, SCRATCH, withLock, writeRun, writeTasks } from "./store.ts"
import { ticketPath, writeTicket } from "./tickets.ts"
import { addUsage, defineAction, ok, ToolError, type ParsedArgs, type ToolContext } from "./tool.ts"
import { normalizeFileEntry } from "./validate.ts"

// ── The run of a command ──────────────────────────────────────────────────────────────────────────────────────

/** `--run`, else the run bound to the session (or GOAL_TASKS_RUN), else the only active run of the repository. */
export async function resolveRun(ctx: ToolContext, args: ParsedArgs): Promise<RunState> {
  const root = await requireRepo(ctx.host, ctx.cwd)
  const explicit = typeof args.options.run === "string" ? args.options.run : ctx.boundRun
  const runs = await listRuns(ctx.host, root)
  let entry = explicit ? runs.find((r) => r.run.id === explicit) : undefined
  if (explicit && !entry) throw new ToolError(`execução não encontrada neste repositório: ${explicit} (veja tasks runs)`)
  if (!entry) {
    const active = runs.filter((r) => r.run.status !== "done")
    if (active.length > 1)
      throw new ToolError(`há ${active.length} execuções ativas (${active.map((r) => r.run.id).join(", ")}): diga qual com --run <id>`)
    // With every run finished, the most recent one (so `status` still answers "restam 0").
    entry = active[0] ?? runs[runs.length - 1]
    if (!entry) throw new ToolError("nenhuma execução neste repositório (crie com tasks plan; veja tasks runs)")
  }
  if (!entry.tasks) throw new ToolError(`a execução ${entry.run.id} não tem tasks.json`)
  return { root, dir: entry.dir, run: entry.run, tasks: entry.tasks }
}

/** Re-reads run.json and tasks.json (inside the write lock, before deciding). */
export async function reload(ctx: ToolContext, state: RunState): Promise<RunState> {
  const run = await readRun(ctx.host, state.dir)
  const tasks = await readTasks(ctx.host, state.dir)
  if (!run || !tasks) throw new ToolError(`a execução ${state.run.id} sumiu de ${state.dir}`)
  return { ...state, run, tasks }
}

export function findTask(state: RunState, id: string | undefined): Task {
  if (!id) throw new ToolError("falta o id da tarefa", 2)
  const task = state.tasks.tasks.find((t) => t.id === id)
  if (!task) throw new ToolError(`a execução ${state.run.id} não tem a tarefa ${id}`)
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

function remember(ctx: ToolContext, state: RunState, task: string, resident: Resident) {
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
 * The task goes back to pending (or failed at maxAttempts), the edits stay on disk, the log says `lost`.
 */
export async function markLost(ctx: ToolContext, first: RunState, id: string): Promise<boolean> {
  const changed = await withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const copy = clone(state.tasks)
    const task = copy.tasks.find((t) => t.id === id)
    if (!task || task.status !== "in_progress") return false
    const now = ctx.host.now().toISOString()
    const to = backToPending(task, state.run.maxAttempts, "posse perdida", now)
    task.lost = now
    const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
    await writeTicket(ctx.host, state.dir, tasks, id)
    await log(ctx, state, { action: "lost", task: id, from: "in_progress", to })
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

/** Spawns a hold: attached in a long-lived host, detached (output to a file of the run) in the CLI. */
export async function spawnHold(ctx: ToolContext, state: RunState, task: Task, argv: string[]): Promise<{ resident: Resident; out?: string }> {
  if (ctx.residents) return { resident: await ctx.host.spawn(argv, { cwd: state.root }) }
  const out = `holds/${task.id}-${ctx.host.now().getTime().toString(36)}${Math.floor(ctx.host.random() * 1296).toString(36)}.out`
  const resident = await ctx.host.spawn(argv, { cwd: state.root, detached: true, logFile: join(state.dir, out) })
  return { resident, out }
}

/**
 * Gives a task's ownership back: `release` on the standard input of each hold this host keeps, then
 * `jlock release --group <run> --owner gt:<run>/<task>` for holds of other processes (the CLI's detached ones,
 * or another window's). A hold told this way ends with 0; one released from outside ends with 14 by itself.
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
    const state = await resolveRun(ctx, args)
    const platform = ctx.host.platform
    const raw = args.positionals[0] ?? (typeof args.options.limit === "string" ? args.options.limit : undefined)
    const limit = raw === undefined ? Infinity : Number(raw)
    if (!(limit > 0)) throw new ToolError(`limite inválido: ${raw}`, 2)
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
    const lines: string[] = []
    if (ready.length) {
      lines.push(`prontas (${ready.length}) em ${state.run.id}; podem rodar em paralelo:`)
      for (const t of items) {
        const own = t.exclusive ? "exclusive (roda sozinha)" : t.files.join(", ") || "(nenhum arquivo)"
        lines.push(`${t.id} · ${t.title} · perfil ${t.profile} · posse: ${own}`)
        if (t.acceptance.length) lines.push(`  critérios: ${t.acceptance.join("; ")}`)
        lines.push(`  ticket: ${t.ticket}`)
      }
    } else if (c.remaining === 0) lines.push(`nada a fazer: ${progressLine(state.tasks.tasks)}`)
    else if (state.run.status === "paused") lines.push("execução pausada: não inicie tarefas")
    else {
      const running = state.tasks.tasks.filter((t) => t.status === "in_progress").map((t) => t.id)
      lines.push(`nenhuma pronta agora${running.length ? `; em andamento: ${running.join(", ")}` : ""}`)
    }
    const why = blocked
      .filter((a) => a.blockers.length)
      .map((a) => `${a.task.id} ${a.blockers.map((b) => blockerText(b, state, platform)).join(" · ")}`)
    if (why.length) lines.push(`bloqueadas: ${why.join(" | ")}`)
    const waiting = waitingOf(state, locks)
    if (waiting.size) lines.push(`aguardando: ${[...waiting].map(([id, w]) => `${id} ${waitingText(w, state, platform)}`).join(" | ")}`)
    return ok(lines.join("\n"), {
      run: state.run.id,
      ready: items,
      blocked: blocked.map((a) => ({ id: a.task.id, reasons: a.blockers.map((b) => blockerText(b, state, platform)) })),
      remaining: c.remaining,
    })
  },
  "next [limite]                         as prontas: perfil, critérios, posse e ticket",
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
      if (state.run.status === "paused") throw new ToolError(`a execução ${state.run.id} está pausada: não inicie tarefas`)
      if (task.status !== "pending") {
        const who = task.owner ? ` (dono: ${task.owner})` : ""
        throw new ToolError(`${task.id} não está pendente: está ${task.status}${who}`)
      }
      const byId = new Map(state.tasks.tasks.map((t) => [t.id, t]))
      const open = task.dependsOn.filter((d) => !["done", "skipped"].includes(byId.get(d)?.status ?? ""))
      if (open.length) throw new ToolError(`${task.id} não está pronta: depende de ${open.join(", ")}`)

      const keys = taskKeys(state.root, task, ctx.host.platform)
      const now = ctx.host.now().toISOString()
      let hold: Hold | undefined
      let resident: Resident | undefined
      if (keys.length) {
        const argv = holdArgv(ctx.host, keys, identity(ctx, state, task), { noWait: true })
        const spawned = await spawnHold(ctx, state, task, argv)
        const outcome = await startHold(ctx.host, spawned.resident, 15_000)
        if (outcome.answer.result !== "granted") {
          const a = outcome.answer
          const holder = typeof a.holder === "object" && a.holder ? describeOwner(a.holder.owner, state.run.id) : "outro dono"
          const key = a.failed ?? a.key ?? keys[0]!
          const via = a.via && a.via !== key ? ` (via ${describeKey(a.via, state.root, ctx.host.platform)})` : ""
          throw new ToolError(
            `${task.id} não estava pronta: ${describeKey(key, state.root, ctx.host.platform)} em uso por ${holder}${via}; nada foi gravado`,
            1,
            { result: a.result, key, holder: a.holder, position: a.position, via: a.via },
          )
        }
        resident = spawned.resident
        hold = { keys, startedAt: now, kind: "start" }
        if (resident.pid !== undefined) hold.pid = resident.pid
        if (spawned.out) hold.out = spawned.out
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
      try {
        const written = await writeTasks(ctx.host, state.dir, changed, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, written, task.id)
      } catch (error) {
        if (resident) await releaseHoldsOf(ctx, state.run.id, task.id, resident, keys)
        throw error
      }
      if (resident) remember(ctx, state, task.id, resident)
      await log(ctx, state, { action: "start", task: task.id, from: "pending", to: "in_progress", keys })
      const ticket = ticketPath(state.dir, changed.tasks, task.id)
      const own = keys.length ? `posse travada no jlock (${keys.length} chave(s), dono ${ownerOf(state.run.id, task.id)})` : "sem arquivos na posse"
      return ok(
        [
          `${task.id} em andamento (tentativa ${t.attempts}): ${own}`,
          `ticket: ${ticket}`,
          `outro arquivo: tasks claim ${task.id} <arquivo>; no fim: tasks done ${task.id} --evidence "…" (ou tasks fail ${task.id} --error "…")`,
        ].join("\n"),
        { run: state.run.id, task: task.id, keys, owner: t.owner, attempts: t.attempts, ticket },
      )
    })
  },
  "start <id>                            em andamento; trava a posse (jlock hold --no-wait)",
)

/** Gives back one hold only (its own keys): a start or claim that could not be recorded. */
async function releaseHoldsOf(ctx: ToolContext, run: string, task: string, resident: Resident, keys: string[]) {
  if (!(await resident.send("release\n"))) await jlockReleaseKeys(ctx.host, keys, ownerOf(run, task)).catch(() => {})
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
  if (state.run.status === "paused") lines.push("pausada: não inicie tarefas")
  const running = state.tasks.tasks.filter((t) => t.status === "in_progress")
  const byKey = new Map([...repoLocks, ...groupLocks].map((l) => [l.key, l]))
  const waiting = waitingOf(state, [...byKey.values()])
  if (running.length) lines.push(`em andamento: ${running.map((t) => `${t.id} (${t.owner ?? "?"})`).join(" · ")}`)
  if (waiting.size)
    lines.push(`aguardando: ${[...waiting].map(([id, w]) => `${id} ${waitingText(w, state, platform)}`).join(" | ")}`)
  if (ready.length) lines.push(`prontas: ${ready.map((t) => t.id).join(", ")}`)
  const blocked = assessments.filter((a) => a.blockers.length)
  if (blocked.length)
    lines.push(`bloqueadas: ${blocked.map((a) => `${a.task.id} ${a.blockers.map((b) => blockerText(b, state, platform)).join(" · ")}`).join(" | ")}`)
  const failed = state.tasks.tasks.filter((t) => t.status === "failed")
  if (failed.length) lines.push(`falhas: ${failed.map((t) => `${t.id}: ${t.error ?? "?"}`).join(" | ")}`)
  // Lost ownership: recorded by a long-lived host, or seen now (an in-progress task whose keys jlock no longer has).
  const lost = state.tasks.tasks.filter((t) => t.status === "pending" && t.lost).map((t) => t.id)
  for (const t of running) {
    const owner = ownerOf(state.run.id, t.id)
    const keys = taskKeys(state.root, t, platform)
    const held = groupLocks.filter((l) => l.holder?.owner === owner && l.holder.stale !== true).map((l) => l.key)
    if (keys.length && keys.some((k) => !held.includes(k))) lost.push(`${t.id} (sem travas no jlock: tasks resume ou tasks release ${t.id})`)
  }
  if (lost.length) lines.push(`posse perdida: ${lost.join(", ")}`)
  const locks = groupLocks.map((l) => ({
    key: describeKey(l.key, state.root, platform),
    holder: l.holder ? describeOwner(l.holder.owner, state.run.id) : null,
    queue: l.queue.map((q) => ({ owner: describeOwner(q.owner, state.run.id), position: q.position })),
  }))
  if (locks.length)
    lines.push(
      `travas ativas (jlock --group ${state.run.id}): ${locks
        .map((l) => `${l.key} → ${l.holder ?? "livre"}${l.queue.length ? ` (${l.queue.length} na fila: ${l.queue.map((q) => q.owner).join(", ")})` : ""}`)
        .join(" · ")}`,
    )
  else lines.push("travas ativas: nenhuma")
  return {
    text: lines.join("\n"),
    data: {
      run: state.run.id,
      status: state.run.status,
      counts: counts(state.tasks.tasks),
      inProgress: running.map((t) => ({ id: t.id, owner: t.owner, waitingFor: waiting.get(t.id) ?? null })),
      ready: ready.map((t) => t.id),
      blocked: blocked.map((a) => ({ id: a.task.id, reasons: a.blockers.map((b) => blockerText(b, state, platform)) })),
      locks,
    },
  }
}

defineAction(
  "status",
  async (ctx, args) => {
    const state = await resolveRun(ctx, args)
    const s = await statusOf(ctx, state)
    return ok(s.text, s.data)
  },
  "status                                feitas F/T (P%) · … · restam N, fronteira e travas",
)

addUsage("  (sem --run: a execução ligada à sessão, GOAL_TASKS_RUN, ou a única ativa do repositório)")

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
  const out: TreeSplit = { inside: [], others: [], outside: [] }
  for (const e of await gitStatus(ctx.host, state.root)) {
    if (e.path.startsWith(`${SCRATCH}/`) || e.path === SCRATCH) continue
    let list = out.outside
    if (inPossession(e.path, own, insensitive)) list = out.inside
    else if (inPossession(e.path, otherOwn, insensitive)) list = out.others
    else {
      const key = normalizeKey(e.path, state.root, ctx.host.platform)
      if (otherKeys.some((k) => covers(k, key))) list = out.others
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

function changesNote(changes: string[]): string {
  return changes.length ? `; edições não commitadas ficaram no disco: ${changes.join(", ")}` : ""
}

async function giveBack(ctx: ToolContext, run: string, task: string): Promise<string> {
  try {
    await releaseHolds(ctx, run, task)
    return "posse devolvida"
  } catch (error) {
    return `a posse não foi devolvida (${(error as Error).message}); use jlock release --group ${run} --owner ${ownerOf(run, task)}`
  }
}

// ── claim ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `60s`, `2m`, `500ms`, `90` (seconds). */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim())
  if (!m) throw new ToolError(`duração inválida: ${raw} (use 30s, 2m, 500ms)`, 2)
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return Math.round(unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000)
}

/** jlock's deadlock chain with our owners shortened (`gt:<run>/T04` → `T04`). */
export function chainText(chain: string, run: string): string {
  return chain.replace(/gt:([^\s/]+)\/([^\s)]+)/g, (_, r: string, t: string) => (r === run ? t : `${r}/${t}`))
}

defineAction(
  "claim",
  async (ctx, args) => {
    const first = await resolveRun(ctx, args)
    const task = findTask(first, taskIdArg(args))
    const raw = args.positionals.slice(1)
    if (!raw.length) throw new ToolError(`falta o arquivo: tasks claim ${task.id} <arquivo…>`, 2)
    if (task.status !== "in_progress") throw new ToolError(`${task.id} não está em andamento (está ${task.status}): claim só durante a tarefa`)
    const platform = ctx.host.platform
    const files: string[] = []
    const errors: string[] = []
    for (const r of raw) {
      const entry = normalizeFileEntry(r)
      if (entry.error) errors.push(entry.error)
      else if (entry.path && !files.includes(entry.path)) files.push(entry.path)
    }
    if (errors.length) throw new ToolError(`claim recusado: ${errors.join("; ")}`)
    const current = taskKeys(first.root, task, platform)
    const wanted = files.filter((f) => {
      const key = normalizeKey(f, first.root, platform)
      return !current.some((k) => covers(k, key))
    })
    if (!wanted.length) return ok(`${task.id} já tem ${files.join(", ")} na posse: nada a fazer`, { task: task.id, granted: [] })
    const keys = canonical(wanted.map((f) => normalizeKey(f, first.root, platform)))
    const timeoutMs = parseDuration(typeof args.options.timeout === "string" ? args.options.timeout : "60s")
    const argv = holdArgv(ctx.host, keys, identity(ctx, first, task), { timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)) })
    const began = ctx.host.now().getTime()
    const spawned = await spawnHold(ctx, first, task, argv)
    const outcome = await startHold(ctx.host, spawned.resident, timeoutMs + 15_000)
    const waited = ((ctx.host.now().getTime() - began) / 1000).toFixed(1)
    const a = outcome.answer
    const holderOf = (h: JlockAnswer["holder"]) => (typeof h === "object" && h ? describeOwner(h.owner, first.run.id) : typeof h === "string" ? describeOwner(h, first.run.id) : "?")

    if (a.result === "timeout") {
      const key = a.failed ?? a.key ?? keys[0]!
      const via = a.via && a.via !== key ? ` (via ${describeKey(a.via, first.root, platform)})` : ""
      await log(ctx, first, { action: "claim-timeout", task: task.id, keys, waitedSec: Number(waited) })
      throw new ToolError(
        `${task.id} esperou ${waited} s por ${describeKey(key, first.root, platform)}: continua em uso por ${holderOf(a.holder)}${via}, ` +
          `posição ${a.position ?? "?"} na fila. Opções: pedir de novo (tasks claim ${task.id} ${wanted.join(" ")} --timeout 5m), ` +
          `fazer a parte que não depende desse arquivo, ou tasks fail ${task.id} --error "…"`,
        1,
        { result: "timeout", key, holder: holderOf(a.holder), position: a.position, via: a.via },
      )
    }
    if (a.result === "deadlock") {
      await log(ctx, first, { action: "claim-deadlock", task: task.id, keys, chain: a.chain })
      throw new ToolError(
        `claim recusado: fecharia um ciclo de espera (deadlock): ${chainText(a.chain ?? "", first.run.id)}. ` +
          `Quem pediu por último cede: ${task.id} — faça outra parte, ou libere com tasks release ${task.id}`,
        1,
        { result: "deadlock", chain: a.chain, yield: task.id },
      )
    }
    if (a.result !== "granted") throw new ToolError(`jlock respondeu ${a.result} ao claim de ${task.id}`)

    const resident = spawned.resident
    try {
      const done = await withLock(ctx.host, first.dir, async () => {
        const state = await reload(ctx, first)
        const copy = clone(state.tasks)
        const t = copy.tasks.find((x) => x.id === task.id)!
        if (t.status !== "in_progress") throw new ToolError(`${task.id} deixou de estar em andamento enquanto esperava (está ${t.status})`)
        t.claimed = [...(t.claimed ?? []), ...wanted.filter((f) => !(t.claimed ?? []).includes(f))]
        const hold: Hold = { keys, startedAt: ctx.host.now().toISOString(), kind: "claim" }
        if (resident.pid !== undefined) hold.pid = resident.pid
        if (spawned.out) hold.out = spawned.out
        t.holds = [...(t.holds ?? []), hold]
        const tasks = await writeTasks(ctx.host, state.dir, copy, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, tasks, task.id)
        await log(ctx, state, { action: "claim", task: task.id, files: wanted, keys, waitedSec: Number(waited) })
        return t
      })
      remember(ctx, first, task.id, resident)
      return ok(`${task.id} recebeu ${wanted.join(", ")} (esperou ${waited} s); posse: ${possession(done).join(", ")}`, {
        task: task.id,
        granted: wanted,
        keys,
        waitedSec: Number(waited),
      })
    } catch (error) {
      await releaseHoldsOf(ctx, first.run.id, task.id, resident, keys).catch(() => {})
      throw error
    }
  },
  "claim <id> <arquivo…> [--timeout 60s]  pede mais um arquivo; espera na fila do jlock",
)

// ── done ──────────────────────────────────────────────────────────────────────────────────────────────────────

defineAction(
  "done",
  async (ctx, args) => {
    const evidence = textArg(args, "evidence")
    let commit: string | null = null
    let claimed: string[] = []
    const t = await transition(ctx, args, "done", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(`${task.id} não está em andamento (está ${task.status})`)
      if (!evidence) throw new ToolError(`done sem evidência é recusado: tasks done ${task.id} --evidence "o que prova que está feita"`, 2)
      const branch = await currentBranch(ctx.host, state.root)
      if (branch !== state.run.repo.branch)
        throw new ToolError(`o checkout está em ${branch ?? "HEAD destacado"}, mas a execução commita em ${state.run.repo.branch}`)
      const split = await splitChanges(ctx, state, task)
      if (split.outside.length)
        throw new ToolError(
          `${task.id} não pode ser concluída: arquivos modificados fora da posse: ${split.outside.join(", ")}. ` +
            `Peça-os com tasks claim ${task.id} <arquivo>, ou desfaça essas mudanças`,
          1,
          { outside: split.outside },
        )
      const missing = await missingKeys(ctx, state, task)
      if (missing.length)
        throw new ToolError(
          `posse perdida: ${missing.map((k) => describeKey(k, state.root, ctx.host.platform)).join(", ")} já não está com ${task.id} no jlock; ` +
            `o done foi recusado (use tasks release ${task.id} e comece de novo)`,
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
    const what = commit ? `commit ${commit} (${t.task.id}: ${t.task.title})` : "nenhuma mudança na posse, sem commit"
    const lines = [`${t.task.id} feita: ${what}; ${released}`, progressLine(t.tasks.tasks)]
    if (claimed.length) lines.push(`reclamados durante a tarefa: ${claimed.join(", ")}; atualize o plano se outras tarefas também os tocam`)
    return ok(lines.join("\n"), { run: t.state.run.id, task: t.task.id, commit, counts: counts(t.tasks.tasks), claimed })
  },
  'done <id> --evidence "…"              confere git e posse; commit só da posse; feita',
)

// ── skip / fail / release / retry ─────────────────────────────────────────────────────────────────────────────

defineAction(
  "skip",
  async (ctx, args) => {
    const reason = textArg(args, "reason")
    let wasRunning = false
    let left: string[] = []
    const t = await transition(ctx, args, "skip", async (task, state) => {
      if (!["pending", "in_progress", "failed"].includes(task.status)) throw new ToolError(`${task.id} está ${task.status}: não dá para pular`)
      if (!reason) throw new ToolError(`skip sem motivo é recusado: tasks skip ${task.id} --reason "por quê"`, 2)
      wasRunning = task.status === "in_progress"
      if (wasRunning) left = (await splitChanges(ctx, state, task)).inside
      closeTask(task, "skipped", ctx.host.now().toISOString())
      task.reason = reason
      return { reason }
    })
    const released = wasRunning ? `; ${await giveBack(ctx, t.state.run.id, t.task.id)}` : ""
    return ok(`${t.task.id} pulada: ${reason}${released}${changesNote(left)}\n${progressLine(t.tasks.tasks)}`, {
      run: t.state.run.id,
      task: t.task.id,
      uncommitted: left,
    })
  },
  'skip <id> --reason "…"                pulada (libera as dependentes)',
)

defineAction(
  "fail",
  async (ctx, args) => {
    const error = textArg(args, "error")
    let left: string[] = []
    const t = await transition(ctx, args, "fail", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(`${task.id} não está em andamento (está ${task.status})`)
      if (!error) throw new ToolError(`fail sem erro é recusado: tasks fail ${task.id} --error "o que deu errado"`, 2)
      left = (await splitChanges(ctx, state, task)).inside
      closeTask(task, "failed", ctx.host.now().toISOString())
      task.error = error
      return { error }
    })
    const released = await giveBack(ctx, t.state.run.id, t.task.id)
    return ok(`${t.task.id} falhou: ${error}; ${released}${changesNote(left)}\n${progressLine(t.tasks.tasks)}`, {
      run: t.state.run.id,
      task: t.task.id,
      uncommitted: left,
    })
  },
  'fail <id> --error "…"                 falha (bloqueia as dependentes)',
)

/** In progress → pending (or failed at maxAttempts), keeping the edits on disk. Used by release, resume, lost. */
export function backToPending(task: Task, maxAttempts: number, why: string, now: string): "pending" | "failed" {
  task.owner = null
  delete task.holds
  if (task.attempts >= maxAttempts) {
    task.status = "failed"
    task.error = `${why}; tentativas esgotadas (${task.attempts}/${maxAttempts})`
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
    let left: string[] = []
    let to: string = "pending"
    // --agent-ended: the host saw the subagent's loop end with its task still in progress (logged as such).
    const ended = !!args.options["agent-ended"]
    const t = await transition(ctx, args, ended ? "agent-ended" : "release", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(`${task.id} não está em andamento (está ${task.status})`)
      left = (await splitChanges(ctx, state, task)).inside
      to = backToPending(task, state.run.maxAttempts, ended ? "o subagente terminou sem concluir" : "liberada", ctx.host.now().toISOString())
      return { uncommitted: left }
    })
    const released = await giveBack(ctx, t.state.run.id, t.task.id)
    const where = to === "failed" ? `falhou: ${t.task.error}` : `voltou a pendente (tentativa ${t.task.attempts}/${t.state.run.maxAttempts})`
    return ok(`${t.task.id} ${where}; ${released}${changesNote(left)}\n${progressLine(t.tasks.tasks)}`, {
      run: t.state.run.id,
      task: t.task.id,
      status: t.task.status,
      uncommitted: left,
    })
  },
  "release <id>                          em andamento → pendente (no maxAttempts, falha)",
)

function reopen(task: Task) {
  if (task.status !== "skipped" && task.status !== "failed") throw new ToolError(`${task.id} está ${task.status}: retry só reabre pulada ou falha`)
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
      const text = reopened.ids.length ? `reabertas: ${reopened.ids.join(", ")}` : "nenhuma falha para reabrir"
      return ok(`${text}\n${progressLine(reopened.tasks.tasks)}`, { reopened: reopened.ids })
    }
    const t = await transition(ctx, args, "retry", (task) => {
      reopen(task)
      task.attempts = 0
    })
    return ok(`${t.task.id} reaberta: pendente\n${progressLine(t.tasks.tasks)}`, { run: t.state.run.id, task: t.task.id })
  },
  "retry <id> | --all-failed             pulada ou falha → pendente",
)

// ── pause / unpause / resume ──────────────────────────────────────────────────────────────────────────────────

async function setPaused(ctx: ToolContext, args: ParsedArgs, paused: boolean) {
  const first = await resolveRun(ctx, args)
  return withLock(ctx.host, first.dir, async () => {
    const state = await reload(ctx, first)
    const from = state.run.status
    const status = paused ? "paused" : counts(state.tasks.tasks).remaining === 0 ? "done" : "active"
    if (from !== status) await writeRun(ctx.host, state.dir, { ...state.run, status })
    await log(ctx, state, { action: paused ? "pause" : "unpause", from, to: status })
    return { ...state, run: { ...state.run, status } }
  })
}

defineAction(
  "pause",
  async (ctx, args) => {
    const state = await setPaused(ctx, args, true)
    const running = state.tasks.tasks.filter((t) => t.status === "in_progress").map((t) => t.id)
    const tail = running.length ? `; as em andamento terminam: ${running.join(", ")}` : ""
    return ok(`execução ${state.run.id} pausada: start recusado, não inicie tarefas${tail}`, { run: state.run.id, status: "paused" })
  },
  "pause / unpause                       pausada: start recusado; o protocolo manda parar",
)

defineAction("unpause", async (ctx, args) => {
  const state = await setPaused(ctx, args, false)
  return ok(`execução ${state.run.id} retomada (${state.run.status})\n${progressLine(state.tasks.tasks)}`, { run: state.run.id, status: state.run.status })
})

defineAction(
  "resume",
  async (ctx, args) => {
    const wanted = args.positionals[0] ?? (typeof args.options.run === "string" ? args.options.run : undefined)
    let back: string | undefined
    if (args.options["from-archive"]) {
      if (!wanted) throw new ToolError("diga qual: tasks resume <run> --from-archive", 2)
      back = await unarchive(ctx, wanted)
    }
    const first = await resolveRun(ctx, { ...args, options: { ...args.options, ...(wanted ? { run: wanted } : {}) } })
    const keepOwners = !!args.options["keep-owners"]
    const released: { id: string; to: string; uncommitted: string[] }[] = []
    const kept: string[] = []
    const state = await withLock(ctx.host, first.dir, async () => {
      const state = await reload(ctx, first)
      const now = ctx.host.now().toISOString()
      const run = { ...state.run }
      if (run.status === "paused") run.status = counts(state.tasks.tasks).remaining === 0 ? "done" : "active"
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
        const uncommitted = (await splitChanges(ctx, state, task, false)).inside
        const to = backToPending(task, run.maxAttempts, "agente sem travas no jlock (janela encerrada)", now)
        released.push({ id: task.id, to, uncommitted })
      }
      const tasks = released.length ? await writeTasks(ctx.host, state.dir, copy, state.tasks.revision) : state.tasks
      if (JSON.stringify(run) !== JSON.stringify(state.run)) await writeRun(ctx.host, state.dir, run)
      for (const r of released) {
        await writeTicket(ctx.host, state.dir, tasks, r.id)
        await log(ctx, state, { action: "resume-release", task: r.id, from: "in_progress", to: r.to, uncommitted: r.uncommitted })
      }
      await log(ctx, state, { action: "resume", released: released.map((r) => r.id), kept })
      return { ...state, run, tasks }
    })
    // Whatever is left of a released task's locks (a stale holder) goes back too.
    for (const r of released) await jlockRelease(ctx.host, state.run.id, ownerOf(state.run.id, r.id)).catch(() => {})
    const lines = [...(back ? [back] : []), `execução ${state.run.id} retomada nesta sessão`]
    for (const r of released)
      lines.push(
        `${r.id} liberada (sem travas no jlock) → ${r.to}${r.uncommitted.length ? `; edições no disco: ${r.uncommitted.join(", ")}` : ""}`,
      )
    if (kept.length) lines.push(`mantidas em andamento: ${kept.join(", ")}${keepOwners ? " (--keep-owners)" : " (travas vivas)"}`)
    const s = await statusOf(ctx, state)
    lines.push(s.text)
    return ok(lines.join("\n"), { ...s.data, released, kept }, { bind: state.run.id })
  },
  "resume <run> [--keep-owners]          liga a sessão, tira da pausa, libera tarefas sem travas",
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
    if (!argv.length) throw new ToolError("falta o comando: tasks exec -- <comando…>", 2)
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
    const r = await ctx.host.run(full, { cwd: ctx.cwd, timeoutMs: 10 * 60_000 })
    const how = entry ? `serializado por jlock run ${serializeKey(root, entry)}` : "direto (fora de serialize)"
    const output = `${r.stdout}${r.stderr}`.replace(/\s+$/, "")
    return { ok: r.code === 0, code: r.code, text: `${output}${output ? "\n" : ""}[${how}; saiu com ${r.code}]`, data: { code: r.code, serialized: !!entry } }
  },
  "exec -- <comando…>                    roda o comando; os de serialize, um por vez na máquina",
)

// ── ledger / undo / effects ───────────────────────────────────────────────────────────────────────────────────

defineAction(
  "ledger",
  async (ctx, args) => {
    const insensitive = caseInsensitive(ctx.host.platform)
    if (args.options["all-projects"]) {
      const all = await readEffects(ctx.host, globalLedger(ctx.host))
      const active = all.filter((e) => e.state === "active").length
      const lines = [`ledger global (${globalLedger(ctx.host)}): ${all.length} efeito(s), ${active} ativo(s)`]
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
    const scope = run ? `da execução ${run}` : `do repositório ${root}`
    const lines = [`ledger ${scope}: ${effects.length} efeito(s), ${active} ativo(s)`, ...effects.map(effectLine)]
    return ok(lines.join("\n"), { effects })
  },
  "ledger [--all-projects]               tudo o que a ferramenta criou: tipo, ref, execução, tarefa, estado",
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
      if (dirty.length) throw new ToolError(`${e.id}: a árvore tem mudanças não salvas (${dirty.join(", ")}); commite ou descarte antes do undo`)
      if (!(await commitExists(host, root, ref))) throw new ToolError(`${e.id}: o commit ${ref} não existe mais (veja tasks effects --check)`)
      const r = await git(host, root, ["revert", "--no-edit", ref])
      if (r.code !== 0) {
        await git(host, root, ["revert", "--abort"])
        throw new ToolError(`${e.id}: git revert ${ref} não aplicou limpo: ${(r.stderr || r.stdout).trim()}`)
      }
      const head = await shortHead(host, root)
      const branch = (await currentBranch(host, root)) ?? "HEAD"
      const effect: NewEffect = { run: e.run, type: "commit", repo: root, ref: head, branch, undo: { kind: "git-revert", ref: head }, reverts: e.id }
      if (e.task) effect.task = e.task
      await recordEffect(host, dir, effect)
      return `${e.id}: revert de ${ref} → commit ${head}`
    }
    case "git-branch-delete": {
      const branch = e.ref!
      if (!(await branchExists(host, root, branch))) return `${e.id}: o branch ${branch} já não existia`
      const base = e.from ?? "main"
      if (!force && !(await isMerged(host, root, branch, base)))
        throw new ToolError(`${e.id}: o branch ${branch} tem commits que não estão em ${base}; integre-os (git merge) ou use --force`)
      if ((await currentBranch(host, root)) === branch) {
        const dirty = dirtyFiles(await gitStatus(host, root))
        if (dirty.length) throw new ToolError(`${e.id}: ${branch} está em uso com mudanças não salvas (${dirty.join(", ")})`)
        await gitOk(host, root, ["switch", "-q", base])
      }
      await gitOk(host, root, ["branch", "-D", branch])
      return `${e.id}: branch ${branch} removido (checkout em ${base})`
    }
    case "remove-line": {
      const others = (await host.list(runsDir(root))).filter((d) => d.kind === "dir" && d.name !== e.run)
      if (others.length && !force)
        throw new ToolError(`${e.id}: outras execuções ainda usam a linha ${e.line} do exclude (${others.map((d) => d.name).join(", ")}); use --force para tirar mesmo assim`)
      const removed = await removeExcludeLine(host, root, e.line ?? ".scratch/")
      return `${e.id}: ${removed ? "linha removida" : "a linha já não estava"} em ${e.path}`
    }
    case "rmdir": {
      const target = e.path ?? dir
      const tasks = await readTasks(host, target).catch(() => undefined)
      const running = tasks?.tasks.filter((t) => t.status === "in_progress").map((t) => t.id) ?? []
      if (running.length) throw new ToolError(`${e.id}: a execução tem tarefas em andamento (${running.join(", ")}); libere-as antes`)
      await host.remove(target, { recursive: true })
      return `${e.id}: pasta ${target} removida`
    }
    default:
      throw new ToolError(`${e.id}: não há desfazer automático para ${e.type} (${e.undo.kind})`)
  }
}

/** Undoes effects newest first; stops at the first refusal, saying what was already undone. */
async function undoMany(ctx: ToolContext, root: string, effects: Effect[], force: boolean) {
  const done: string[] = []
  for (const e of [...effects].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    try {
      done.push(await undoEffect(ctx, root, e, force))
    } catch (error) {
      if (error instanceof ToolError && done.length)
        throw new ToolError(`${done.join("\n")}\nparou em: ${error.message}`, error.code, { undone: done })
      throw error
    }
    await setEffectState(ctx.host, runDir(root, e.run), e.run, e.id, "undone")
  }
  return done
}

defineAction(
  "undo",
  async (ctx, args) => {
    const force = !!args.options.force
    const id = args.positionals[0]
    const taskId = typeof args.options.task === "string" ? args.options.task : undefined
    const insensitive = caseInsensitive(ctx.host.platform)
    if (!id && !taskId) {
      const runId = typeof args.options.run === "string" ? args.options.run : undefined
      if (!runId) throw new ToolError("diga o que desfazer: tasks undo <e-id> | --task <id> | --run <run>", 2)
      const root = await requireRepo(ctx.host, ctx.cwd)
      const effects = (await effectsOf(ctx.host, { repo: root, run: runId }, insensitive)).filter((e) => e.state === "active")
      if (!effects.length) return ok(`a execução ${runId} não tem efeitos ativos`, { undone: [] })
      const done = await undoMany(ctx, root, effects, force)
      return ok(`execução ${runId} desfeita:\n${done.join("\n")}`, { undone: done })
    }
    const state = await resolveRun(ctx, args)
    const all = (await effectsOf(ctx.host, { repo: state.root, run: state.run.id }, insensitive)).filter((e) => e.state === "active")
    if (id) {
      const e = all.find((x) => x.id === id)
      if (!e) throw new ToolError(`não há efeito ativo ${id} na execução ${state.run.id} (veja tasks ledger)`)
      const done = await undoMany(ctx, state.root, [e], force)
      return ok(done.join("\n"), { undone: done })
    }
    const task = findTask(state, taskId)
    if (task.status === "in_progress") throw new ToolError(`${task.id} está em andamento: libere-a (tasks release ${task.id}) antes do undo`)
    const effects = all.filter((e) => e.task === task.id && !e.reverts)
    if (!effects.length) throw new ToolError(`${task.id} não tem efeitos ativos para desfazer`)
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
  "undo <e-id> | --task <id> | --run <run> [--force]   desfaz na ordem inversa (revert, branch, exclude, pasta)",
)

defineAction(
  "effects",
  async (ctx, args) => {
    if (!args.options.check) throw new ToolError("use tasks effects --check", 2)
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
      if (!present) {
        await setEffectState(host, runDir(root, e.run), e.run, e.id, "gone")
        gone.push(effectLine({ ...e, state: "gone" }))
      } else if (e.type !== "dir" && e.type !== "archive" && !(await host.stat(runDir(root, e.run)))) leftovers.push(effectLine(e))
    }
    const lines = [`${effects.length} efeito(s) ativo(s) conferido(s) com o disco e o git`]
    lines.push(gone.length ? `sumiram por fora (marcados gone):\n${gone.map((l) => `  ${l}`).join("\n")}` : "nada sumiu por fora")
    if (leftovers.length) lines.push(`ficaram de execuções já removidas:\n${leftovers.map((l) => `  ${l}`).join("\n")}`)
    return ok(lines.join("\n"), { checked: effects.length, gone, leftovers })
  },
  "effects --check                       compara o ledger com o disco e o git (o que sumiu, o que ficou)",
)
