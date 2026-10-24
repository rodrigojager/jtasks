// The ownership guard (section 4), the same rule for the Claude Code mod and the OpenCode plugin. It decides from
// tasks.json (files + claimed), without asking jlock on every edit: jlock judges between processes, tasks.json is
// the local copy of the ownership, and `done` reconciles the two.

import { covers } from "./keys.ts"
import { caseInsensitive, isAbsolute, join, normalize, relativeInside, slash } from "./paths.ts"
import type { Task } from "./schema.ts"
import { SCRATCH } from "./store.ts"
import { tr } from "./i18n.ts"

export type Verdict = { allow: true } | { allow: false; reason: string }

const ALLOW: Verdict = { allow: true }

export interface GuardContext {
  /** The repository root. */
  root: string
  platform: string
  /** Where relative paths and commands are resolved from. */
  cwd: string
  /** The task the caller works on; absent for the main agent. */
  task?: Pick<Task, "id" | "files" | "claimed" | "exclusive">
}

/** The path relative to the repository (`/`), or undefined when it lies outside. */
export function repoRelative(ctx: GuardContext, path: string): string | undefined {
  const abs = isAbsolute(path) ? normalize(path) : join(ctx.cwd, path)
  return relativeInside(ctx.root, abs, caseInsensitive(ctx.platform))
}

function owned(ctx: GuardContext, rel: string): boolean {
  const t = ctx.task!
  if (t.exclusive) return true
  const insensitive = caseInsensitive(ctx.platform)
  const p = insensitive ? rel.toLowerCase() : rel
  return [...t.files, ...(t.claimed ?? [])].some((f) => {
    const o = insensitive ? f.toLowerCase() : f
    return o === "." || covers(o, p)
  })
}

const TOOL_FILES = `${SCRATCH}/`

/** An edit (Edit, Write, NotebookEdit, OpenCode's edit/write/patch) of one path. */
export function checkEdit(ctx: GuardContext, path: string): Verdict {
  const rel = repoRelative(ctx, slash(path))
  if (rel === undefined) return ALLOW
  const lower = caseInsensitive(ctx.platform) ? rel.toLowerCase() : rel
  if (lower.startsWith(TOOL_FILES) || lower === SCRATCH)
    return { allow: false, reason: tr("guard.run_files", { rel }) }
  if (!ctx.task || owned(ctx, rel)) return ALLOW
  return { allow: false, reason: tr("guard.outside", { id: ctx.task.id, rel }) }
}

const GIT_MUTATORS = new Set([
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "worktree",
])
const WRITERS = new Set(["rm", "mv", "cp", "del", "erase", "rmdir", "rd", "move", "copy", "touch", "tee", "truncate", "mkdir", "ni", "new-item", "remove-item", "set-content", "out-file"])

/** Splits a shell command into simple commands (`&&`, `||`, `;`, `|`, newlines) and words, keeping quotes. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ""
  let quote: string | null = null
  const push = () => {
    if (cur) words.push(cur)
    cur = ""
  }
  const end = () => {
    push()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === "\n" || c === ";") end()
    else if (c === "&" || c === "|") {
      if (command[i + 1] === c) i++
      end()
    } else if (c === ">") {
      push()
      if (command[i + 1] === ">") i++
      words.push(">")
    } else if (/\s/.test(c)) push()
    else cur += c
  }
  end()
  return segments
}

function gitSubcommand(words: string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree") {
      i++
      continue
    }
    if (w.startsWith("-")) continue
    return w.toLowerCase()
  }
  return undefined
}

/** Paths a simple command writes: redirection targets, and the operands of the common writers. */
function writtenPaths(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) if (words[i] === ">" && words[i + 1]) out.push(words[i + 1]!)
  const plain = words.filter((w, i) => w !== ">" && words[i - 1] !== ">")
  const name = (plain[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase()
  const operands = plain.slice(1).filter((w) => !w.startsWith("-"))
  if (WRITERS.has(name)) out.push(...operands)
  else if (name === "sed" && plain.some((w) => w === "-i" || w.startsWith("-i") || w === "--in-place")) out.push(...operands.slice(1))
  return out.filter((p) => p !== "/dev/null" && p.toLowerCase() !== "nul" && p !== "$null")
}

/** A shell command of a subagent: git mutators always refused; writes outside the ownership refused. */
export function checkShell(ctx: GuardContext, command: string): Verdict {
  for (const words of shellSegments(command)) {
    const exe = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase()
    if (exe === "git") {
      const sub = gitSubcommand(words)
      if (sub && GIT_MUTATORS.has(sub) && ctx.task)
        return { allow: false, reason: tr("guard.git", { sub, id: ctx.task.id }) }
      continue
    }
    for (const p of writtenPaths(words)) {
      const verdict = checkEdit(ctx, p)
      if (!verdict.allow) return verdict
    }
  }
  return ALLOW
}
