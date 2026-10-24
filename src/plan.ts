// `jtasks plan`: from a validated plan to a run (run.json, tasks.json, tickets, branch, ledger) and `jtasks runs`.

import { formatRunsList } from "./format.ts"
import { addExcludeLine, branchExists, currentBranch, git, gitOk, hasExcludeLine, removeExcludeLine, requireRepo } from "./git.ts"
import { runId } from "./ids.ts"
import { recordEffect } from "./ledger.ts"
import { basename, isAbsolute, join } from "./paths.ts"
import {
  DEFAULT_HOLD_TTL,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PROFILE,
  DEFAULT_PROFILES,
  type PlanInput,
  type PlanTask,
  type Profile,
  type RunFile,
  type Task,
  type TasksFile,
} from "./schema.ts"
import { appendLog, atomicWrite, listRuns, readJson, runDir, runsDir, stringify, withLock } from "./store.ts"
import { readTicketsDir, ticketReadLine, writeTickets } from "./tickets.ts"
import { addUsage, defineAction, ok, readJsonArg, ToolError, type ParsedArgs, type ToolContext, type ToolResult } from "./tool.ts"
import { readPlan, validateBatch, validatePlan } from "./validate.ts"
import { tr } from "./i18n.ts"

export function actorOf(ctx: ToolContext): string {
  const base = ctx.session ? `${ctx.tool}:${ctx.session}` : ctx.tool
  return ctx.agent ? `${base}/agent:${ctx.agent}` : base
}

export function toTask(p: PlanTask, profiles: Record<string, Profile>, source?: string): Task {
  const fallback = DEFAULT_PROFILE in profiles ? DEFAULT_PROFILE : (Object.keys(profiles)[0] ?? DEFAULT_PROFILE)
  const task: Task = {
    id: p.id,
    title: p.title.trim(),
    status: "pending",
    dependsOn: [...(p.dependsOn ?? [])],
    profile: p.profile ?? fallback,
    files: [...(p.files ?? [])],
    acceptance: (p.acceptance ?? []).map((a) => (typeof a === "string" ? { text: a, done: false } : { text: a.text, done: !!a.done })),
    attempts: 0,
    owner: null,
  }
  if (p.what) task.what = p.what
  if (p.source || source) task.source = (p.source || source)!
  if (p.exclusive) task.exclusive = true
  if (p.boundary) task.boundary = p.boundary
  return task
}

export interface CreateRunOptions {
  /** Reuse the id of a draft (`plan --commit`). */
  id?: string
  name?: string
}

export interface CreatedRun {
  run: RunFile
  tasks: TasksFile
  dir: string
  tickets: string[]
}

