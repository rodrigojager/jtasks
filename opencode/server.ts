// goal-tasks for OpenCode v2 (server plugin): the `tasks` tool (the same contract as the CLI, through the core's
// runTool), the run bound to the root session, the protocol and progress in every request and in compaction, the
// agent of each task's profile on its subagent call, and the ownership guard on edit and shell permissions.

import { Plugin } from "@opencode/plugin"
import type { Resident } from "./core/core.js"
import { parseArgs, readTasks, runDir, runTool, splitCommand, VERSION, type Host, type ToolContext, type ToolResult } from "./core/core.js"
import { createNodeHost } from "./core/node-host.js"
import { Bindings, type StorageLike } from "./src/binding.ts"
import { contextText, injectSystem } from "./src/context.ts"
import { judge } from "./src/guard.ts"
import { agentFor, applyProfileModels, SUBAGENT_TOOLS } from "./src/profiles.ts"

export const PLUGIN_ID = "goal-tasks"
export const TOOL_NAME = "tasks"

export const TOOL_DESCRIPTION = `goal-tasks ${VERSION}: lista de tarefas determinística com dependências e posse de arquivos (jlock). ` +
  `"command" é a linha de comando do CLI tasks sem o "tasks" (ex.: "next", "start T04", "claim T04 src/x.ts", ` +
  `"done T04 --evidence \\"bun test: 12 passed\\"", "status", "plan --add"); "json" leva o plano ou o lote em JSON ` +
  `(plan, plan --add, plan --fix <id>). "help" lista as ações. Nunca edite tasks.json, tickets ou o git à mão.`

export const TOOL_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", description: 'A linha de comando do tasks, sem o "tasks": "next", "start T04", "status"…' },
    json: { description: "Plano, lote ou tarefa em JSON, para plan, plan --add e plan --fix." },
  },
  required: ["command"],
  additionalProperties: false,
} as const

/** Actions that may name another run than the bound one (they create, bind or only list). */
const ANY_RUN = new Set(["plan", "resume", "import", "runs", "ledger", "gc", "help", "version", "validate", "clean", "archive", "undo"])
const TASK_START = new Set(["start", "claim"])
const TASK_END = new Set(["done", "skip", "fail", "release"])

export interface ServerOptions {
  host?: Host
}

export function createServerPlugin(options: ServerOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const host = options.host ?? createNodeHost()
      const residents = new Map<string, Resident[]>()
      const bindings = new Bindings(ctx.storage as unknown as StorageLike, ctx.session as never)
      const fallbackDir = ctx.location.directory as string
      let agentModels: { dispose(): Promise<void> } | undefined

      const applyModels = async (profiles: Record<string, never>) => {
        await agentModels?.dispose()
        agentModels = await ctx.agent.transform((editor) => void applyProfileModels(editor as never, profiles))
      }

      const call = async (sessionID: string, command: string, json: unknown): Promise<ToolResult> => {
        const argv = splitCommand(command.replace(/^\s*tasks\s+/, ""))
        const run = await bindings.run(sessionID)
        const child = await bindings.isChild(sessionID)
        const action = argv[0] ?? "help"
        let parsed
        try {
          parsed = parseArgs(argv)
        } catch (error) {
          return { ok: false, code: 2, text: (error as Error).message }
        }
        const asked = typeof parsed.options.run === "string" ? parsed.options.run : undefined
        if (run && asked && asked !== run.run && !ANY_RUN.has(action))
          return { ok: false, code: 1, text: `esta sessão está ligada à execução ${run.run}; --run ${asked} é recusado` }
        const tctx: ToolContext = {
          host,
          cwd: (await bindings.directory(sessionID)) ?? fallbackDir,
          tool: "opencode",
          session: await bindings.root(sessionID),
          residents,
        }
        if (run) tctx.boundRun = run.run
        if (child) tctx.agent = sessionID
        if (json !== undefined) tctx.json = json
        const result = await runTool(tctx, argv)
        if (result.ok && result.bind) {
          const data = result.data as { dir?: string; repo?: string } | undefined
          const dir = data?.dir?.replace(/\\/g, "/")
          const root = dir ? dir.replace(/\/\.scratch\/goal-tasks\/runs\/[^/]+$/, "") : (run?.root ?? tctx.cwd)
          await bindings.bind(sessionID, { run: result.bind, root })
          const tasks = await readTasks(host, runDir(root, result.bind)).catch(() => undefined)
          if (tasks) await applyModels(tasks.profiles as never)
        }
        const id = parsed.positionals[0]
        const boundRun = result.bind ?? run?.run
        if (result.ok && id && boundRun && TASK_START.has(action)) await bindings.setTask(sessionID, { run: boundRun, task: id })
        if (result.ok && id && TASK_END.has(action)) await bindings.setTask(sessionID, undefined)
        return result
      }

      await ctx.tool.transform((editor) => {
        editor.add({
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          input: TOOL_INPUT as never,
          options: { codemode: false },
          execute: async (input, context) => {
            const { command, json } = (input ?? {}) as { command?: string; json?: unknown }
            const result = await call(context.sessionID, String(command ?? "help"), json)
            return { content: result.text, metadata: { ok: result.ok, code: result.code } }
          },
        })
      })

      const inject = async (event: { sessionID: string; system: { type: "text"; text: string; metadata?: Record<string, unknown> }[] }) => {
        try {
          const run = await bindings.run(event.sessionID)
          injectSystem(event.system, run ? await contextText(host, run) : undefined)
        } catch (error) {
          console.warn(`[${PLUGIN_ID}] context skipped: ${(error as Error).message}`)
        }
      }
      await ctx.session.hook("context", inject as never)
      await ctx.session.hook("compaction", inject as never)

      await ctx.tool.hook("execute.before", async (event) => {
        if (!SUBAGENT_TOOLS.has(event.tool)) return
        const input = event.input as { prompt?: unknown; agent?: unknown } | undefined
        if (!input || typeof input.prompt !== "string") return
        const run = await bindings.run(event.sessionID)
        if (!run) return
        const decision = await agentFor(host, run, input.prompt)
        // Throwing fails only this call, and the model reads the reason.
        if (decision.error) throw new Error(`goal-tasks: ${decision.error}`)
        if (decision.agent && decision.agent !== input.agent) event.input = { ...input, agent: decision.agent }
      })

      await ctx.permission.hook("evaluate", async (event) => {
        await judge(host, bindings, event as never, fallbackDir)
      })

      return async () => {
        await agentModels?.dispose()
        for (const list of residents.values())
          for (const r of list) {
            if (!(await r.send("release\n"))) await r.stop()
          }
        residents.clear()
      }
    },
  })
}

export default createServerPlugin()
