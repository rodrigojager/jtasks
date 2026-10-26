// A fake OpenCode host for the plugin tests: the plugin context's domains the plugin uses, kept in memory, with
// helpers that play what OpenCode does (a tool call, a model request, a subagent call, a permission decision).
// No model is called: the tests script what a model would do.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../core/core.js"
import { createServerPlugin } from "../server.ts"

type Hook = (event: any) => Promise<void> | void

export const TEST_ROOT = (process.platform === "win32" ? "D:/claude-cache/jtasks-tests" : "/tmp/jtasks-tests").replace(/\\/g, "/")
const made: string[] = []

export function tempDir(prefix: string): string {
  const dir = `${TEST_ROOT}/oc-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  mkdirSync(dir, { recursive: true })
  made.push(dir)
  return dir
}

export function cleanupTemp() {
  for (const dir of made.splice(0))
    for (let i = 0; i < 30; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Bun.sleepSync(100)
      }
    }
}

export function sh(cwd: string, ...argv: string[]): string {
  const p = Bun.spawnSync(argv, { cwd, env: process.env })
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

export function makeRepo(): string {
  const dir = tempDir("repo")
  sh(dir, "git", "init", "-q", "-b", "main")
  sh(dir, "git", "config", "user.email", "t@example.test")
  sh(dir, "git", "config", "user.name", "T")
  sh(dir, "git", "config", "core.autocrlf", "false")
  writeFileSync(join(dir, "README.md"), "# t\n")
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-q", "-m", "init")
  return dir
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

export interface Agent {
  id: string
  model?: unknown
}

export async function fakeHost(directory: string, host?: Host, options: { renewEveryMs?: number; resumeEveryMs?: number } = {}) {
  const storage = new Map<string, unknown>()
  const sessions = new Map<string, { id: string; parentID?: string; location: { directory: string } }>()
  const hooks = new Map<string, Hook>()
  const tools: any[] = []
  /** What the plugin sent to sessions with `session.synthetic` (the keepalive's messages). */
  const synthetics: { sessionID: string; text: string; delivery?: string }[] = []
  const agents = new Map<string, Agent>(["build", "execute", "execute-deep", "review"].map((id) => [id, { id }]))
  const registration = { dispose: async () => {} }
  const rpcImpls = new Map<string, Record<string, (input: unknown, context: unknown) => Promise<unknown>>>()
  const rpcListeners = new Map<string, ((event: { data: unknown }) => void)[]>()
  // The event stream the plugin subscribes to: what OpenCode publishes, pushed by the test with `emit`.
  const pending: { type: string; data: unknown }[] = []
  let wake: (() => void) | undefined
  let closed = false
  const emit = (type: string, data: unknown) => {
    pending.push({ type, data })
    wake?.()
  }
  const stream: AsyncIterable<{ type: string; data: unknown }> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (!pending.length && !closed) await new Promise<void>((r) => (wake = r))
        return pending.length ? { done: false, value: pending.shift()! } : { done: true, value: undefined }
      },
      return: async () => {
        closed = true
        wake?.()
        return { done: true, value: undefined }
      },
    }),
  }
  const ctx = {
    app: { version: "2.1.3" },
    event: { subscribe: () => stream },
    location: { directory },
    storage: {
      get: async (k: string) => storage.get(k),
      set: async (k: string, v: unknown) => void storage.set(k, JSON.parse(JSON.stringify(v))),
      remove: async (k: string) => void storage.delete(k),
      scan: async () => ({ entries: [...storage].map(([key, value]) => ({ key, value })) }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions.get(sessionID)
        if (!s) throw new Error(`no session ${sessionID}`)
        return s
      },
      hook: async (name: string, cb: Hook) => (hooks.set(`session.${name}`, cb), registration),
      synthetic: async (input: { sessionID: string; text: string; delivery?: string }) => (synthetics.push(input), { type: "synthetic", id: `syn-${synthetics.length}` }),
    },
    tool: {
      transform: async (cb: (editor: any) => void) => (cb({ add: (t: any) => tools.push(t) }), registration),
      hook: async (name: string, cb: Hook) => (hooks.set(`tool.${name}`, cb), registration),
    },
    permission: { hook: async (name: string, cb: Hook) => (hooks.set(`permission.${name}`, cb), registration) },
    rpc: {
      register: async (def: { id: string }, impl: Record<string, (input: unknown, context: unknown) => Promise<unknown>>) => {
        rpcImpls.set(def.id, impl)
        return {
          dispose: async () => void rpcImpls.delete(def.id),
          events: {
            emit: async (name: string, data: unknown) => {
              for (const l of rpcListeners.get(`${def.id}.${name}`) ?? []) l({ data })
            },
          },
        }
      },
    },
    agent: {
      transform: async (cb: (editor: any) => void) => {
        cb({
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          update: (id: string, fn: (a: Agent) => void) => {
            const a = agents.get(id)
            if (a) fn(a)
          },
          remove: (id: string) => agents.delete(id),
          default: () => {},
        })
        return registration
      },
    },
  }
  const plugin = createServerPlugin({ ...(host ? { host } : {}), ...options })
  const cleanup = (await plugin.setup(ctx as never)) as (() => Promise<void>) | undefined

  const addSession = (id: string, parentID?: string) => sessions.set(id, { id, ...(parentID ? { parentID } : {}), location: { directory } })
  addSession("s1")

  /** The model calls the jtasks tool in a session. */
  const call = async (sessionID: string, command: string, json?: unknown) => {
    const tool = tools.find((t) => t.name === "jtasks")
    const r = await tool.execute(json === undefined ? { command } : { command, json }, { sessionID, agent: "build", messageID: "m", id: "c" })
    return { text: r.content as string, ok: r.metadata.ok as boolean }
  }
  /** A model request of the agent loop: the system prompt as the plugin leaves it. */
  const request = async (sessionID: string, system: { type: "text"; text: string; metadata?: Record<string, unknown> }[] = [{ type: "text", text: "base" }]) => {
    const event = { sessionID, agent: "build", system, messages: [], options: {}, tools: {}, model: { providerID: "x", id: "y" } }
    await hooks.get("session.context")!(event)
    return event.system
  }
  /** The model calls the subagent tool: what OpenCode would run, after the plugin's hook. */
  const subagent = async (sessionID: string, input: { agent: string; description: string; prompt: string }) => {
    const event = { tool: "subagent", sessionID, agent: "build", messageID: "m", id: "c", input }
    await hooks.get("tool.execute.before")!(event)
    return event.input as typeof input
  }
  /** A permission decision of a session: what the plugin's hook leaves. */
  const permission = async (sessionID: string, action: string, resources: string[]) => {
    const event: { sessionID: string; action: string; resources: string[]; effect: string; message?: string } = {
      sessionID,
      action,
      resources,
      effect: "allow",
    }
    await hooks.get("permission.evaluate")!(event)
    return event
  }
  /** What a TUI's `context.client.rpc(def)` would get: the server implementation, through the fake transport. */
  const rpcClient = (def: { id: string }) =>
    new Proxy(
      {
        events: {
          on: (name: string, cb: (event: { data: unknown }) => void) => {
            const key = `${def.id}.${name}`
            rpcListeners.set(key, [...(rpcListeners.get(key) ?? []), cb])
            return () => rpcListeners.set(key, (rpcListeners.get(key) ?? []).filter((x) => x !== cb))
          },
        },
      } as Record<string, unknown>,
      {
        get: (target, method: string) =>
          method in target ? target[method] : (input: unknown) => rpcImpls.get(def.id)![method]!(input, { signal: new AbortController().signal }),
      },
    )
  return { ctx, tools, hooks, agents, storage, addSession, call, request, subagent, permission, rpcClient, cleanup, emit, synthetics }
}