/** Builds the run from a plan that already passed the complete validation. */
export async function createRun(ctx: ToolContext, plan: PlanInput, options: CreateRunOptions = {}): Promise<CreatedRun> {
  const { host } = ctx
  const root = await requireRepo(host, ctx.cwd)
  const base = await currentBranch(host, root)
  const useRunBranch = plan.branch !== "current"
  if (!base) throw new ToolError(tr("plan.detached"))
  const head = await git(host, root, ["rev-parse", "--verify", "-q", "HEAD"])
  if (useRunBranch && head.code !== 0)
    throw new ToolError(tr("plan.no_commits"))

  const now = host.now()
  let id = options.id
  if (!id) {
    const slug = options.name || plan.feature || plan.objective || "run"
    do id = runId(slug, now, () => host.random())
    while (await host.stat(runDir(root, id)))
  }
  const dir = runDir(root, id)
  const branch = useRunBranch ? `gt/${id}` : base
  if (useRunBranch && (await branchExists(host, root, branch))) throw new ToolError(tr("plan.branch_exists", { branch }))

  const profiles = plan.profiles ?? DEFAULT_PROFILES
  const run: RunFile = {
    version: 1,
    id,
    feature: plan.feature ?? id.replace(/-\d{6}-[a-z0-9]{4}$/, ""),
    objective: plan.objective ?? "",
    status: "active",
    created: now.toISOString(),
    repo: { root, baseBranch: base, branch },
    worktrees: { policy: "none" },
    serialize: plan.serialize ?? [],
    maxAttempts: plan.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    holdTtl: plan.holdTtl ?? DEFAULT_HOLD_TTL,
    sessions: ctx.session ? [{ tool: ctx.tool, id: ctx.session, boundAt: now.toISOString() }] : [],
  }
  const tasks: TasksFile = {
    version: 1,
    run: id,
    revision: 1,
    profiles,
    tasks: plan.tasks.map((t) => toTask(t, profiles, plan.source)),
  }

  const existed = !!(await host.stat(dir))
  const undo: (() => Promise<unknown>)[] = []
  try {
    const addedExclude = !(await hasExcludeLine(host, root, ".scratch/"))
    await host.mkdir(dir)
    if (!existed) undo.push(() => host.remove(dir, { recursive: true }))
    if (addedExclude) {
      await addExcludeLine(host, root, ".scratch/")
      undo.push(() => removeExcludeLine(host, root, ".scratch/"))
    }
    await atomicWrite(host, join(dir, "run.json"), stringify(run))
    await atomicWrite(host, join(dir, "tasks.json"), stringify(tasks))
    const tickets = await writeTickets(host, dir, tasks)
    if (useRunBranch) {
      await gitOk(host, root, ["switch", "-q", "-c", branch])
      undo.push(async () => {
        await git(host, root, ["switch", "-q", base])
        await git(host, root, ["branch", "-D", branch])
      })
    }
    // Recorded once everything is in place, so a failed plan leaves no ledger lines behind.
    if (!existed)
      await recordEffect(host, dir, { run: id, type: "dir", repo: root, path: dir, undo: { kind: "rmdir" } })
    if (addedExclude)
      await recordEffect(host, dir, {
        run: id,
        type: "exclude",
        repo: root,
        path: ".git/info/exclude",
        line: ".scratch/",
        undo: { kind: "remove-line" },
      })
    if (useRunBranch)
      await recordEffect(host, dir, { run: id, type: "branch", repo: root, ref: branch, from: base, undo: { kind: "git-branch-delete" } })
    await appendLog(host, dir, { at: now.toISOString(), actor: actorOf(ctx), action: "plan", tasks: tasks.tasks.length })
    return { run, tasks, dir, tickets }
  } catch (error) {
    for (const step of undo.reverse()) await step().catch(() => {})
    throw error
  }
}

export function createdText(created: CreatedRun): string {
  const { run, tasks, tickets } = created
  const branch = run.repo.branch === run.repo.baseBranch ? tr("plan.current_branch", { branch: run.repo.branch }) : `branch ${run.repo.branch}`
  return [
    tr("plan.created", { run: run.id, n: tasks.tasks.length, branch }),
    tr("plan.tickets", { n: tickets.length, dir: join(created.dir, "tickets") }),
    tr("plan.next_step"),
  ].join("\n")
}

export async function planFromJson(ctx: ToolContext, raw: unknown, options: CreateRunOptions = {}): Promise<ToolResult> {
  const { plan, errors } = validatePlan(raw, { platform: ctx.host.platform })
  if (errors.length > 0)
    return {
      ok: false,
      code: 1,
      text: `${tr("plan.refused")} ${tr("errors.count", { n: errors.length })}\n${errors.map((e) => `- ${e}`).join("\n")}`,
      data: { errors },
    }
  const created = await createRun(ctx, plan, options)
  return ok(createdText(created), { run: created.run.id, dir: created.dir, tickets: created.tickets, branch: created.run.repo.branch }, { bind: created.run.id })
}

// ── Plan in batches (rev. 5.1): a draft that is not a run yet ─────────────────────────────────────────────────

export interface Draft {
  version: 1
  id: string
  created: string
  feature?: string
  objective?: string
  source?: string
  profiles?: Record<string, Profile>
  serialize?: string[]
  maxAttempts?: number
  holdTtl?: string
  branch?: "run" | "current"
  tasks: PlanTask[]
}

const draftFile = (dir: string) => join(dir, "draft.json")

