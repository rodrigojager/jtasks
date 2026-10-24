// `tasks gc --scan <root>`: a read-only report of what agent work left behind (worktrees, runs, archived runs).
// Removing takes the explicit path and --yes, and only a path the report itself would list.

import { git } from "./git.ts"
import type { Host } from "./host.ts"
import { recordGlobalEffect } from "./ledger.ts"
import { caseInsensitive, dirname, isAbsolute, join, normalize, slash } from "./paths.ts"
import { readJson } from "./store.ts"
import type { RunFile } from "./schema.ts"
import { defineAction, ok, ToolError, type ToolContext } from "./tool.ts"
import { tr } from "./i18n.ts"

export type FindingType = "worktree" | "run" | "archive"

export interface Finding {
  path: string
  type: FindingType
  bytes: number
  /** True when the size count stopped early (too many files). */
  bytesCapped: boolean
  /** Most recent modification inside, ms since epoch (0 when empty). */
  newest: number
  /** The repository that owns it. */
  owner?: string
  branch?: string
  base?: string
  /** Whether every commit of `branch` is already in `base`. */
  merged?: boolean
  /** For a worktree: whether its repository still lists it (`git worktree list`). */
  known?: boolean
}

const SKIP = new Set(["node_modules", ".git"])
const MAX_FILES = 20_000

async function measure(host: Host, dir: string): Promise<{ bytes: number; newest: number; capped: boolean }> {
  let bytes = 0
  let newest = 0
  let files = 0
  const walk = async (d: string): Promise<boolean> => {
    for (const e of await host.list(d)) {
      if (files >= MAX_FILES) return false
      const p = join(d, e.name)
      if (e.kind === "dir") {
        if (!(await walk(p))) return false
      } else if (e.kind === "file") {
        const s = await host.stat(p)
        files++
        if (s) {
          bytes += s.size
          newest = Math.max(newest, s.mtimeMs)
        }
      }
    }
    return true
  }
  const complete = await walk(dir)
  return { bytes, newest, capped: !complete }
}

async function mainBranch(host: Host, repo: string): Promise<string | undefined> {
  const r = await git(host, repo, ["symbolic-ref", "--short", "-q", "HEAD"])
  return r.code === 0 ? r.stdout.trim() || undefined : undefined
}

