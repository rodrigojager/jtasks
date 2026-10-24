// The `tasks` tool: one contract for the CLI, the Claude Code mod and the OpenCode plugin. Each form turns its
// input into an argument list (the CLI's own argv, or the tool's `command` string split like a shell would) plus an
// optional structured `json`, and gets back `{ ok, code, text, data }`.

import type { Host } from "./host.ts"
import { isAbsolute, join } from "./paths.ts"
import type { ToolName } from "./schema.ts"
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

/** Adds an action to the tool; later tickets register theirs. */
export function defineAction(name: string, fn: Action) {
  actions.set(name, fn)
}

export function ok(text: string, data?: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, code: 0, text, data, ...extra }
}

const HELP = `tasks ${VERSION}: lista de tarefas com dependências e posse de arquivos (jlock)

plano      validate <json|@arquivo>      valida sem gravar
execução   (os próximos tickets acrescentam as ações)
geral      help · version · --json em qualquer ação`

defineAction("help", async () => ok(HELP))
defineAction("version", async () => ok(`tasks ${VERSION}`, { version: VERSION }))

defineAction("validate", async (ctx, args) => {
  const raw = await readJsonArg(ctx, args.positionals[0])
  const { plan, errors } = validatePlan(raw, { platform: ctx.host.platform })
  if (errors.length > 0)
    return { ok: false, code: 1, text: `${errors.length} erro(s):\n${errors.map((e) => `- ${e}`).join("\n")}`, data: { errors } }
  return ok(`ok: ${plan.tasks.length} tarefa(s), nenhum erro`, { errors: [], tasks: plan.tasks.length })
})

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
