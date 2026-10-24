// `tasks plan`: from a validated plan to a run (run.json, tasks.json, tickets, branch, ledger) and `tasks runs`.

import { formatRunsList } from "./format.ts"
import { addExcludeLine, branchExists, currentBranch, git, gitOk, hasExcludeLine, removeExcludeLine, requireRepo } from "./git.ts"
import { runId } from "./ids.ts"
import { recordEffect } from "./ledger.ts"
import { join } from "./paths.ts"
import {
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
import { appendLog, atomicWrite, listRuns, runDir, stringify } from "./store.ts"
import { writeTickets } from "./tickets.ts"
import { defineAction, ok, readJsonArg, ToolError, type ToolContext, type ToolResult } from "./tool.ts"
import { validatePlan } from "./validate.ts"

export function actorOf(ctx: ToolContext): string {
  return ctx.session ? `${ctx.tool}:${ctx.session}` : ctx.tool
}

export function toTask(p: PlanTask, profiles: Record<string, Profile>): Task {
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
  if (!base) throw new ToolError("HEAD está destacado: mude para um branch antes do plan (ou use \"branch\": \"current\")")
  const head = await git(host, root, ["rev-parse", "--verify", "-q", "HEAD"])
  if (useRunBranch && head.code !== 0)
    throw new ToolError("o repositório ainda não tem commits: faça o primeiro commit antes do plan (o branch da execução parte dele)")

  const now = host.now()
  let id = options.id
  if (!id) {
    const slug = options.name || plan.feature || plan.objective || "run"
    do id = runId(slug, now, () => host.random())
    while (await host.stat(runDir(root, id)))
  }
  const dir = runDir(root, id)
  const branch = useRunBranch ? `gt/${id}` : base
  if (useRunBranch && (await branchExists(host, root, branch))) throw new ToolError(`o branch ${branch} já existe`)

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
    sessions: ctx.session ? [{ tool: ctx.tool, id: ctx.session, boundAt: now.toISOString() }] : [],
  }
  const tasks: TasksFile = {
    version: 1,
    run: id,
    revision: 1,
    profiles,
    tasks: plan.tasks.map((t) => toTask(t, profiles)),
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
  const branch = run.repo.branch === run.repo.baseBranch ? `branch atual (${run.repo.branch})` : `branch ${run.repo.branch}`
  return [
    `execução ${run.id} criada: ${tasks.tasks.length} tarefa(s), ${branch}`,
    `tickets: ${tickets.length} em ${join(created.dir, "tickets")}`,
    `próximo passo: tasks next`,
  ].join("\n")
}

export async function planFromJson(ctx: ToolContext, raw: unknown, options: CreateRunOptions = {}): Promise<ToolResult> {
  const { plan, errors } = validatePlan(raw, { platform: ctx.host.platform })
  if (errors.length > 0)
    return {
      ok: false,
      code: 1,
      text: `plano recusado, nada foi gravado. ${errors.length} erro(s):\n${errors.map((e) => `- ${e}`).join("\n")}`,
      data: { errors },
    }
  const created = await createRun(ctx, plan, options)
  return ok(createdText(created), { run: created.run.id, dir: created.dir, tickets: created.tickets, branch: created.run.repo.branch }, { bind: created.run.id })
}

defineAction("plan", async (ctx, args) => {
  const raw = await readJsonArg(ctx, args.positionals[0])
  const name = typeof args.options.name === "string" ? args.options.name : undefined
  return planFromJson(ctx, raw, { name })
}, "plan <json|@arquivo> [--name slug]    cria a execução (tasks.json, tickets, branch gt/<run>)")

defineAction("runs", async (ctx) => {
  const root = await requireRepo(ctx.host, ctx.cwd)
  const runs = await listRuns(ctx.host, root)
  return ok(formatRunsList(runs), { runs: runs.map((r) => ({ id: r.run.id, status: r.run.status, dir: r.dir })) })
}, "runs                                  execuções do repositório, com status e progresso")