async function merged(host: Host, repo: string, branch: string, base: string): Promise<boolean | undefined> {
  const r = await git(host, repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${base}`])
  return r.code === 0 ? true : r.code === 1 ? false : undefined
}

async function worktreeFinding(host: Host, dir: string, gitFile: string): Promise<Finding | undefined> {
  const m = /^gitdir:\s*(.+)$/m.exec(gitFile)
  if (!m) return undefined
  const raw = slash(m[1]!.trim())
  const gitdir = isAbsolute(raw) ? normalize(raw) : join(dir, raw)
  const cut = gitdir.toLowerCase().lastIndexOf("/.git/worktrees/")
  const owner = cut >= 0 ? gitdir.slice(0, cut) : undefined
  const f: Finding = { path: dir, type: "worktree", bytes: 0, bytesCapped: false, newest: 0 }
  if (owner) f.owner = owner
  const head = await host.readText(join(gitdir, "HEAD"))
  const ref = head ? /^ref:\s*refs\/heads\/(.+)$/m.exec(head) : null
  if (ref) f.branch = ref[1]!.trim()
  if (owner && (await host.stat(owner))) {
    const list = await git(host, owner, ["worktree", "list", "--porcelain"])
    const insensitive = caseInsensitive(host.platform)
    const norm = (p: string) => (insensitive ? normalize(p).toLowerCase() : normalize(p))
    f.known = list.code === 0 && list.stdout.split("\n").some((l) => l.startsWith("worktree ") && norm(l.slice(9).trim()) === norm(dir))
    const base = await mainBranch(host, owner)
    if (base) f.base = base
    if (f.branch && base) {
      const isMerged = await merged(host, owner, f.branch, base)
      if (isMerged !== undefined) f.merged = isMerged
    }
  } else f.known = false
  return f
}

async function runFinding(host: Host, dir: string, type: "run" | "archive"): Promise<Finding> {
  const run = await readJson<RunFile>(host, join(dir, "run.json")).catch(() => undefined)
  const f: Finding = { path: dir, type, bytes: 0, bytesCapped: false, newest: 0 }
  if (run?.repo) {
    f.owner = run.repo.root
    f.branch = run.repo.branch
    f.base = run.repo.baseBranch
    if (run.repo.branch !== run.repo.baseBranch && (await host.stat(run.repo.root))) {
      const isMerged = await merged(host, run.repo.root, run.repo.branch, run.repo.baseBranch)
      if (isMerged !== undefined) f.merged = isMerged
    }
  }
  return f
}

/** What one folder is, if it is something the report lists. */
export async function classify(host: Host, dir: string): Promise<Finding | undefined> {
  const git = await host.stat(join(dir, ".git"))
  if (git?.kind === "file") return worktreeFinding(host, dir, (await host.readText(join(dir, ".git"))) ?? "")
  if ((await host.stat(join(dir, "run.json")))?.kind === "file" && (await host.stat(join(dir, "tasks.json")))?.kind === "file") {
    const inRepo = /\/\.scratch\/goal-tasks\/runs$/i.test(dirname(slash(dir)))
    return runFinding(host, dir, inRepo ? "run" : "archive")
  }
  return undefined
}

/** Walks `root` read-only, at most `depth` folders down, never into links, node_modules or .git. */
export async function scan(host: Host, root: string, depth = 4): Promise<Finding[]> {
  const out: Finding[] = []
  const walk = async (dir: string, level: number) => {
    const found = await classify(host, dir)
    if (found) {
      const m = await measure(host, dir)
      out.push({ ...found, bytes: m.bytes, newest: m.newest, bytesCapped: m.capped })
      return
    }
    if (level >= depth) return
    for (const e of await host.list(dir)) if (e.kind === "dir" && !SKIP.has(e.name)) await walk(join(dir, e.name), level + 1)
  }
  await walk(normalize(root), 0)
  return out
}

function size(bytes: number, capped: boolean): string {
  const units = ["B", "KB", "MB", "GB"]
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${capped ? "≥ " : ""}${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}

function age(newest: number, now: number): string {
  if (!newest) return tr("gc.empty")
  const min = Math.max(0, Math.round((now - newest) / 60_000))
  if (min < 60) return `${min} min`
  if (min < 60 * 48) return `${Math.round(min / 60)} h`
  return tr("gc.days", { n: Math.round(min / 1440) })
}

export function findingLine(f: Finding, now: number): string {
  const parts = [f.type, f.path, size(f.bytes, f.bytesCapped), age(f.newest, now)]
  if (f.owner) parts.push(f.type !== "worktree" ? tr("gc.owner", { owner: f.owner }) : tr(f.known ? "gc.owner_known" : "gc.owner_orphan", { owner: f.owner }))
  if (f.branch) parts.push(`branch ${f.branch}`)
  if (f.merged !== undefined) parts.push(tr(f.merged ? "gc.merged_yes" : "gc.merged_no", { base: f.base ?? "" }))
  return parts.join(" · ")
}

defineAction(
  "gc",
  async (ctx, args) => {
    const { host } = ctx
    const now = host.now().getTime()
    const resolve = (p: string) => normalize(isAbsolute(p) ? p : join(ctx.cwd, p))
    if (typeof args.options.remove === "string") return removeFound(ctx, resolve(args.options.remove), !!args.options.yes)
    const raw = typeof args.options.scan === "string" ? args.options.scan : args.positionals[0]
    if (!raw) throw new ToolError(tr("gc.usage"), 2)
    const root = resolve(raw)
    if ((await host.stat(root))?.kind !== "dir") throw new ToolError(tr("path.not_a_folder", { path: raw }))
    const depth = typeof args.options.depth === "string" ? Number(args.options.depth) : 4
    if (!(depth >= 0)) throw new ToolError(tr("gc.bad_depth", { depth: String(args.options.depth) }), 2)
    const found = await scan(host, root, depth)
    const lines = [tr("gc.header", { root, depth, n: found.length })]
    for (const f of found) lines.push(`  ${findingLine(f, now)}`)
    lines.push(tr(found.length ? "gc.untouched" : "gc.nothing"))
    return ok(lines.join("\n"), { root, depth, findings: found })
  },
  "help.gc",
)

async function removeFound(ctx: ToolContext, path: string, yes: boolean) {
  const { host } = ctx
  const found = await classify(host, path)
  if (!found) throw new ToolError(tr("gc.not_listed", { path }))
  if (!yes) throw new ToolError(tr("gc.confirm", { path }))
  let how = tr("gc.folder_removed")
  if (found.type === "worktree" && found.known && found.owner) {
    const r = await git(host, found.owner, ["worktree", "remove", path])
    if (r.code !== 0) throw new ToolError(tr("gc.worktree_refused", { message: (r.stderr || r.stdout).trim() }))
    how = tr("gc.worktree_removed", { owner: found.owner })
  } else await host.remove(path, { recursive: true })
  await recordGlobalEffect(host, { run: "gc", type: "dir", repo: found.owner ?? dirname(path), path, undo: { kind: "none" } })
  return ok(tr("gc.removed", { type: found.type, path, how }), { removed: path, type: found.type })
}