/** Open drafts of the repository: run folders with a `draft.json` and no `run.json` yet. */
export async function listDrafts(ctx: ToolContext, root: string): Promise<{ id: string; dir: string; draft: Draft }[]> {
  const out: { id: string; dir: string; draft: Draft }[] = []
  for (const entry of await ctx.host.list(runsDir(root))) {
    if (entry.kind !== "dir") continue
    const dir = join(runsDir(root), entry.name)
    if (await ctx.host.stat(join(dir, "run.json"))) continue
    const draft = await readJson<Draft>(ctx.host, draftFile(dir)).catch(() => undefined)
    if (draft) out.push({ id: draft.id, dir, draft })
  }
  return out.sort((a, b) => a.draft.created.localeCompare(b.draft.created))
}

async function resolveDraft(ctx: ToolContext, args: ParsedArgs): Promise<{ root: string; dir: string; draft: Draft }> {
  const root = await requireRepo(ctx.host, ctx.cwd)
  const wanted = typeof args.options.run === "string" ? args.options.run : undefined
  const drafts = await listDrafts(ctx, root)
  if (wanted) {
    const found = drafts.find((d) => d.id === wanted)
    if (!found) throw new ToolError(tr("draft.not_found", { id: wanted }))
    return { root, ...found }
  }
  if (drafts.length === 0) throw new ToolError(tr("draft.none"))
  if (drafts.length > 1)
    throw new ToolError(tr("draft.many", { n: drafts.length, ids: drafts.map((d) => d.id).join(", ") }))
  return { root, ...drafts[0]! }
}

function refused(prefix: string, errors: string[]): ToolResult {
  return { ok: false, code: 1, text: `${prefix} ${tr("errors.count", { n: errors.length })}\n${errors.map((e) => `- ${e}`).join("\n")}`, data: { errors } }
}

function draftPlan(draft: Draft): PlanInput {
  const plan: PlanInput = { tasks: draft.tasks }
  if (draft.feature !== undefined) plan.feature = draft.feature
  if (draft.objective !== undefined) plan.objective = draft.objective
  if (draft.source !== undefined) plan.source = draft.source
  if (draft.profiles !== undefined) plan.profiles = draft.profiles
  if (draft.serialize !== undefined) plan.serialize = draft.serialize
  if (draft.maxAttempts !== undefined) plan.maxAttempts = draft.maxAttempts
  if (draft.holdTtl !== undefined) plan.holdTtl = draft.holdTtl
  if (draft.branch !== undefined) plan.branch = draft.branch
  return plan
}

async function saveDraft(ctx: ToolContext, dir: string, draft: Draft) {
  await atomicWrite(ctx.host, draftFile(dir), stringify(draft))
}

export function draftSummary(draft: Draft): string {
  if (draft.tasks.length === 0) return tr("draft.empty_summary", { id: draft.id })
  const lines = draft.tasks.map((t) => {
    const deps = t.dependsOn?.length ? t.dependsOn.join(", ") : "-"
    const own = t.exclusive ? "exclusive" : t.files?.length ? t.files.join(", ") : "-"
    return tr("draft.line", { id: t.id, title: t.title, deps, own })
  })
  return [tr("draft.summary", { id: draft.id, n: draft.tasks.length }), ...lines].join("\n")
}

async function draftOpen(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const { host } = ctx
  const root = await requireRepo(host, ctx.cwd)
  const open = await listDrafts(ctx, root)
  if (open.length > 0)
    throw new ToolError(
      tr("draft.already_open", { ids: open.map((d) => d.id).join(", ") }),
    )
  const name = typeof args.options.name === "string" ? args.options.name : undefined
  const objective = typeof args.options.objective === "string" ? args.options.objective : undefined
  const source = typeof args.options.source === "string" ? args.options.source : undefined
  const now = host.now()
  let id: string
  do id = runId(name || objective || "run", now, () => host.random())
  while (await host.stat(runDir(root, id)))
  const dir = runDir(root, id)
  const draft: Draft = { version: 1, id, created: now.toISOString(), tasks: [] }
  if (name) draft.feature = name
  if (objective) draft.objective = objective
  if (source) draft.source = source
  const addedExclude = await addExcludeLine(host, root, ".scratch/")
  await host.mkdir(dir)
  await saveDraft(ctx, dir, draft)
  await recordEffect(host, dir, { run: id, type: "dir", repo: root, path: dir, undo: { kind: "rmdir" } })
  if (addedExclude)
    await recordEffect(host, dir, {
      run: id,
      type: "exclude",
      repo: root,
      path: ".git/info/exclude",
      line: ".scratch/",
      undo: { kind: "remove-line" },
    })
  await appendLog(host, dir, { at: now.toISOString(), actor: actorOf(ctx), action: "draft" })
  return ok(tr("draft.opened", { id }), { draft: id, dir })
}

