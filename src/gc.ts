// `tasks gc --scan <root>`: a read-only report of what agent work left behind (worktrees, runs, archived runs).
// Removing takes the explicit path and --yes, and only a path the report itself would list.

import { git } from "./git.ts"
import type { Host } from "./host.ts"
import { recordGlobalEffect } from "./ledger.ts"
import { caseInsensitive, dirname, isAbsolute, join, normalize, slash } from "./paths.ts"
import { readJson } from "./store.ts"
import type { RunFile } from "./schema.ts"
import { defineAction, ok, ToolError, type ToolContext } from "./tool.ts"

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
  if (!newest) return "vazia"
  const min = Math.max(0, Math.round((now - newest) / 60_000))
  if (min < 60) return `${min} min`
  if (min < 60 * 48) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 1440)} dias`
}

export function findingLine(f: Finding, now: number): string {
  const parts = [f.type, f.path, size(f.bytes, f.bytesCapped), age(f.newest, now)]
  if (f.owner) parts.push(`dono ${f.owner}${f.type === "worktree" ? (f.known ? " (registrada)" : " (o repositório não a conhece: órfã)") : ""}`)
  if (f.branch) parts.push(`branch ${f.branch}`)
  if (f.merged !== undefined) parts.push(`integrado em ${f.base}: ${f.merged ? "sim" : "não"}`)
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
    if (!raw) throw new ToolError("use tasks gc --scan <raiz> (relatório) ou tasks gc --remove <caminho> --yes", 2)
    const root = resolve(raw)
    if ((await host.stat(root))?.kind !== "dir") throw new ToolError(`não é uma pasta: ${raw}`)
    const depth = typeof args.options.depth === "string" ? Number(args.options.depth) : 4
    if (!(depth >= 0)) throw new ToolError(`--depth inválido: ${args.options.depth}`, 2)
    const found = await scan(host, root, depth)
    const lines = [`gc --scan ${root} (profundidade ${depth}, só leitura): ${found.length} achado(s)`]
    for (const f of found) lines.push(`  ${findingLine(f, now)}`)
    lines.push(found.length ? "nada foi tocado; remover: tasks gc --remove <caminho> --yes" : "nada a relatar")
    return ok(lines.join("\n"), { root, depth, findings: found })
  },
  "gc --scan <raiz> [--depth 4]          relatório só leitura: worktrees órfãs, execuções, arquivos",
)

async function removeFound(ctx: ToolContext, path: string, yes: boolean) {
  const { host } = ctx
  const found = await classify(host, path)
  if (!found) throw new ToolError(`${path} não é algo que o relatório do gc lista (worktree, execução ou arquivo de execução); nada foi removido`)
  if (!yes) throw new ToolError(`nada foi removido: confirme com tasks gc --remove ${path} --yes`)
  let how = "pasta removida"
  if (found.type === "worktree" && found.known && found.owner) {
    const r = await git(host, found.owner, ["worktree", "remove", path])
    if (r.code !== 0) throw new ToolError(`git worktree remove recusou: ${(r.stderr || r.stdout).trim()} (mudanças não salvas?); nada foi removido`)
    how = `git worktree remove em ${found.owner}`
  } else await host.remove(path, { recursive: true })
  await recordGlobalEffect(host, { run: "gc", type: "dir", repo: found.owner ?? dirname(path), path, undo: { kind: "none" } })
  return ok(`${found.type} removida: ${path} (${how}); registrado no ledger global`, { removed: path, type: found.type })
}
