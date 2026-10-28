// The `jtasks` tool: one contract for the CLI, the Claude Code mod and the OpenCode plugin. Each form turns its
// input into an argument list (the CLI's own argv, or the tool's `command` string split like a shell would) plus an
// optional structured `json`, and gets back `{ ok, code, text, data }`.

import type { Host, Resident } from "./host.ts"
import type { HoldMode } from "./jlock.ts"
import { isAbsolute, join } from "./paths.ts"
import type { ToolName } from "./schema.ts"
import { readTicketsDir } from "./tickets.ts"
import { validatePlan } from "./validate.ts"
import { select, systemLocale, tr } from "./i18n.ts"
import { jlockNotice } from "./setup.ts"

export const VERSION = "0.3.1"

export interface ToolContext {
  host: Host
  /** Where the command runs: the repository or a folder inside it. */
  cwd: string
  tool: ToolName
  /** The folder the tool was installed from (the CLI's repository): where `doctor --fix` copies agents and skills from. */
  packageRoot?: string
  /** The language the host asks for (its own setting); `--lang` and JTASKS_LANG win over it. */
  lang?: string
  /** Session id of the mod or the plugin; absent in the CLI. */
  session?: string
  /** The run bound to the session (mod, plugin), or chosen by `--run`/`JTASKS_RUN`. */
  boundRun?: string
  /** A structured payload (the mod's and the plugin's `json` field); wins over a JSON argument. */
  json?: unknown
  /** Standard input of the CLI, for a `-` argument. */
  stdin?: () => Promise<string>
  /** The subagent calling, when the host knows it (owner becomes `<tool>:<session>/agent:<id>`). */
  agent?: string
  /**
   * The `jlock hold` processes this host keeps alive, by `<run>/<task>`. Present in a long-lived host (plugin, mod,
   * tests): holds stay attached and are told to stop through standard input. Absent in the CLI, whose process ends
   * after each command: holds are then detached and given back with `jlock release --group --owner`.
   */
  residents?: Map<string, Resident[]>
  /**
   * How this host holds a task's locks: `detach` (the CLI and the mod: `jlock hold --detach`, one call, the jlock
   * keeper outlives the process) or `eof` (the plugin: `jlock hold --release-on-eof` kept alive with its standard
   * input open, so the host dying frees the lock at once). Absent: `eof` when `residents` is given, else `detach`.
   */
  holdMode?: HoldMode
  /** Called when a hold of this host ends by itself (14: the lock was taken away). Set by long-lived hosts. */
  onHoldExit?: (run: string, task: string, code: number) => void
}

export interface ToolResult {
  ok: boolean
  /** Exit code for the CLI: 0 ok, 1 refused or invalid, 2 wrong usage. */
  code: number
  text: string
  data?: unknown
  /** Set when the action binds a run to the session (`plan`, `resume`). */
  bind?: string
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code = 1,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export interface ParsedArgs {
  action: string
  positionals: string[]
  options: Record<string, string | true>
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set([
  "json",
  "draft",
  "show",
  "commit",
  "check",
  "yes",
  "all",
  "all-failed",
  "keep-owners",
  "from-archive",
  "all-projects",
  "force",
  "help",
  "add",
  "agent-ended",
  "fresh",
  "claims",
])

/** Flags that take a value when one follows, and are a plain flag otherwise. */
const OPTIONAL_VALUE = new Set(["fix"])

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, string | true> = {}
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (rest) {
      positionals.push(arg)
      continue
    }
    if (arg === "--") {
      rest = true
      options["--"] = true
      continue
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=")
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      if (eq > 0) options[name] = arg.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(name)) options[name] = true
      else {
        const value = argv[i + 1]
        // `--fix` takes a task id in `plan --fix <id>` and nothing in `doctor --fix`.
        if (OPTIONAL_VALUE.has(name) && (value === undefined || value.startsWith("--"))) {
          options[name] = true
          continue
        }
        if (value === undefined) throw new ToolError(tr("args.needs_value", { name }), 2)
        options[name] = value
        i++
      }
      continue
    }
    positionals.push(arg)
  }
  const action = positionals.shift() ?? "help"
  return { action, positionals, options }
}

/** Splits a command line the way a shell would for simple quoting: spaces, '…' and "…" (with \" inside). */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ""
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (quote) throw new ToolError(tr("args.open_quote"), 2)
  if (has || cur) out.push(cur)
  return out
}

/** The JSON payload of a command: the structured `json`, `@file`, `-` (standard input) or inline JSON. */
/** `what` is the catalog key of what is read (`json.plan`, `json.batch`, `json.task`). */
export async function readJsonArg(ctx: ToolContext, arg: string | undefined, what = "json.plan"): Promise<unknown> {
  if (ctx.json !== undefined) return typeof ctx.json === "string" ? parseJson(ctx.json, what) : ctx.json
  if (arg === undefined) throw new ToolError(tr("json.missing", { what: tr(what) }), 2)
  if (arg === "-") {
    if (!ctx.stdin) throw new ToolError(tr("json.no_stdin"), 2)
    return parseJson(await ctx.stdin(), what)
  }
  if (arg.startsWith("@")) {
    const file = isAbsolute(arg.slice(1)) ? arg.slice(1) : join(ctx.cwd, arg.slice(1))
    const text = await ctx.host.readText(file)
    if (text === undefined) throw new ToolError(tr("json.no_file", { file: arg.slice(1) }))
    return parseJson(text, what)
  }
  return parseJson(arg, what)
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""))
  } catch (error) {
    throw new ToolError(tr("json.invalid", { what: tr(what), message: (error as Error).message }))
  }
}

