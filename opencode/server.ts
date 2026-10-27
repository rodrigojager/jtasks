// jtasks for OpenCode v2 (server plugin): the `jtasks` tool (the same contract as the CLI, through the core's
// runTool), the run bound to the root session, the protocol and progress in every request and in compaction, the
// agent of each task's profile on its subagent call, the ownership guard on edit and shell permissions, and the
// keepalive: the root session going idle with ready tasks and no subagent alive gets a message that resumes it; and
// the holds of the tasks this process started renewed before the run's holdTtl expires them (core's renew.ts); and a
// session that fails on a transient failure of the provider (a usage or rate limit, an overloaded server, the network)
// pauses the run with its task kept in progress, resumed later by the clock (rev. 5.7, ./src/transient.ts); and a
// child session that ends while its process runs leaves its task waiting for it, every transition the root session did
// not ask for is sent to it at once, and every subagent call's result carries the status line (rev. 5.8, ./src/alerts.ts).

import { Plugin } from "@opencode/plugin"
import type { Resident } from "./core/core.js"
import { awaitBack, ensureJlock, holdModeFor, parseArgs, pauseForFailure, pauseNotice, readRun, readTasks, renewRun, RENEW_EVERY_MS, resumeIfDue, runDir, runTool, select, splitCommand, sweepAwaiting, systemLocale, tr, VERSION, type Classification, type Host, type Profile, type ToolContext, type ToolResult } from "./core/core.js"
import { createNodeHost } from "./core/node-host.js"
import { onSessionEnded } from "./src/agents.ts"
import { RunAlerts, statusTail } from "./src/alerts.ts"
import { Bindings, type StorageLike } from "./src/binding.ts"
import { contextText, injectSystem } from "./src/context.ts"
import { judge } from "./src/guard.ts"
import { RootKeepalive, SETTLE_MS } from "./src/keepalive.ts"
import { agentFor, agentMissingLine, applyProfileModels, missingAgents, SUBAGENT_TOOLS, taskOfPrompt } from "./src/profiles.ts"
import { TasksRpc } from "./src/rpc.ts"
import { SessionFailures } from "./src/transient.ts"
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
  /** How often the holds are looked at (tests use less). */
  renewEveryMs?: number
  /** How often a transient pause is looked at for its `resumeAt` (tests use less). */
  resumeEveryMs?: number
  /** How often the runs' logs are read for alerts, and (every fifth time) the tasks waiting for a process (rev. 5.8). */
  alertEveryMs?: number
}

/** How often the runs' logs are read for what the root session must hear about (rev. 5.8). */
export const ALERT_EVERY_MS = 3_000

