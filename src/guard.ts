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
  /** The host's home (`HOME`, or `USERPROFILE`): what `~` and `$HOME` stand for in a shell command. */
  home?: string
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

// ── The shell, as far as the guard reads it (rev. 5.6) ───────────────────────────────────────────────────────────

/** One piece of a word: its text and how it was quoted (variables expand outside single quotes only). */
interface Part {
  text: string
  quote: "" | "'" | '"'
  /** A `$(…)` or a backquote: never resolved. */
  substitution?: boolean
}

type Token = { kind: "word"; parts: Part[] } | { kind: "op"; op: string; fd?: string } | { kind: "sep" }

/** Characters that end an unquoted word. */
const BREAKS = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"])

/** The command line as words, redirections and separators; heredoc bodies are skipped (they are data, not commands). */
function lex(command: string): Token[] {
  const out: Token[] = []
  const heredocs: { delimiter: string; strip: boolean }[] = []
  const n = command.length
  let i = 0

  const readWord = (): Part[] => {
    const parts: Part[] = []
    let cur = ""
    const flush = () => {
      if (cur) parts.push({ text: cur, quote: "" })
      cur = ""
    }
    while (i < n) {
      const c = command[i]!
      if (BREAKS.has(c)) break
      if (c === "\\") {
        cur += command[i + 1] === "\n" ? "" : (command[i + 1] ?? "")
        i += 2
        continue
      }
      if (c === "'") {
        flush()
        const end = command.indexOf("'", i + 1)
        parts.push({ text: command.slice(i + 1, end < 0 ? n : end), quote: "'" })
        i = end < 0 ? n : end + 1
        continue
      }
      if (c === '"') {
        flush()
        let text = ""
        let substitution = false
        i++
        while (i < n && command[i] !== '"') {
          if (command[i] === "\\" && i + 1 < n && '$`"\\'.includes(command[i + 1]!)) {
            text += command[i + 1]
            i += 2
            continue
          }
          if (command[i] === "`" || (command[i] === "$" && command[i + 1] === "(")) substitution = true
          text += command[i++]
        }
        i++
        parts.push(substitution ? { text, quote: '"', substitution } : { text, quote: '"' })
        continue
      }
      if (c === "`" || (c === "$" && command[i + 1] === "(")) {
        flush()
        const start = i
        if (c === "`") {
          const end = command.indexOf("`", i + 1)
          i = end < 0 ? n : end + 1
        } else {
          let depth = 0
          for (; i < n; i++) {
            if (command[i] === "(") depth++
            else if (command[i] === ")" && --depth === 0) break
          }
          i++
        }
        parts.push({ text: command.slice(start, i), quote: "", substitution: true })
        continue
      }
      cur += c
      i++
    }
    flush()
    return parts
  }

  // At a newline: the bodies of the heredocs opened on that line, each up to its delimiter line.
  const skipHeredocs = () => {
    for (const h of heredocs.splice(0))
      while (i < n) {
        const eol = command.indexOf("\n", i)
        const line = command.slice(i, eol < 0 ? n : eol)
        i = eol < 0 ? n : eol + 1
        if ((h.strip ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === h.delimiter) break
      }
  }

  while (i < n) {
    const c = command[i]!
    if (c === "\n") {
      out.push({ kind: "sep" })
      i++
      skipHeredocs()
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    if (c === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      // A comment runs to the end of the line.
      const eol = command.indexOf("\n", i)
      i = eol < 0 ? n : eol
      continue
    }
    if (c === ";" || c === "(" || c === ")") {
      out.push({ kind: "sep" })
      i++
      continue
    }
    if (c === "&" && command[i + 1] === ">") {
      // `&>` and `&>>`: both streams to a file.
      i += command[i + 2] === ">" ? 3 : 2
      out.push({ kind: "op", op: ">" })
      continue
    }
    if (c === "&" || c === "|") {
      i += command[i + 1] === c ? 2 : 1
      out.push({ kind: "sep" })
      continue
    }
    // A redirection, with the descriptor it may start with (`2>`, `2>&1`).
    const redir = /^(\d*)(>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(command.slice(i))
    if (redir && (redir[1] === "" || i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      i += redir[0].length
      const op = redir[2]!
      out.push(redir[1] ? { kind: "op", op, fd: redir[1] } : { kind: "op", op })
      if (op === "<<" || op === "<<-") {
        while (command[i] === " " || command[i] === "\t") i++
        const word = readWord()
        heredocs.push({ delimiter: word.map((p) => p.text).join(""), strip: op === "<<-" })
        out.push({ kind: "word", parts: word })
      }
      continue
    }
    out.push({ kind: "word", parts: readWord() })
  }
  return out
}

/** Splits a shell command into simple commands and words, quotes taken off (`>` stands for an output redirection). */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  for (const t of lex(command)) {
    if (t.kind === "sep") {
      if (words.length) segments.push(words)
      words = []
    } else if (t.kind === "op") words.push(t.op.startsWith(">") ? ">" : t.op)
    else words.push(t.parts.map((p) => p.text).join(""))
  }
  if (words.length) segments.push(words)
  return segments
}

/** A word after expansion: its text, or `unresolved` with the literal prefix before what could not be resolved. */
interface Expanded {
  text: string
  raw: string
  unresolved: boolean
  prefix: string
}

const VAR = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|[0-9@*#?$!{-])/g

/** A word with the variables it can resolve expanded (`$X`, `${X}`, `~`), as the shell would. */
function expand(parts: Part[], vars: Map<string, string | undefined>): Expanded {
  let text = ""
  let unresolved = false
  let prefix = ""
  const raw = parts.map((p) => (p.quote ? `${p.quote}${p.text}${p.quote}` : p.text)).join("")
  const stop = () => {
    prefix = text
    unresolved = true
  }
  parts.forEach((p, index) => {
    if (unresolved) return
    if (p.substitution) return stop()
    if (p.quote === "'") {
      text += p.text
      return
    }
    let body = p.text
    // `~` at the start of the word, unquoted: the host's home.
    if (index === 0 && p.quote === "" && (body === "~" || body.startsWith("~/"))) {
      const home = vars.get("HOME")
      if (home === undefined) return stop()
      body = home + body.slice(1)
    }
    let last = 0
    for (const m of body.matchAll(VAR)) {
      text += body.slice(last, m.index)
      last = m.index! + m[0].length
      const name = m[1] ?? m[2]
      const value = name ? vars.get(name) : undefined
      if (value === undefined) return stop()
      text += value
    }
    const rest = body.slice(last)
    // An unquoted glob is a pattern the shell expands: it cannot be checked as one path.
    const glob = p.quote === "" ? rest.search(/[*?[]/) : -1
    if (glob >= 0) {
      text += rest.slice(0, glob)
      return stop()
    }
    text += rest
  })
  return { text, raw, unresolved, prefix }
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/
const DECLARERS = new Set(["export", "local", "declare", "typeset", "readonly"])

/** `NAME=value` as a word: the name and the value expanded, or undefined when the word is no assignment. */
function assignment(word: Part[], vars: Map<string, string | undefined>): [string, string | undefined] | undefined {
  const head = word[0]
  const m = head && head.quote === "" ? ASSIGN.exec(head.text) : null
  if (!m) return undefined
  const value = expand([{ ...head!, text: head!.text.slice(m[0].length) }, ...word.slice(1)], vars)
  return [m[1]!, value.unresolved ? undefined : value.text]
}

/** Options that take a value, per writer: the value is no path the command writes. */
const VALUED: Record<string, Set<string>> = {
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  mkdir: new Set(["-m", "--mode"]),
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  touch: new Set(["-d", "--date", "-t", "-r", "--reference"]),
}

/** What a writer writes: every operand; for `cp`/`copy` only the destination (`-t` names it too). */
function writerTargets(name: string, args: Expanded[]): Expanded[] {
  const valued = VALUED[name] ?? new Set<string>()
  const operands: Expanded[] = []
  let target: Expanded | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.text === "--") {
      operands.push(...args.slice(i + 1))
      break
    }
    if (a.text.startsWith("-") && a.text.length > 1 && !a.unresolved) {
      const eq = a.text.indexOf("=")
      const flag = eq > 0 ? a.text.slice(0, eq) : a.text
      if ((name === "cp" || name === "mv") && (flag === "-t" || flag === "--target-directory"))
        target = eq > 0 ? { ...a, text: a.text.slice(eq + 1) } : args[i + 1]
      if (valued.has(flag) && eq < 0) i++
      continue
    }
    operands.push(a)
  }
  if (name === "cp" || name === "copy") return target ? [target] : operands.slice(-1)
  return target ? [target, ...operands] : operands
}

/** The files `sed` edits in place (`-i`, `-i.bak`, `-ni`, `--in-place[=suf]`, BSD's `-i ''`), past its script or `-e`/`-f`. */
function sedTargets(args: Expanded[]): Expanded[] {
  let inPlace = false
  let script = false
  const operands: Expanded[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text
    if (a === "--") {
      operands.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      if (a === "--in-place" || a.startsWith("--in-place=")) inPlace = true
      else if (a === "--expression" || a === "--file") {
        script = true
        i++
      } else if (a.startsWith("--expression=") || a.startsWith("--file=")) script = true
      else if (a === "--line-length") i++
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      // A group of short flags: `-n`, `-E`, `-ni`, `-i.bak` (what follows `i` is its suffix), `-e SCRIPT`.
      for (let k = 1; k < a.length; k++) {
        const f = a[k]!
        if (f === "i") {
          inPlace = true
          if (k === a.length - 1 && args[i + 1]?.text === "" && !args[i + 1]!.unresolved) i++
          break
        }
        if (f === "e" || f === "f" || f === "l") {
          if (f !== "l") script = true
          if (k === a.length - 1) i++
          break
        }
      }
      continue
    }
    operands.push(args[i]!)
  }
  if (!inPlace) return []
  return script ? operands : operands.slice(1)
}

const NOT_FILES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"])

/** A written path as the guard judges it: literal (`path`, from `cwd`), or not checkable (`raw`, its literal `prefix`). */
type Written = { path: string; cwd: string } | { raw: string; prefix: string }

/** Every path a command line writes (redirection targets, the operands of the common writers) and its git calls. */
function writes(command: string, home: string | undefined, startCwd: string): { written: Written[]; git: string[][] } {
  const vars = new Map<string, string | undefined>()
  if (home !== undefined) vars.set("HOME", home)
  let cwd: string | undefined = startCwd
  const written: Written[] = []
  const git: string[][] = []
  const tokens = lex(command)
  let k = 0
  while (k < tokens.length) {
    // One simple command: up to the next separator.
    const words: Part[][] = []
    const redirects: { op: string; target?: Part[] }[] = []
    for (; k < tokens.length && tokens[k]!.kind !== "sep"; k++) {
      const t = tokens[k]!
      if (t.kind === "word") words.push(t.parts)
      else if (t.kind === "op") {
        const next = tokens[k + 1]
        if (next?.kind === "word") k++
        redirects.push({ op: t.op, target: next?.kind === "word" ? next.parts : undefined })
      }
    }
    k++
    // Leading assignments: for this command (`S=… cmd`), and for the rest of the line when they stand alone.
    const local = new Map(vars)
    let first = 0
    for (; first < words.length; first++) {
      const a = assignment(words[first]!, local)
      if (!a) break
      local.set(a[0], a[1])
    }
    if (first === words.length) for (const [name, value] of local) vars.set(name, value)
    const args = words.slice(first).map((w) => expand(w, local))
    const name = (args[0]?.text ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase()
    if (DECLARERS.has(name))
      for (const w of words.slice(first + 1)) {
        const a = assignment(w, vars)
        if (a) vars.set(a[0], a[1])
      }
    const add = (e: Expanded) => {
      if (NOT_FILES.has(e.raw.toLowerCase()) || NOT_FILES.has(e.text.toLowerCase())) return
      if (e.unresolved) written.push({ raw: e.raw, prefix: e.prefix })
      else if (cwd === undefined && !isAbsolute(e.text)) written.push({ raw: e.raw, prefix: "" })
      else written.push({ path: e.text, cwd: cwd ?? startCwd })
    }
    for (const r of redirects) {
      if (!r.target) continue
      // Writes: `>`, `>>`, `>|`, `<>`; `>&` only to a file (not to a descriptor: `2>&1`, `>&-`).
      const target = expand(r.target, local)
      if (r.op === ">" || r.op === ">>" || r.op === ">|" || r.op === "<>") add(target)
      else if (r.op === ">&" && !/^(\d+|-)$/.test(target.text)) add(target)
    }
    if (name === "git") git.push(args.map((a) => a.text))
    else if (name === "cd") {
      const to = args[1]
      if (!to) cwd = home ?? cwd
      else if (to.unresolved || cwd === undefined) cwd = undefined
      else cwd = isAbsolute(to.text) ? normalize(to.text) : join(cwd, to.text)
    } else if (name === "sed") for (const t of sedTargets(args.slice(1))) add(t)
    else if (WRITERS.has(name)) for (const t of writerTargets(name, args.slice(1))) add(t)
  }
  return { written, git }
}

/**
 * Whether a path that could not be resolved is plainly outside the repository: its literal prefix is absolute and
 * its folder lies neither inside the root nor above it (`/tmp/$X/f` yes; `/home/$U/…`, `$X/f` or `src/$F` no).
 */
function plainlyOutside(ctx: GuardContext, prefix: string): boolean {
  const p = slash(prefix)
  if (!isAbsolute(p) || /(^|\/)\.\.(\/|$)/.test(p)) return false
  const dir = p.slice(0, p.lastIndexOf("/"))
  if (!dir || /^[A-Za-z]:$/.test(dir)) return false
  const insensitive = caseInsensitive(ctx.platform)
  return relativeInside(ctx.root, dir, insensitive) === undefined && relativeInside(dir, ctx.root, insensitive) === undefined
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

/**
 * A shell command: git mutators of a subagent always refused; writes outside the ownership refused. Variables the
 * command assigns itself (`S=/tmp/x; … > $S/f`, `export S=…`, `S=… cmd`), `~` and `$HOME` (the host's) are expanded,
 * `cd` is followed, heredoc bodies are data, and `sed -i` writes only its files. A path that still has a variable, a
 * substitution or a glob cannot be checked: allowed when it is plainly outside the repository, refused otherwise with
 * `guard.unresolved` (never a `claim` of a path with `$`).
 */
export function checkShell(ctx: GuardContext, command: string): Verdict {
  const { written, git } = writes(command, ctx.home, ctx.cwd)
  for (const words of git) {
    const sub = gitSubcommand(words)
    if (sub && GIT_MUTATORS.has(sub) && ctx.task) return { allow: false, reason: tr("guard.git", { sub, id: ctx.task.id }) }
  }
  for (const w of written) {
    if ("raw" in w) {
      if (!ctx.task || plainlyOutside(ctx, w.prefix)) continue
      return { allow: false, reason: tr("guard.unresolved", { id: ctx.task.id, raw: w.raw }) }
    }
    const verdict = checkEdit({ ...ctx, cwd: w.cwd }, w.path)
    if (!verdict.allow) return verdict
  }
  return ALLOW
}
