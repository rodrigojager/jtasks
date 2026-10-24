// The run's actions: next, start, status (this ticket) and, later, done/skip/fail/release/retry/claim/pause/resume.

import { assess, blockerText, ownerOf, selectReady, taskKeys, type RunState } from "./frontier.ts"
import { counts, progressLine } from "./format.ts"
import { currentBranch, gitOk, requireRepo, shortHead, status as gitStatus } from "./git.ts"
import type { Resident } from "./host.ts"
import {
  describeKey,
  describeOwner,
  holdArgv,
  jlockList,
  jlockRelease,
  startHold,
  type Identity,
  type JlockLock,
} from "./jlock.ts"
import { covers, normalizeKey } from "./keys.ts"
import { recordEffect } from "./ledger.ts"
import { caseInsensitive, join } from "./paths.ts"
import { actorOf } from "./plan.ts"
import type { Hold, Task, TasksFile } from "./schema.ts"
import { appendLog, listRuns, readRun, readTasks, SCRATCH, withLock, writeRun, writeTasks } from "./store.ts"
import { ticketPath, writeTicket } from "./tickets.ts"
import { addUsage, defineAction, ok, ToolError, type ParsedArgs, type ToolContext } from "./tool.ts"

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

function remember(ctx: ToolContext, run: string, task: string, resident: Resident) {
  if (!ctx.residents) return
  const key = residentKey(run, task)
  ctx.residents.set(key, [...(ctx.residents.get(key) ?? []), resident])
  const watch = ctx.onHoldExit
  void resident.exited.then((code) => {
    const list = ctx.residents?.get(key)
    if (!list?.includes(resident)) return
    ctx.residents!.set(
      key,
      list.filter((r) => r !== resident),
    )
    watch?.(run, task, code)
  })
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
      const changed = structuredClone(state.tasks)
      const t = changed.tasks.find((x) => x.id === task.id)!
      t.status = "in_progress"
      t.attempts += 1
      t.owner = actorOf(ctx)
      t.startedAt = now
      t.holds = hold ? [hold] : []
      delete t.finishedAt
      try {
        const written = await writeTasks(ctx.host, state.dir, changed, state.tasks.revision)
        await writeTicket(ctx.host, state.dir, written, task.id)
      } catch (error) {
        if (resident) await releaseHoldsOf(ctx, state.run.id, task.id, resident)
        throw error
      }
      if (resident) remember(ctx, state.run.id, task.id, resident)
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

async function releaseHoldsOf(ctx: ToolContext, run: string, task: string, resident: Resident) {
  if (!(await resident.send("release\n"))) await jlockRelease(ctx.host, run, ownerOf(run, task)).catch(() => {})
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
  if (running.length) lines.push(`em andamento: ${running.map((t) => `${t.id} (${t.owner ?? "?"})`).join(" · ")}`)
  if (ready.length) lines.push(`prontas: ${ready.map((t) => t.id).join(", ")}`)
  const blocked = assessments.filter((a) => a.blockers.length)
  if (blocked.length)
    lines.push(`bloqueadas: ${blocked.map((a) => `${a.task.id} ${a.blockers.map((b) => blockerText(b, state, platform)).join(" · ")}`).join(" | ")}`)
  const failed = state.tasks.tasks.filter((t) => t.status === "failed")
  if (failed.length) lines.push(`falhas: ${failed.map((t) => `${t.id}: ${t.error ?? "?"}`).join(" | ")}`)
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
      inProgress: running.map((t) => ({ id: t.id, owner: t.owner })),
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
  const held = new Set((await jlockList(ctx.host, { group: state.run.id })).filter((l) => l.holder?.owner === owner).map((l) => l.key))
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
    const copy = structuredClone(state.tasks)
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
    const t = await transition(ctx, args, "release", async (task, state) => {
      if (task.status !== "in_progress") throw new ToolError(`${task.id} não está em andamento (está ${task.status})`)
      left = (await splitChanges(ctx, state, task)).inside
      to = backToPending(task, state.run.maxAttempts, "liberada", ctx.host.now().toISOString())
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
        const copy = structuredClone(state.tasks)
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