async function draftAdd(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const { dir, draft } = await resolveDraft(ctx, args)
  const raw = await readJsonArg(ctx, args.positionals[0], "json.batch")
  return withLock(ctx.host, dir, async () => {
    const current = (await readJson<Draft>(ctx.host, draftFile(dir))) ?? draft
    const read = readPlan(raw)
    const profiles = read.plan.profiles ?? current.profiles ?? DEFAULT_PROFILES
    const batch = validateBatch(read.plan.tasks, {
      platform: ctx.host.platform,
      profiles,
      existingIds: current.tasks.map((t) => t.id),
    })
    // A batch that changes the profiles must still fit the tasks already in the draft.
    const earlier = read.plan.profiles
      ? current.tasks
          .filter((t) => t.profile !== undefined && !(t.profile in profiles))
          .map((t) => tr("plan.unknown_profile", { id: t.id, profile: t.profile!, profiles: Object.keys(profiles).join(", ") }))
      : []
    const errors = [...read.errors, ...batch.errors, ...earlier]
    if (errors.length > 0) return refused(tr("draft.batch_refused"), errors)
    const next: Draft = { ...current, tasks: [...current.tasks, ...batch.tasks] }
    for (const key of ["feature", "objective", "source", "profiles", "serialize", "maxAttempts", "holdTtl", "branch"] as const)
      if (read.plan[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = read.plan[key]
    await saveDraft(ctx, dir, next)
    const added = batch.tasks.map((t) => t.id).join(", ") || tr("draft.no_tasks")
    return ok(tr("draft.batch_accepted", { n: batch.tasks.length, ids: added, total: next.tasks.length }), {
      draft: next.id,
      added: batch.tasks.map((t) => t.id),
      total: next.tasks.length,
    })
  })
}

async function draftFix(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const fixId = typeof args.options.fix === "string" ? args.options.fix : undefined
  if (!fixId) throw new ToolError(tr("draft.fix_needs_id"), 2)
  const { dir, draft } = await resolveDraft(ctx, args)
  let raw = await readJsonArg(ctx, args.positionals[0], "json.task")
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new ToolError(tr("draft.fix_one"))
    raw = raw[0]
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { id?: unknown }).id === undefined) raw = { ...raw, id: fixId }
  return withLock(ctx.host, dir, async () => {
    const current = (await readJson<Draft>(ctx.host, draftFile(dir))) ?? draft
    const index = current.tasks.findIndex((t) => t.id === fixId)
    if (index < 0) throw new ToolError(tr("draft.no_task", { id: fixId }))
    const read = readPlan([raw])
    const errors = [...read.errors]
    const task = read.plan.tasks[0]
    if (task && task.id !== fixId) errors.push(tr("draft.fix_id_changed", { id: fixId, other: task.id }))
    const batch = validateBatch(read.plan.tasks, {
      platform: ctx.host.platform,
      profiles: current.profiles ?? DEFAULT_PROFILES,
      existingIds: current.tasks.filter((t) => t.id !== fixId).map((t) => t.id),
    })
    errors.push(...batch.errors)
    if (errors.length > 0 || !batch.tasks[0]) return refused(tr("draft.fix_refused", { id: fixId }), errors)
    const tasks = [...current.tasks]
    tasks[index] = batch.tasks[0]
    await saveDraft(ctx, dir, { ...current, tasks })
    return ok(tr("draft.fixed", { id: fixId, n: tasks.length }), { draft: current.id, fixed: fixId })
  })
}

