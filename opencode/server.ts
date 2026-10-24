// jtasks for OpenCode v2 (server plugin): the `jtasks` tool (the same contract as the CLI, through the core's
// runTool), the run bound to the root session, the protocol and progress in every request and in compaction, the
// agent of each task's profile on its subagent call, and the ownership guard on edit and shell permissions.

import { Plugin } from "@opencode/plugin"
import type { Resident } from "./core/core.js"
import { ensureJlock, holdModeFor, parseArgs, readTasks, runDir, runTool, select, splitCommand, systemLocale, tr, VERSION, type Host, type Profile, type ToolContext, type ToolResult } from "./core/core.js"
import { createNodeHost } from "./core/node-host.js"
import { onSessionEnded } from "./src/agents.ts"
import { Bindings, type StorageLike } from "./src/binding.ts"
import { contextText, injectSystem } from "./src/context.ts"
import { judge } from "./src/guard.ts"
import { agentFor, agentMissingLine, applyProfileModels, missingAgents, SUBAGENT_TOOLS } from "./src/profiles.ts"
import { TasksRpc } from "./src/rpc.ts"
import { viewFor } from "./src/view.ts"

export const PLUGIN_ID = "jtasks"
export const TOOL_NAME = "jtasks"

// What the model reads is English in every language (plan section 21); the answers are in the person's language.
export const TOOL_DESCRIPTION = `jtasks ${VERSION}: a deterministic task list with dependencies and file ownership (jlock). ` +
  `"command" is the jtasks CLI command line without the "jtasks" (e.g. "next", "start T04", "claim T04 src/x.ts", ` +
  `"done T04 --evidence \\"bun test: 12 passed\\"", "status", "plan --add"); "json" carries the plan or the batch in JSON ` +
  `(plan, plan --add, plan --fix <id>). "help" lists the actions. Never edit tasks.json, the tickets or git by hand.`

export const TOOL_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", description: 'The jtasks command line, without the "jtasks": "next", "start T04", "status"…' },
    json: { description: "A plan, batch or task in JSON, for plan, plan --add and plan --fix." },
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
      // The language of the views the sidebar asks for (each tool call chooses again, with its own --lang).
      select({ env: (name) => host.env(name), system: systemLocale() })
      const residents = new Map<string, Resident[]>()
      // jlock comes with jtasks: a missing one is installed now (the first tool call tells the user).
      await ensureJlock(host).catch(() => undefined)
      // `jlock hold --release-on-eof` kept alive with its standard input open (OpenCode dying frees the locks at
      // once); an older jlock gets `--detach` and the ttl.
      const holdMode = await holdModeFor(host).catch(() => "detach" as const)
      const bindings = new Bindings(ctx.storage as unknown as StorageLike, ctx.session as never)
      const fallbackDir = ctx.location.directory as string
      let agentModels: { dispose(): Promise<void> } | undefined

      // Applies the profiles' models to their agents; answers the profiles whose agent does not exist (the editor is
      // the host's view of the agents; a host that applies the transform later answers nothing here).
      const applyModels = async (profiles: Record<string, Profile>): Promise<[string, string][]> => {
        await agentModels?.dispose()
        let missing: [string, string][] = []
        agentModels = await ctx.agent.transform((editor) => {
          applyProfileModels(editor as never, profiles)
          missing = missingAgents(editor as never, profiles)
        })
        return missing
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
          return { ok: false, code: 1, text: tr("binding.other_run", { run: run.run, asked }) }
        const tctx: ToolContext = {
          host,
          cwd: (await bindings.directory(sessionID)) ?? fallbackDir,
          tool: "opencode",
          session: await bindings.root(sessionID),
          residents,
          holdMode,
        }
        if (run) tctx.boundRun = run.run
        if (child) tctx.agent = sessionID
        if (json !== undefined) tctx.json = json
        const result = await runTool(tctx, argv)
        if (result.ok && result.bind) {
          const data = result.data as { dir?: string; repo?: string } | undefined
          const dir = data?.dir?.replace(/\\/g, "/")
          const root = dir ? dir.replace(/\/\.scratch\/jtasks\/runs\/[^/]+$/, "") : (run?.root ?? tctx.cwd)
          await bindings.bind(sessionID, { run: result.bind, root })
          const tasks = await readTasks(host, runDir(root, result.bind)).catch(() => undefined)
          if (tasks) {
            const missing = await applyModels(tasks.profiles)
            if (missing.length) result.text += `\n${missing.map(([p, a]) => agentMissingLine(p, a)).join("\n")}`
          }
        }
        const id = parsed.positionals[0]
        const boundRun = result.bind ?? run?.run
        if (result.ok && id && boundRun && TASK_START.has(action)) await bindings.setTask(sessionID, { run: boundRun, task: id })
        if (result.ok && id && TASK_END.has(action)) await bindings.setTask(sessionID, undefined)
        return result
      }

      const rpc = await ctx.rpc.register(TasksRpc, {
        state: async (input) => ({ view: await viewFor(host, bindings, (input as { sessionID: string }).sessionID, fallbackDir) }) as never,
      })

      await ctx.tool.transform((editor) => {
        editor.add({
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          input: TOOL_INPUT as never,
          options: { codemode: false },
          execute: async (input, context) => {
            const { command, json } = (input ?? {}) as { command?: string; json?: unknown }
            const result = await call(context.sessionID, String(command ?? "help"), json)
            const run = (await bindings.run(context.sessionID))?.run
            if (run) await rpc.events.emit("changed", { run }).catch(() => {})
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
        if (decision.error) throw new Error(`jtasks: ${decision.error}`)
        if (decision.agent && decision.agent !== input.agent) event.input = { ...input, agent: decision.agent }
      })

      await ctx.permission.hook("evaluate", async (event) => {
        await judge(host, bindings, event as never, fallbackDir)
      })

      // A subagent's session that goes idle (or is deleted) with its task in progress gives the task back.
      const events = (ctx.event?.subscribe?.() as AsyncIterable<{ type: string; data?: { sessionID?: string } }> | undefined)?.[
        Symbol.asyncIterator
      ]()
      if (events)
        void (async () => {
          for (;;) {
            const next = await events.next().catch(() => ({ done: true, value: undefined }) as const)
            if (next.done) return
            const { type, data } = next.value
            if ((type !== "session.idle" && type !== "session.deleted") || !data?.sessionID) continue
            const end = type === "session.idle" ? "idle" : "deleted"
            await onSessionEnded(host, bindings, data.sessionID, end, (sessionID, command) => call(sessionID, command, undefined)).catch(() => {})
          }
        })()

      return async () => {
        await events?.return?.().catch(() => {})
        await agentModels?.dispose()
        await rpc.dispose().catch(() => {})
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
