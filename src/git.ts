// Git, always as a process (`git` in PATH), always in the repository root.

import type { Host, RunResult } from "./host.ts"
import { isAbsolute, join, slash } from "./paths.ts"
import { ToolError } from "./tool.ts"

export async function git(host: Host, cwd: string, args: string[], stdin?: string): Promise<RunResult> {
  return host.run(["git", ...args], { cwd, stdin, env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } })
}

/** Runs git and throws a ToolError with git's own message when it fails. */
export async function gitOk(host: Host, cwd: string, args: string[], stdin?: string): Promise<string> {
  const r = await git(host, cwd, args, stdin)
  if (r.code !== 0) throw new ToolError(`git ${args[0]} falhou: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

/** The repository's root, or `undefined` outside a git repository. */
export async function repoRoot(host: Host, cwd: string): Promise<string | undefined> {
  const r = await git(host, cwd, ["rev-parse", "--show-toplevel"])
  if (r.code !== 0) return undefined
  return slash(r.stdout.trim())
}

export async function requireRepo(host: Host, cwd: string): Promise<string> {
  const root = await repoRoot(host, cwd)
  if (!root) throw new ToolError(`não é um repositório git: ${cwd} (o goal-tasks faz um commit por tarefa)`)
  return root
}

/** The current branch name, or `undefined` with a detached HEAD. Works before the first commit. */
export async function currentBranch(host: Host, root: string): Promise<string | undefined> {
  const r = await git(host, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  const name = r.stdout.trim()
  return r.code === 0 && name ? name : undefined
}

export async function branchExists(host: Host, root: string, branch: string): Promise<boolean> {
  const r = await git(host, root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])
  return r.code === 0
}

/** `.git/info/exclude` (or wherever git keeps it for this repository). */
export async function excludeFile(host: Host, root: string): Promise<string> {
  const p = slash((await gitOk(host, root, ["rev-parse", "--git-path", "info/exclude"])).trim())
  return isAbsolute(p) ? p : join(root, p)
}

export async function hasExcludeLine(host: Host, root: string, line: string): Promise<boolean> {
  const text = (await host.readText(await excludeFile(host, root))) ?? ""
  return text.split(/\r?\n/).some((l) => l.trim() === line)
}

export async function addExcludeLine(host: Host, root: string, line: string): Promise<boolean> {
  const file = await excludeFile(host, root)
  const text = (await host.readText(file)) ?? ""
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return false
  const sep = text === "" || text.endsWith("\n") ? "" : "\n"
  await host.writeText(file, `${text}${sep}${line}\n`)
  return true
}

export async function removeExcludeLine(host: Host, root: string, line: string): Promise<boolean> {
  const file = await excludeFile(host, root)
  const text = await host.readText(file)
  if (text === undefined) return false
  const lines = text.split(/\r?\n/)
  const kept = lines.filter((l) => l.trim() !== line)
  if (kept.length === lines.length) return false
  await host.writeText(file, kept.join("\n"))
  return true
}

export interface StatusEntry {
  /** Two-letter porcelain code (`M `, `??`, `R `…). */
  code: string
  path: string
}

/** `git status --porcelain` with untracked files, one entry per path (renames give both sides). */
export async function status(host: Host, root: string): Promise<StatusEntry[]> {
  const out = await gitOk(host, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const parts = out.split("\0").filter((p) => p !== "")
  const entries: StatusEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const code = part.slice(0, 2)
    entries.push({ code, path: part.slice(3) })
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = parts[++i]
      if (from) entries.push({ code, path: from })
    }
  }
  return entries
}

export async function shortHead(host: Host, root: string): Promise<string> {
  return (await gitOk(host, root, ["rev-parse", "--short", "HEAD"])).trim()
}

export async function commitExists(host: Host, root: string, ref: string): Promise<boolean> {
  return (await git(host, root, ["cat-file", "-e", `${ref}^{commit}`])).code === 0
}

/** True when every commit of `branch` is already in `base`. */
export async function isMerged(host: Host, root: string, branch: string, base: string): Promise<boolean> {
  return (await git(host, root, ["merge-base", "--is-ancestor", branch, base])).code === 0
}

/** True when some branch still contains the commit (an object left after its branch was deleted does not count). */
export async function commitReachable(host: Host, root: string, ref: string): Promise<boolean> {
  if (!(await commitExists(host, root, ref))) return false
  const r = await git(host, root, ["branch", "--all", "--contains", ref, "--format=%(refname)"])
  return r.code === 0 && r.stdout.trim() !== ""
}