type Action = (ctx: ToolContext, args: ParsedArgs) => Promise<ToolResult>

const actions = new Map<string, Action>()
const usages: string[] = []

/** A line in `jtasks help` that belongs to no action of its own (variants of one): its catalog key. */
export function addUsage(usage: string) {
  usages.push(usage)
}

/** Adds an action to the tool, with its line in `jtasks help` (a catalog key, `help.<action>` or `help.<action>.…`). */
export function defineAction(name: string, fn: Action, usage?: string) {
  actions.set(name, fn)
  if (usage) usages.push(usage)
}

export function ok(text: string, data?: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, code: 0, text, data, ...extra }
}

// `jtasks help` lists every action; `jtasks help <action>` (or `<action> --help`) only that action's lines.
defineAction("help", async (_ctx, args) => {
  const wanted = args.action === "help" ? args.positionals[0] : args.action
  if (wanted) {
    const keys = usages.filter((k) => k === `help.${wanted}` || k.startsWith(`help.${wanted}.`))
    if (!keys.length) throw new ToolError(tr("help.unknown", { action: wanted }), 2)
    return ok([tr("help.title", { version: VERSION }), "", ...keys.map((k) => `  ${tr(k)}`), "", `  ${tr("help.json")}`].join("\n"))
  }
  return ok(
    [tr("help.title", { version: VERSION }), "", ...usages.map((k) => `  ${tr(k)}`), "", `  ${tr("help.json")}`, `  ${tr("help.lang")}`].join("\n"),
  )
})
defineAction("version", async () => ok(`jtasks ${VERSION}`, { version: VERSION }))

defineAction("validate", async (ctx, args) => {
  const arg = args.positionals[0]
  const dir = arg && !arg.startsWith("@") && !arg.trim().startsWith("[") && !arg.trim().startsWith("{") ? (isAbsolute(arg) ? arg : join(ctx.cwd, arg)) : undefined
  const isDir = dir !== undefined && ctx.json === undefined && (await ctx.host.stat(dir))?.kind === "dir"
  const raw = isDir ? { tasks: (await readTicketsDir(ctx.host, dir!)).map((t) => t.task) } : await readJsonArg(ctx, arg)
  const { plan, errors, warnings } = validatePlan(raw, { platform: ctx.host.platform })
  if (errors.length > 0)
    return { ok: false, code: 1, text: `${tr("errors.count", { n: errors.length })}\n${errors.map((e) => `- ${e}`).join("\n")}`, data: { errors, warnings } }
  const lines = [tr("validate.ok", { n: plan.tasks.length })]
  if (warnings.length) lines.push(tr("warnings.count", { n: warnings.length }), ...warnings.map((w) => `- ${w}`))
  return ok(lines.join("\n"), { errors: [], warnings, tasks: plan.tasks.length })
}, "help.validate")

/** Runs one command of the tool. Never throws: errors come back as `{ ok: false }`. */
export async function runTool(ctx: ToolContext, argv: readonly string[]): Promise<ToolResult> {
  const choice = select({ lang: langArg(argv) ?? ctx.lang, env: (name) => ctx.host.env(name), system: systemLocale() })
  const result = await dispatch(ctx, argv)
  if (choice.warning) result.text = `${choice.warning}\n${result.text}`
  return result
}

/** `--lang <tag>` or `--lang=<tag>` before any `--`. */
function langArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") return undefined
    if (a === "--lang") return argv[i + 1]
    if (a.startsWith("--lang=")) return a.slice(7)
  }
  return undefined
}

/** Actions that never call jlock: they run without making sure it is installed. */
const WITHOUT_JLOCK = new Set(["help", "version", "doctor", "validate", "ledger", "undo"])

async function dispatch(ctx: ToolContext, argv: readonly string[]): Promise<ToolResult> {
  let notice: string | undefined
  const result = await (async (): Promise<ToolResult> => {
    try {
      const args = parseArgs(argv)
      if (args.options.help) return await actions.get("help")!(ctx, args)
      const fn = actions.get(args.action)
      if (!fn) throw new ToolError(tr("tool.unknown_action", { action: args.action }), 2)
      if (!WITHOUT_JLOCK.has(args.action)) notice = await jlockNotice(ctx.host)
      return await fn(ctx, args)
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, code: error.code, text: error.message, data: error.data ?? { error: error.message } }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 1, text: tr("tool.error", { message }), data: { error: message } }
    }
  })()
  if (notice) result.text = `${notice}\n${result.text}`
  return result
}
