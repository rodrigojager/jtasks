import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Host, Resident } from "../core/core.js"
import { createNodeHost } from "../core/node-host.js"
import { PLUGIN_ID, TOOL_NAME } from "../server.ts"
import { cleanupTemp, fakeHost, makeRepo, sh, writeFiles } from "./fake-host.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const c of cleanups) await c()
  await Bun.sleep(400)
  cleanupTemp()
})

const plan = {
  objective: "Duas fatias em paralelo",
  profiles: {
    execute: { claude: { model: "sonnet" }, opencode: { agent: "execute", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } } },
    "execute-deep": { claude: { model: "opus" }, opencode: { agent: "execute-deep" } },
  },
  tasks: [
    { id: "T01", title: "Movimento", files: ["src/move.ts"], acceptance: ["move.ts existe"] },
    { id: "T02", title: "Gravador", files: ["src/recorder"], profile: "execute-deep" },
    { id: "T03", title: "Junta", dependsOn: ["T01", "T02"], files: ["src/index.ts"] },
  ],
}

async function setup() {
  const repo = makeRepo()
  const h = await fakeHost(repo)
  if (h.cleanup) cleanups.push(h.cleanup)
  return { repo, h }
}

describe("OpenCode plugin", () => {
  test("registers the jtasks tool and its hooks", async () => {
    const { h } = await setup()
    expect(PLUGIN_ID).toBe("jtasks")
    expect(h.tools.map((t) => t.name)).toEqual([TOOL_NAME])
    expect([...h.hooks.keys()].sort()).toEqual(["permission.evaluate", "session.compaction", "session.context", "tool.execute.before"])
  })

  test("a scripted model: next, two subagent calls in one response, start/claim/done in each, status restam 0", async () => {
    const { repo, h } = await setup()
    // Before a run is bound, the request carries nothing of ours.
    expect(await h.request("s1")).toEqual([{ type: "text", text: "base" }])

    const planned = await h.call("s1", "plan", plan)
    expect(planned.ok).toBe(true)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    // The profile's model reached the agent the profile names.
    expect(h.agents.get("execute")!.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })

    const system = await h.request("s1")
    expect(system).toHaveLength(2)
    expect(system[1]!.text).toContain(`jtasks: bound run ${run} · feitas 0/3 (0%) · restam 3`)
    expect(system[1]!.text).toContain("1. Call jtasks next.")

    const next = await h.call("s1", "next")
    expect(next.text).toContain("prontas (2)")

    // One model response with two subagent calls: both pass the hook, each gets its profile's agent.
    const [a, b] = await Promise.all([
      h.subagent("s1", { agent: "build", description: "T01", prompt: `--run ${run} --task T01 Movimento. Chame jtasks start T01…` }),
      h.subagent("s1", { agent: "build", description: "T02", prompt: `--run ${run} --task T02 Gravador. Chame jtasks start T02…` }),
    ])
    expect(a.agent).toBe("execute")
    expect(b.agent).toBe("execute-deep")

    // OpenCode creates the child sessions; the two subagents work in parallel.
    h.addSession("c1", "s1")
    h.addSession("c2", "s1")
    const child = async (session: string, id: string, files: Record<string, string>, claim?: string) => {
      const started = await h.call(session, `start ${id}`)
      expect(started.ok).toBe(true)
      if (claim) expect((await h.call(session, `claim ${id} ${claim}`)).text).toMatch(new RegExp(`^${id} recebeu ${claim}`))
      writeFiles(repo, files)
      return h.call(session, `done ${id} --evidence "arquivos escritos"`)
    }
    const [d1, d2] = await Promise.all([
      child("c1", "T01", { "src/move.ts": "export const move = 1\n" }),
      child("c2", "T02", { "src/recorder/rec.ts": "export const rec = 1\n", "docs/rec.md": "# rec\n" }, "docs/rec.md"),
    ])
    expect(d1.text).toContain("T01 feita: commit")
    expect(d2.text).toContain("T02 feita: commit")

    h.addSession("c3", "s1")
    await h.call("c3", "start T03")
    writeFiles(repo, { "src/index.ts": "export * from './move'\n" })
    await h.call("c3", 'done T03 --evidence "junta"')

    const status = await h.call("s1", "status")
    expect(status.text.split("\n")[0]).toBe("feitas 3/3 (100%) · restam 0")
    expect(sh(repo, "git", "log", "--format=%s", "-4").trim().split("\n")).toEqual(["T03: Junta", expect.stringMatching(/^T0[12]: /), expect.stringMatching(/^T0[12]: /), "init"])

    // The compaction request carries the list too.
    const compaction = { sessionID: "s1", agent: "build", system: [] as any[], messages: [], options: {}, tools: {} }
    await h.hooks.get("session.compaction")!(compaction)
    expect(compaction.system[0].text).toContain("restam 0")
  })

  test("the guard: an edit outside the ownership and a git commit of a subagent are denied; tasks.json is denied to all", async () => {
    const { repo, h } = await setup()
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    h.addSession("c1", "s1")
    await h.call("c1", "start T01")

    expect(await h.permission("c1", "edit", [join(repo, "src/move.ts")])).toMatchObject({ effect: "allow" })
    expect(await h.permission("c1", "edit", ["src/other.ts"])).toMatchObject({
      effect: "deny",
      message: "fora da posse de T01: src/other.ts; use jtasks claim T01 src/other.ts",
    })
    expect(await h.permission("c1", "shell", ['git commit -m "x"'])).toMatchObject({
      effect: "deny",
      message: "subagente não roda git commit: o commit é feito por jtasks done T01",
    })
    expect(await h.permission("c1", "shell", ["bun test"])).toMatchObject({ effect: "allow" })
    expect(await h.permission("c1", "read", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    // The main agent edits freely, but never the run's files.
    expect(await h.permission("s1", "edit", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    const tj = `.scratch/jtasks/runs/${run}/tasks.json`
    expect((await h.permission("s1", "edit", [tj])).effect).toBe("deny")
    // After claim, the file is in the ownership.
    await h.call("c1", "claim T01 src/other.ts")
    expect(await h.permission("c1", "edit", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    await h.call("c1", "release T01")
    expect(JSON.parse(readFileSync(join(repo, ".scratch/jtasks/runs", run, "tasks.json"), "utf8")).tasks[0].status).toBe("pending")
  })

  test("a subagent call of an unknown task is refused; another --run than the bound one is refused", async () => {
    const { h } = await setup()
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    await expect(h.subagent("s1", { agent: "build", description: "x", prompt: `--run ${run} --task T09 x` })).rejects.toThrow(
      `jtasks: a execução ${run} não tem a tarefa T09`,
    )
    const plain = { agent: "explore", description: "x", prompt: "map the code" }
    expect(await h.subagent("s1", plain)).toBe(plain)
    const other = await h.call("s1", "status --run outra-261024-zzzz")
    expect(other).toEqual({ ok: false, text: `esta sessão está ligada à execução ${run}; --run outra-261024-zzzz é recusado` })
  })

  test("sessions are separate: a new root session has no binding until it resumes the run", async () => {
    const { h } = await setup()
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    h.addSession("s2")
    expect(await h.request("s2")).toEqual([{ type: "text", text: "base" }])
    await h.call("s2", `resume ${run}`)
    expect((await h.request("s2"))[1]!.text).toContain(`bound run ${run}`)
  })

  test("a profile naming an agent that does not exist is warned about after plan and resume; existing agents are not", async () => {
    const { h } = await setup()
    const ok = await h.call("s1", "plan", plan)
    expect(ok.text).not.toContain("aponta o agente")
    h.addSession("s2")
    const ghost = { ...plan, profiles: { ...plan.profiles, execute: { opencode: { agent: "ghost" } } } }
    const planned = await h.call("s2", "plan", ghost)
    expect(planned.ok).toBe(true)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    const line = 'aviso: o perfil "execute" aponta o agente "ghost", que não existe: instale os agentes do jtasks com jtasks doctor --fix, ou aponte um agente seu no plano'
    expect(planned.text.split("\n")).toContain(line)
    h.addSession("s3")
    const resumed = await h.call("s3", `resume ${run}`)
    expect(resumed.text.split("\n")).toContain(line)
  })

  test("--release-on-eof: closing the hold's standard input (the window dying) frees the lock at once; status sees the loss", async () => {
    const repo = makeRepo()
    const base = createNodeHost()
    const seen: Resident[] = []
    const host: Host = {
      ...base,
      spawn: async (argv, options) => {
        const r = await base.spawn(argv, options)
        seen.push(r)
        return r
      },
    }
    const h = await fakeHost(repo, host)
    if (h.cleanup) cleanups.push(h.cleanup)
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    h.addSession("c1", "s1")
    expect((await h.call("c1", "start T01")).ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.lines()[0]).toContain('"result":"granted"')
    const locks = () => (JSON.parse(sh(repo, "jlock", "list", "--group", run, "--json")) as { locks: { holder: { owner: string } | null }[] }).locks
    expect(locks().map((l) => l.holder?.owner)).toEqual([`gt:${run}/T01`])
    // The host dies: its end of the pipe closes, the hold reads the end of its input and lets go.
    await seen[0]!.closeInput()
    expect(await seen[0]!.exited).toBe(0)
    expect(locks()).toEqual([])
    expect((await h.call("s1", "status")).text).toContain("posse perdida: T01 (sem travas no jlock")
  })

  test("a subagent whose session ends with its task in progress gives it back (log agent-ended); one that finished changes nothing", async () => {
    const { repo, h } = await setup()
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    const dir = join(repo, ".scratch/jtasks/runs", run)
    const tasksOf = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks as { id: string; status: string }[]
    const locks = () => (JSON.parse(sh(repo, "jlock", "list", "--group", run, "--json")) as { locks: unknown[] }).locks
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(50)
      expect(check()).toBe(true)
    }

    // c1 starts T01 and its session goes idle without done: the task goes back to the queue, its lock too.
    h.addSession("c1", "s1")
    expect((await h.call("c1", "start T01")).ok).toBe(true)
    expect(locks()).toHaveLength(1)
    h.emit("session.idle", { sessionID: "c1" })
    // The release writes pending first, then gives the lock back: wait for both.
    await until(() => tasksOf()[0]!.status === "pending" && locks().length === 0)
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.at(-1)).toMatchObject({ action: "agent-ended", task: "T01", from: "in_progress", to: "pending" })

    // The root session going idle is the orchestrator waiting: nothing happens.
    h.addSession("c2", "s1")
    expect((await h.call("c2", "start T02")).ok).toBe(true)
    h.emit("session.idle", { sessionID: "s1" })
    await Bun.sleep(300)
    expect(tasksOf()[1]!.status).toBe("in_progress")

    // c2 finishes T02 before its session is deleted: nothing changes.
    writeFiles(repo, { "src/recorder/rec.ts": "export const rec = 1\n" })
    expect((await h.call("c2", 'done T02 --evidence "ok"')).ok).toBe(true)
    h.emit("session.deleted", { sessionID: "c2" })
    await Bun.sleep(300)
    expect(tasksOf()[1]!.status).toBe("done")
  })
})