async function draftShow(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const { draft } = await resolveDraft(ctx, args)
  return ok(draftSummary(draft), {
    draft: draft.id,
    tasks: draft.tasks.map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn ?? [], files: t.files ?? [], exclusive: !!t.exclusive })),
  })
}

async function draftCommit(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const { dir, draft } = await resolveDraft(ctx, args)
  return withLock(ctx.host, dir, async () => {
    const current = (await readJson<Draft>(ctx.host, draftFile(dir))) ?? draft
    if (current.tasks.length === 0) throw new ToolError(tr("draft.empty"))
    const { plan, errors } = validatePlan(draftPlan(current), { platform: ctx.host.platform })
    if (errors.length > 0) return refused(tr("draft.commit_refused"), errors)
    const created = await createRun(ctx, plan, { id: current.id })
    await ctx.host.remove(draftFile(dir))
    return ok(
      createdText(created),
      { run: created.run.id, dir: created.dir, tickets: created.tickets, branch: created.run.repo.branch },
      { bind: created.run.id },
    )
  })
}

defineAction("plan", async (ctx, args) => {
  const o = args.options
  if (o.draft) return draftOpen(ctx, args)
  if (o.add) return draftAdd(ctx, args)
  if (o.fix !== undefined) return draftFix(ctx, args)
  if (o.show) return draftShow(ctx, args)
  if (o.commit) return draftCommit(ctx, args)
  const raw = await readJsonArg(ctx, args.positionals[0])
  const name = typeof o.name === "string" ? o.name : undefined
  return planFromJson(ctx, raw, { name })
}, "help.plan")

for (const key of ["help.plan.draft", "help.plan.add", "help.plan.fix", "help.plan.show", "help.plan.commit"]) addUsage(key)

defineAction("runs", async (ctx) => {
  const root = await requireRepo(ctx.host, ctx.cwd)
  const runs = await listRuns(ctx.host, root)
  return ok(formatRunsList(runs), { runs: runs.map((r) => ({ id: r.run.id, status: r.run.status, dir: r.dir })) })
}, "help.runs")

// ── import of Markdown tickets ────────────────────────────────────────────────────────────────────────────────

defineAction(
  "import",
  async (ctx, args) => {
    const arg = args.positionals[0]
    if (!arg) throw new ToolError(tr("import.no_folder"), 2)
    const dir = isAbsolute(arg) ? arg : join(ctx.cwd, arg)
    if ((await ctx.host.stat(dir))?.kind !== "dir") throw new ToolError(tr("path.not_a_folder", { path: arg }))
    const tickets = await readTicketsDir(ctx.host, dir)
    if (!tickets.length) throw new ToolError(tr("import.no_tickets", { dir: arg }))
    const raw = { tasks: tickets.map((t) => t.task) }
    const { plan, errors } = validatePlan(raw, { platform: ctx.host.platform })
    const read = [tr("import.read", { n: tickets.length, dir: arg }), ...tickets.map((t) => `  ${ticketReadLine(t)}`)]
    if (!args.options.yes) {
      const verdict = errors.length
        ? `${tr("import.has_errors", { n: errors.length })}\n${errors.map((e) => `- ${e}`).join("\n")}`
        : tr("import.valid")
      return ok(`${read.join("\n")}\n${verdict}\n${tr("import.check_only")}`, { tickets, errors })
    }
    if (errors.length) return { ok: false, code: 1, text: `${read.join("\n")}\n${tr("import.refused")} ${tr("errors.count", { n: errors.length })}\n${errors.map((e) => `- ${e}`).join("\n")}`, data: { errors } }
    const name = typeof args.options.name === "string" ? args.options.name : basename(dir.replace(/\/issues$/, ""))
    const created = await createRun(ctx, plan, { name })
    return ok(`${read.join("\n")}\n${createdText(created)}`, { run: created.run.id, dir: created.dir, tickets: created.tickets }, { bind: created.run.id })
  },
  "help.import",
)
