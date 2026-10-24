import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PLUGIN_ID, TOOL_NAME } from "../server.ts"
import { cleanupTemp, fakeHost, makeRepo, sh, writeFiles } from "./fake-host.ts"

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const c of cleanups) await c()
  await Bun.sleep(400)
  cleanupTemp()
})

const plan = {
  objective: "Duas fatias em paralelo",
  profiles: {
    impl: { claude: { model: "sonnet" }, opencode: { agent: "impl", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } } },
    deep: { claude: { model: "opus" }, opencode: { agent: "impl-deep" } },
  },
  tasks: [
    { id: "T01", title: "Movimento", files: ["src/move.ts"], acceptance: ["move.ts existe"] },
    { id: "T02", title: "Gravador", files: ["src/recorder"], profile: "deep" },
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
  test("registers the tasks tool and its hooks", async () => {
    const { h } = await setup()
    expect(PLUGIN_ID).toBe("goal-tasks")
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
    expect(h.agents.get("impl")!.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })

    const system = await h.request("s1")
    expect(system).toHaveLength(2)
    expect(system[1]!.text).toContain(`goal-tasks: execução ligada ${run} · feitas 0/3 (0%) · restam 3`)
    expect(system[1]!.text).toContain("1. Chame tasks next.")

    const next = await h.call("s1", "next")
    expect(next.text).toContain("prontas (2)")

    // One model response with two subagent calls: both pass the hook, each gets its profile's agent.
    const [a, b] = await Promise.all([
      h.subagent("s1", { agent: "build", description: "T01", prompt: `--run ${run} --task T01 Movimento. Chame tasks start T01…` }),
      h.subagent("s1", { agent: "build", description: "T02", prompt: `--run ${run} --task T02 Gravador. Chame tasks start T02…` }),
    ])
    expect(a.agent).toBe("impl")
    expect(b.agent).toBe("impl-deep")

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
      message: "fora da posse de T01: src/other.ts; use tasks claim T01 src/other.ts",
    })
    expect(await h.permission("c1", "shell", ['git commit -m "x"'])).toMatchObject({
      effect: "deny",
      message: "subagente não roda git commit: o commit é feito por tasks done T01",
    })
    expect(await h.permission("c1", "shell", ["bun test"])).toMatchObject({ effect: "allow" })
    expect(await h.permission("c1", "read", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    // The main agent edits freely, but never the run's files.
    expect(await h.permission("s1", "edit", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    const tj = `.scratch/goal-tasks/runs/${run}/tasks.json`
    expect((await h.permission("s1", "edit", [tj])).effect).toBe("deny")
    // After claim, the file is in the ownership.
    await h.call("c1", "claim T01 src/other.ts")
    expect(await h.permission("c1", "edit", ["src/other.ts"])).toMatchObject({ effect: "allow" })
    await h.call("c1", "release T01")
    expect(JSON.parse(readFileSync(join(repo, ".scratch/goal-tasks/runs", run, "tasks.json"), "utf8")).tasks[0].status).toBe("pending")
  })

  test("a subagent call of an unknown task is refused; another --run than the bound one is refused", async () => {
    const { h } = await setup()
    const planned = await h.call("s1", "plan", plan)
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    await expect(h.subagent("s1", { agent: "build", description: "x", prompt: `--run ${run} --task T09 x` })).rejects.toThrow(
      `goal-tasks: a execução ${run} não tem a tarefa T09`,
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
    expect((await h.request("s2"))[1]!.text).toContain(`execução ligada ${run}`)
  })
})
