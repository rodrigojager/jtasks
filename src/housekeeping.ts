// Cleaning and archiving (section 11): a finished run leaves the project without a treasure hunt.

import { requireRepo } from "./git.ts"
import type { Host } from "./host.ts"
import { slugify } from "./ids.ts"
import { effectLine, effectsOf, recordEffect, setEffectState, type Effect } from "./ledger.ts"
import { basename, caseInsensitive, join } from "./paths.ts"
import { jtasksHome, readTasks, runDir, runsDir, SCRATCH } from "./store.ts"
import { defineAction, ok, ToolError, type ToolContext } from "./tool.ts"
import { tr } from "./i18n.ts"

export function archiveDir(host: Host, root: string, run: string): string {
  return join(jtasksHome(host), "archive", slugify(basename(root), 40), run)
}

/** Copies a folder of text files (a run's files are all text). */
async function copyTree(host: Host, from: string, to: string): Promise<void> {
  await host.mkdir(to)
  for (const e of await host.list(from)) {
    if (e.kind === "dir") await copyTree(host, join(from, e.name), join(to, e.name))
    else if (e.kind === "file") await host.writeText(join(to, e.name), (await host.readText(join(from, e.name))) ?? "")
  }
}

/** Moves a folder; across drives (where rename cannot) by copy and removal. */
export async function moveDir(host: Host, from: string, to: string): Promise<void> {
  try {
    await host.rename(from, to)
  } catch {
    await copyTree(host, from, to)
    await host.remove(from, { recursive: true })
  }
}

async function runningTasks(host: Host, dir: string): Promise<string[]> {
  const tasks = await readTasks(host, dir).catch(() => undefined)
  return tasks?.tasks.filter((t) => t.status === "in_progress").map((t) => t.id) ?? []
}

/** Effects still active that outlive the folder (branch, exclude line…), with the command that undoes each. */
async function survivors(ctx: ToolContext, root: string, run: string): Promise<Effect[]> {
  const all = await effectsOf(ctx.host, { repo: root, run }, caseInsensitive(ctx.host.platform))
  return all.filter((e) => e.state === "active" && e.type !== "dir" && e.type !== "commit")
}

defineAction(
  "clean",
  async (ctx, args) => {
    const { host } = ctx
    const root = await requireRepo(host, ctx.cwd)
    const all = !!args.options.all
    const id = args.positionals[0] ?? (typeof args.options.run === "string" ? args.options.run : undefined)
    if (!all && !id) throw new ToolError(tr("clean.which"), 2)
    const ids = all ? (await host.list(runsDir(root))).filter((e) => e.kind === "dir").map((e) => e.name) : [id!]
    for (const r of ids) if (!(await host.stat(runDir(root, r)))) throw new ToolError(tr("run.not_in", { run: r, dir: runsDir(root) }))
    const lines: string[] = []
    const busy: string[] = []
    const left: Effect[] = []
    for (const r of ids) {
      const running = await runningTasks(host, runDir(root, r))
      if (running.length) busy.push(`${r} (${running.join(", ")})`)
      left.push(...(await survivors(ctx, root, r)))
    }
    const target = all ? join(root, SCRATCH) : runDir(root, id!)
    lines.push(all ? tr("clean.delete_all", { target, n: ids.length }) : tr("clean.delete", { target }))
    if (left.length) {
      lines.push(tr("clean.effects"))
      for (const e of left) lines.push(`  ${effectLine(e)}  →  tasks undo ${e.id} --run ${e.run}`)
    }
    if (busy.length) throw new ToolError(`${lines.join("\n")}\n${tr("clean.busy", { tasks: busy.join(", ") })}`)
    if (!args.options.yes) {
      lines.push(tr("clean.confirm", { which: all ? "--all" : id! }))
      return ok(lines.join("\n"), { target, effects: left, removed: false })
    }
    const dirs = []
    for (const r of ids) {
      const all = await effectsOf(host, { repo: root, run: r }, caseInsensitive(host.platform))
      dirs.push(...all.filter((e) => e.type === "dir" && e.state === "active"))
    }
    await host.remove(target, { recursive: true })
    for (const e of dirs) await setEffectState(host, runDir(root, e.run), e.run, e.id, "undone")
    lines.push(tr("clean.deleted", { target }))
    return ok(lines.join("\n"), { target, effects: left, removed: true })
  },
  "help.clean",
)

defineAction(
  "archive",
  async (ctx, args) => {
    const { host } = ctx
    const root = await requireRepo(host, ctx.cwd)
    const id = args.positionals[0] ?? (typeof args.options.run === "string" ? args.options.run : undefined)
    if (!id) throw new ToolError(tr("archive.which"), 2)
    const dir = runDir(root, id)
    if (!(await host.stat(dir))) throw new ToolError(tr("run.not_in", { run: id, dir: runsDir(root) }))
    const running = await runningTasks(host, dir)
    if (running.length) throw new ToolError(tr("archive.busy", { run: id, tasks: running.join(", ") }))
    const to = archiveDir(host, root, id)
    if (await host.stat(to)) throw new ToolError(tr("archive.exists", { run: id, to }))
    // Recorded first, so the archived run's own ledger carries it.
    const effect = await recordEffect(host, dir, { run: id, type: "archive", repo: root, path: dir, to, undo: { kind: "unarchive" } })
    try {
      await moveDir(host, dir, to)
    } catch (error) {
      await setEffectState(host, dir, id, effect.id, "undone")
      throw error
    }
    return ok(tr("archive.done", { run: id, to }), { run: id, to })
  },
  "help.archive",
)

/** Brings an archived run back into the repository (`resume <run> --from-archive`). */
export async function unarchive(ctx: ToolContext, run: string): Promise<string> {
  const { host } = ctx
  const root = await requireRepo(host, ctx.cwd)
  const from = archiveDir(host, root, run)
  if (!(await host.stat(from))) throw new ToolError(tr("archive.none", { run, from }))
  const dir = runDir(root, run)
  if (await host.stat(dir)) throw new ToolError(tr("archive.already", { run, dir }))
  await moveDir(host, from, dir)
  const archived = (await effectsOf(host, { repo: root, run }, caseInsensitive(host.platform))).filter(
    (e) => e.type === "archive" && e.state === "active",
  )
  for (const e of archived) await setEffectState(host, dir, run, e.id, "undone")
  return tr("archive.back", { run, from })
}
