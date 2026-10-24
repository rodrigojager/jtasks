// The `tasks` tool: one contract for the CLI, the Claude Code mod and the OpenCode plugin. Each form turns its
// input into an argument list (the CLI's own argv, or the tool's `command` string split like a shell would) plus an
// optional structured `json`, and gets back `{ ok, code, text, data }`.

import type { Host, Resident } from "./host.ts"
import { isAbsolute, join } from "./paths.ts"
import type { ToolName } from "./schema.ts"
import { readTicketsDir } from "./tickets.ts"
import { validatePlan } from "./validate.ts"

export const VERSION = "0.1.0"

export interface ToolContext {
  host: Host
  /** Where the command runs: the repository or a folder inside it. */
  cwd: string
  tool: ToolName
  /** Session id of the mod or the plugin; absent in the CLI. */
  session?: string
  /** The run bound to the session (mod, plugin), or chosen by `--run`/`GOAL_TASKS_RUN`. */
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
])

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
        if (value === undefined) throw new ToolError(`--${name} precisa de um valor`, 2)
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
  if (quote) throw new ToolError("aspas sem fechar no comando", 2)
  if (has || cur) out.push(cur)
  return out
}

/** The JSON payload of a command: the structured `json`, `@file`, `-` (standard input) or inline JSON. */
export async function readJsonArg(ctx: ToolContext, arg: string | undefined, what = "o plano"): Promise<unknown> {
  if (ctx.json !== undefined) return typeof ctx.json === "string" ? parseJson(ctx.json, what) : ctx.json
  if (arg === undefined) throw new ToolError(`falta ${what} em JSON (texto, @arquivo ou -)`, 2)
  if (arg === "-") {
    if (!ctx.stdin) throw new ToolError("entrada padrão indisponível aqui", 2)
    return parseJson(await ctx.stdin(), what)
  }
  if (arg.startsWith("@")) {
    const file = isAbsolute(arg.slice(1)) ? arg.slice(1) : join(ctx.cwd, arg.slice(1))
    const text = await ctx.host.readText(file)
    if (text === undefined) throw new ToolError(`arquivo não encontrado: ${arg.slice(1)}`)
    return parseJson(text, what)
  }
  return parseJson(arg, what)
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""))
  } catch (error) {
    throw new ToolError(`${what} não é JSON válido: ${(error as Error).message}`)
  }
}

type Action = (ctx: ToolContext, args: ParsedArgs) => Promise<ToolResult>

const actions = new Map<string, Action>()
const usages: string[] = []

/** A line in `tasks help` that belongs to no action of its own (variants of one). */
export function addUsage(usage: string) {
  usages.push(usage)
}

/** Adds an action to the tool, with its line in `tasks help`. */
export function defineAction(name: string, fn: Action, usage?: string) {
  actions.set(name, fn)
  if (usage) usages.push(usage)
}

export function ok(text: string, data?: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, code: 0, text, data, ...extra }
}

defineAction("help", async () =>
  ok(
    [
      `tasks ${VERSION}: lista de tarefas com dependências e posse de arquivos (jlock)`,
      "",
      ...usages.map((u) => `  ${u}`),
      "",
      "  --json em qualquer ação: a resposta em JSON; --run <id> escolhe a execução",
    ].join("\n"),
  ),
)
defineAction("version", async () => ok(`tasks ${VERSION}`, { version: VERSION }))

defineAction("validate", async (ctx, args) => {
  const arg = args.positionals[0]
  const dir = arg && !arg.startsWith("@") && !arg.trim().startsWith("[") && !arg.trim().startsWith("{") ? (isAbsolute(arg) ? arg : join(ctx.cwd, arg)) : undefined
  const isDir = dir !== undefined && ctx.json === undefined && (await ctx.host.stat(dir))?.kind === "dir"
  const raw = isDir ? { tasks: (await readTicketsDir(ctx.host, dir!)).map((t) => t.task) } : await readJsonArg(ctx, arg)
  const { plan, errors } = validatePlan(raw, { platform: ctx.host.platform })
  if (errors.length > 0)
    return { ok: false, code: 1, text: `${errors.length} erro(s):\n${errors.map((e) => `- ${e}`).join("\n")}`, data: { errors } }
  return ok(`ok: ${plan.tasks.length} tarefa(s), nenhum erro`, { errors: [], tasks: plan.tasks.length })
}, "validate <json|@arquivo|pasta>        valida um plano (ou uma pasta de tickets) sem gravar")

/** Runs one command of the tool. Never throws: errors come back as `{ ok: false }`. */
export async function runTool(ctx: ToolContext, argv: readonly string[]): Promise<ToolResult> {
  try {
    const args = parseArgs(argv)
    if (args.options.help) return await actions.get("help")!(ctx, args)
    const fn = actions.get(args.action)
    if (!fn) throw new ToolError(`ação desconhecida: ${args.action} (veja tasks help)`, 2)
    return await fn(ctx, args)
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, code: error.code, text: error.message, data: error.data ?? { error: error.message } }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 1, text: `erro: ${message}`, data: { error: message } }
  }
}