/** How often a transient pause is looked at for its `resumeAt`. */
export const RESUME_EVERY_MS = 15_000
/** Input fields of the subagent tool that resume an existing subagent session instead of opening one. */
const RESUME_FIELDS = ["task_id", "taskID", "sessionID", "session_id"]

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
      // The runs this process works on, by run: its repository root and the root sessions bound to it.
      const working = new Map<string, { root: string; sessions: Set<string> }>()
      // Set once the RPC exists (a give-up repaints the sidebar through its `changed`).
      let keepalive: RootKeepalive | undefined
      // Set once the RPC exists: what a run does without the root session asking (rev. 5.8).
      let alerts: RunAlerts | undefined
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
        if (run) {
          const w = working.get(run.run) ?? { root: run.root, sessions: new Set<string>() }
          if (!w.sessions.has(tctx.session!)) await alerts?.watch(run, tctx.session!).catch(() => undefined)
          w.sessions.add(tctx.session!)
          working.set(run.run, w)
        }
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
        if (result.ok && id && boundRun && TASK_START.has(action)) {
          await bindings.setTask(sessionID, { run: boundRun, task: id })
          await keepalive?.taskStarted(sessionID)
        }
        // A task waiting for its process (rev. 5.8) keeps its session's binding: the guard and the next end know it.
        if (result.ok && id && TASK_END.has(action) && (result.data as { outcome?: string } | undefined)?.outcome !== "awaiting")
          await bindings.setTask(sessionID, undefined)
        return result
      }

      const rpc = await ctx.rpc.register(TasksRpc, {
        state: async (input) => ({ view: await viewFor(host, bindings, (input as { sessionID: string }).sessionID, fallbackDir) }) as never,
      })

      const session = ctx.session as unknown as { synthetic?: (input: Record<string, unknown>) => Promise<unknown> }
      const send =
        typeof session.synthetic === "function"
          ? (sessionID: string, text: string) =>
              session.synthetic!({ sessionID, text, description: "jtasks keepalive", delivery: "queue", metadata: { source: PLUGIN_ID } })
          : undefined

      // Transient failures (rev. 5.7): the last failure of each session, read from the event stream.
      const failures = new SessionFailures(() => host.now())
      const sessionCtx = (run: { run: string; root: string }, root: string): ToolContext => ({ host, cwd: run.root, tool: "opencode", session: root, residents, holdMode, boundRun: run.run })
      /** Pauses the session's run when its failure is transient; `task`: the child's task, kept in progress. */
      const pauseOn = async (sessionID: string, failure: Classification | undefined, task?: string): Promise<boolean> => {
        if (!failure?.transient) return false
        const run = await bindings.run(sessionID)
        if (!run) return false
        const root = await bindings.root(sessionID)
        const child = root !== sessionID
        const pause = await pauseForFailure(sessionCtx(run, root), { run: run.run, failure, ...(task ? { task } : {}), ...(child ? { agent: sessionID } : {}) })
        if (!pause) return false
        console.warn(`[${PLUGIN_ID}] ${pauseNotice(run.run, pause, host.now())}`)
        await rpc.events.emit("changed", { run: run.run }).catch(() => {})
        return true
      }

      // What a run does without the root session asking (rev. 5.8): a message to it, and a toast in the TUI.
      alerts = new RunAlerts(host, { send, alert: (run, notice) => rpc.events.emit("alert" as never, { run, notice } as never) })

      keepalive = new RootKeepalive(host, bindings, {
        send,
        changed: (run) => rpc.events.emit("changed", { run }),
        // The root's own failed execution: a transient one pauses the run (the keepalive then stays quiet).
        transient: (root) => pauseOn(root, failures.take(root)),
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
        // A task kept in progress for its subagent session (alive, or kept by a transient pause): that session is
        // resumed, never a second one opened for it.
        const task = taskOfPrompt(input.prompt).task
        const resuming = RESUME_FIELDS.some((f) => typeof (input as Record<string, unknown>)[f] === "string")
        if (task && !resuming) {
          const t = (await readTasks(host, runDir(run.root, run.run)).catch(() => undefined))?.tasks.find((x) => x.id === task)
          const child = t?.status === "in_progress" ? /\/agent:([^/]+)$/.exec(t.owner ?? "")?.[1] : undefined
          if (child && (await bindings.task(child))?.task === task) throw new Error(`jtasks: ${tr("spawn.kept_session", { task, agent: child })}`)
        }
        if (decision.agent && decision.agent !== input.agent) event.input = { ...input, agent: decision.agent }
      })

      // The result of a subagent call carries the run's status line read at its end (rev. 5.8): the root session never
      // answers it from a stale picture.
      await ctx.tool.hook("execute.after", async (event) => {
        if (!SUBAGENT_TOOLS.has(event.tool) || event.status !== "completed") return
        const run = await bindings.run(event.sessionID)
        if (!run) return
        const tail = await statusTail(host, run)
        const result = event.result as { content?: unknown }
        if (tail && (typeof result.content === "string" || result.content === undefined)) event.result = { ...event.result, content: `${result.content ?? ""}${tail}` }
      })

      await ctx.permission.hook("evaluate", async (event) => {
        await judge(host, bindings, event as never, fallbackDir)
      })

      // A subagent's session that goes idle (or is deleted) with its task in progress gives the task back. Every
      // session event also goes to the keepalive, unawaited: a root's idle waits a moment for its execution's end.
      // A child that failed on a transient failure keeps its task (and its binding, for the guard) instead.
      const events = (ctx.event?.subscribe?.() as AsyncIterable<{ type: string; data?: { sessionID?: string }; properties?: { sessionID?: string } }> | undefined)?.[
        Symbol.asyncIterator
      ]()
      if (events)
        void (async () => {
          for (;;) {
            const next = await events.next().catch(() => ({ done: true, value: undefined }) as const)
            if (next.done) return
            const { type } = next.value
            // v1 events carry `properties` where v2 ones carry `data`.
            const data = next.value.data ?? next.value.properties
            failures.onEvent(type, data)
            if (data?.sessionID) void keepalive?.onEvent(type, data.sessionID).catch(() => undefined)
            // A child session working again (resumed with task_id) whose task waited for its process (rev. 5.8).
            if (type === "session.execution.started" && data?.sessionID) {
              const child = data.sessionID
              void (async () => {
                const bound = await bindings.task(child)
                const run = bound ? await bindings.run(child) : undefined
                if (bound && run && run.run === bound.run) await awaitBack(sessionCtx(run, await bindings.root(child)), run.run, bound.task, "session.execution.started")
              })().catch(() => undefined)
            }
            if ((type !== "session.idle" && type !== "session.deleted") || !data?.sessionID) continue
            const end = type === "session.idle" ? "idle" : "deleted"
            const sessionID = data.sessionID
            // Not awaited: the session's own failure may arrive just after its idle, and the stream must go on.
            void onSessionEnded(host, bindings, sessionID, end, (id, command) => call(id, command, undefined), async (task) => {
              // Another idle of a session the pause already kept keeps it still (only its deletion gives it back).
              const run = await bindings.run(sessionID)
              const file = run && end === "idle" ? await readRun(host, runDir(run.root, run.run)).catch(() => undefined) : undefined
              if (file?.status === "paused" && file.pause?.tasks.some((t) => t.id === task && t.agent === sessionID)) return true
              if (!failures.has(sessionID)) await host.sleep(SETTLE_MS)
              return pauseOn(sessionID, failures.take(sessionID), task)
            }).catch(() => {})
          }
        })()

      // Every minute, the holds of the tasks in progress this process's sessions started, renewed before they expire.
      let renewing = false
      const renewTimer = setInterval(() => {
        if (renewing) return
        renewing = true
        void (async () => {
          for (const [run, w] of working) {
            const ctx: ToolContext = { host, cwd: w.root, tool: "opencode", session: [...w.sessions][0], residents, holdMode, boundRun: run }
            const actors = [...w.sessions].map((s) => `opencode:${s}`)
            await renewRun(ctx, run, (owner) => actors.some((a) => owner === a || owner.startsWith(`${a}/`)), options.renewEveryMs ?? RENEW_EVERY_MS)
          }
        })().finally(() => {
          renewing = false
        })
      }, options.renewEveryMs ?? RENEW_EVERY_MS)
      ;(renewTimer as { unref?: () => void }).unref?.()

      // A transient pause whose `resumeAt` has come: the run is active again, and each root session bound to it is
      // told to resume the same subagent sessions (rev. 5.7).
      let resuming = false
      const resumeTimer = setInterval(() => {
        if (resuming) return
        resuming = true
        void (async () => {
          for (const [run, w] of working) {
            const file = await readRun(host, runDir(w.root, run)).catch(() => undefined)
            if (file?.status !== "paused" || !file.pause?.resumeAt || Date.parse(file.pause.resumeAt) > host.now().getTime()) continue
            const root = [...w.sessions][0]!
            const left = await resumeIfDue(sessionCtx({ run, root: w.root }, root), run).catch(() => undefined)
            if (!left) continue
            for (const s of w.sessions) await send?.(s, left.text).catch(() => undefined)
            await rpc.events.emit("changed", { run }).catch(() => {})
          }
        })().finally(() => {
          resuming = false
        })
      }, options.resumeEveryMs ?? RESUME_EVERY_MS)
      ;(resumeTimer as { unref?: () => void }).unref?.()

      // The runs' alerts for their root sessions, and every fifth pass the tasks waiting for a process (rev. 5.8): a
      // process that ended tells the root to resume the same child session; one that does not come back counts as ended.
      let alerting = false
      let alertPasses = 0
      const alertTimer = setInterval(() => {
        if (alerting) return
        alerting = true
        void (async () => {
          const sweep = alertPasses++ % 5 === 0
          for (const [run, w] of working) {
            const binding = { run, root: w.root }
            if (sweep) await sweepAwaiting(sessionCtx(binding, [...w.sessions][0]!), run).catch(() => [])
            for (const s of w.sessions) await alerts?.check(binding, s).catch(() => undefined)
          }
        })().finally(() => {
          alerting = false
        })
      }, options.alertEveryMs ?? ALERT_EVERY_MS)
      ;(alertTimer as { unref?: () => void }).unref?.()

      return async () => {
        clearInterval(renewTimer)
        clearInterval(resumeTimer)
        clearInterval(alertTimer)
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
