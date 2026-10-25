import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RunState } from "../src/frontier.ts"
import type { JlockLock } from "../src/jlock.ts"
import { checkKeepalive, holdKeepalive, keepaliveDecision, keepaliveTries, progressSignature, readKeepalive, type KeepaliveInput } from "../src/keepalive.ts"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES, type PlanTask, type RunFile, type Task } from "../src/schema.ts"
import { validatePlan } from "../src/validate.ts"
import { cleanupTemp, host, makeRepo, tasks, tasksOk } from "./helpers.ts"

afterAll(cleanupTemp)

const ROOT = "D:/Proj"
const RUN = "r-261025-abcd"
const ACTOR = "claude:s1"

function state(list: (PlanTask & Partial<Task>)[], run: Partial<RunFile> = {}): RunState {
  return {
    root: ROOT,
    dir: `${ROOT}/.scratch/jtasks/runs/${RUN}`,
    run: { id: RUN, status: "active", ...run } as RunFile,
    tasks: {
      version: 1,
      run: RUN,
      revision: 1,
      profiles: DEFAULT_PROFILES,
      tasks: list.map((t) => ({ ...toTask(t, DEFAULT_PROFILES), ...(t.status ? { status: t.status } : {}), ...(t.owner !== undefined ? { owner: t.owner } : {}) })),
    },
  }
}

const decide = (s: RunState, extra: Partial<KeepaliveInput> = {}) =>
  keepaliveDecision({ state: s, locks: [], platform: "win32", liveAgents: 0, actor: ACTOR, ...extra })

// The real case (fase-4-formularios-pii): T07 done, T08 ready, no agent left alive.
const real = () =>
  state([
    { id: "T05", title: "a", files: ["src/a.ts"], status: "done" },
    { id: "T07", title: "b", files: ["src/b.ts"], status: "done" },
    { id: "T08", title: "c", files: ["src/c.ts"], dependsOn: ["T07"] },
    { id: "T09", title: "d", files: ["src/d.ts"], dependsOn: ["T08"] },
  ])

describe("keepaliveDecision", () => {
  test("a ready task with no agent alive: a message for the model that names it", () => {
    const d = decide(real())
    expect(d.action).toBe("nudge")
    if (d.action !== "nudge") return
    expect(d.tries).toBe(1)
    expect(d.ready).toEqual(["T08"])
    expect(d.text).toContain(`jtasks: run ${RUN} is idle · done 2/4 · 2 left · ready: T08 · no subagent is running.`)
    expect(d.text).toContain("call jtasks next")
    expect(d.text).toContain("call jtasks pause")
  })

  test("nothing to do: paused, off, finished, an agent alive, only blocked or failed tasks", () => {
    expect(decide(state([{ id: "T01", title: "a" }], { status: "paused" }))).toEqual({ action: "none", reason: "paused" })
    expect(decide(state([{ id: "T01", title: "a" }], { keepalive: false }))).toEqual({ action: "none", reason: "off" })
    expect(decide(state([{ id: "T01", title: "a", status: "done" }]))).toEqual({ action: "none", reason: "finished" })
    expect(decide(state([{ id: "T01", title: "a", status: "skipped" }], { status: "done" }))).toEqual({ action: "none", reason: "finished" })
    expect(decide(real(), { liveAgents: 1 })).toEqual({ action: "none", reason: "agents-running" })
    const stuck = state([
      { id: "T01", title: "a", status: "failed" },
      { id: "T02", title: "b", dependsOn: ["T01"] },
    ])
    expect(decide(stuck)).toEqual({ action: "none", reason: "nothing-ready" })
    // Ownership taken by someone else is not ready either: the same frontier as `next`.
    const locked = state([{ id: "T01", title: "a", files: ["src/a.ts"] }])
    const locks: JlockLock[] = [{ key: "d:/proj/src/a.ts", holder: { owner: "vim" }, queue: [] }]
    expect(decide(locked, { locks })).toEqual({ action: "none", reason: "nothing-ready" })
  })

  test("a task in progress with nobody on it: continue it or release it; another session's is left alone", () => {
    const mine = state([{ id: "T05", title: "a", status: "in_progress", owner: `${ACTOR}/agent:a1` }, { id: "T06", title: "b", dependsOn: ["T05"] }])
    const d = decide(mine)
    expect(d.action).toBe("nudge")
    if (d.action === "nudge") {
      expect(d.orphans).toEqual(["T05"])
      expect(d.text).toContain("T05 is in progress and no subagent is running: continue it yourself, or call jtasks release T05")
    }
    const theirs = state([{ id: "T05", title: "a", status: "in_progress", owner: "opencode:ses_9/agent:x" }, { id: "T06", title: "b", dependsOn: ["T05"] }])
    expect(decide(theirs)).toEqual({ action: "none", reason: "nothing-ready" })
  })

  test("the same progress again: tries go up, then the host gives up and tells the person; progress starts over", () => {
    const s = real()
    const first = decide(s)
    if (first.action !== "nudge") throw new Error(first.action)
    const at = "2026-10-25T10:00:00.000Z"
    const second = decide(s, { last: { signature: first.signature, action: "nudge", tries: 1, at } })
    expect(second).toMatchObject({ action: "nudge", tries: 2 })
    const third = decide(s, { last: { signature: first.signature, action: "nudge", tries: 2, at } })
    expect(third.action).toBe("stalled")
    if (third.action === "stalled") expect(third.notice).toBe(`a execução ${RUN} está parada com T08 por fazer e nada rodando; 2 mensagem(ns) sem progresso, o host desistiu (jtasks keepalive on volta a vigiar)`)
    // Given up: quiet from then on, until the run moves.
    expect(decide(s, { last: { signature: first.signature, action: "stalled", tries: 3, at } })).toEqual({ action: "none", reason: "stalled" })
    expect(decide(s, { last: { signature: first.signature, action: "held", tries: 0, at } })).toEqual({ action: "none", reason: "held" })
    const moved = state([
      { id: "T05", title: "a", status: "done" },
      { id: "T07", title: "b", status: "done" },
      { id: "T08", title: "c", status: "done" },
      { id: "T09", title: "d", dependsOn: ["T08"] },
    ])
    expect(progressSignature(moved.tasks)).not.toBe(first.signature)
    expect(decide(moved, { last: { signature: first.signature, action: "stalled", tries: 3, at } })).toMatchObject({ action: "nudge", tries: 1, ready: ["T09"] })
    // maxTries 0: give up at once.
    expect(decide(s, { maxTries: 0 }).action).toBe("stalled")
  })

  test("a turn that ended on an API error or a refusal: nothing is sent, the person is told at once", () => {
    const d = decide(real(), { cause: "error" })
    expect(d).toMatchObject({ action: "stalled", cause: "error", ready: ["T08"] })
    if (d.action === "stalled") expect(d.notice).toBe(`a execução ${RUN} parou num erro com T08 por fazer e nada rodando; depois de um erro o host não manda nada (mande uma mensagem para seguir)`)
    // Nothing to do, or already told: quiet.
    expect(decide(real(), { cause: "error", liveAgents: 1 })).toEqual({ action: "none", reason: "agents-running" })
    const signature = progressSignature(real().tasks)
    expect(decide(real(), { cause: "error", last: { signature, action: "stalled", tries: 1, at: "x", cause: "error" } })).toEqual({ action: "none", reason: "stalled" })
  })

  test("JTASKS_KEEPALIVE_TRIES: a number of messages; empty or junk is the default", () => {
    const env = (v: string | undefined) => ({ ...host, env: (name: string) => (name === "JTASKS_KEEPALIVE_TRIES" ? v : undefined) }) as typeof host
    expect(keepaliveTries(env(undefined))).toBe(2)
    expect(keepaliveTries(env(""))).toBe(2)
    expect(keepaliveTries(env("  "))).toBe(2)
    expect(keepaliveTries(env("x"))).toBe(2)
    expect(keepaliveTries(env("-1"))).toBe(2)
    expect(keepaliveTries(env("0"))).toBe(0)
    expect(keepaliveTries(env(" 5 "))).toBe(5)
  })
})

describe("keepalive in the tool", () => {
  const PLAN = { tasks: [{ id: "T01", title: "Base", files: ["src/a.ts"] }, { id: "T02", title: "Depois", files: ["src/b.ts"], dependsOn: ["T01"] }] }

  test("the plan accepts keepalive: false; anything else that is not a boolean is refused", async () => {
    expect(validatePlan({ ...PLAN, keepalive: false }).errors).toEqual([])
    expect(validatePlan({ ...PLAN, keepalive: "no" }).errors).toEqual(['"keepalive" deve ser true ou false'])
    const repo = makeRepo("keepalive-plan")
    const r = await tasksOk(repo, ["plan", JSON.stringify({ ...PLAN, keepalive: false })])
    const dir = (r.data as { dir: string }).dir
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).keepalive).toBe(false)
    expect((await tasksOk(repo, ["status"])).text).toContain("retomada: desligada")
  })

  test("keepalive on|off writes run.json and the log; status says it; unpause and on forget what was sent", async () => {
    const repo = makeRepo("keepalive-cli")
    const r = await tasksOk(repo, ["plan", JSON.stringify(PLAN)])
    const { dir, run } = r.data as { dir: string; run: string }
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).keepalive).toBe(true)
    expect((await tasks(repo, ["keepalive", "maybe"])).code).toBe(2)
    expect((await tasksOk(repo, ["keepalive", "off"])).text).toBe(`execução ${run}: retomada desligada (só o modelo mantém o laço andando)`)
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).keepalive).toBe(false)
    expect((await tasksOk(repo, ["status"])).text).toContain("retomada: desligada")
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toEqual({ action: "none", reason: "off" })
    await tasksOk(repo, ["keepalive", "on"])
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.filter((e) => e.action === "keepalive").map((e) => [e.from, e.to])).toEqual([["on", "off"], ["off", "on"]])

    // The end of a turn, twice with no progress, then the host gives up: keepalive.json and the log keep it.
    const one = await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })
    expect(one).toMatchObject({ action: "nudge", tries: 1, ready: ["T01"] })
    expect((await tasksOk(repo, ["status"])).text).toMatch(/retomada: reabriu o laço em \S+ \(mensagem 1 de 2\)/)
    // A check before delivering does not count.
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, fresh: true })).toMatchObject({ action: "nudge", tries: 1 })
    // What the model may answer with never resets the count: unpause and resume of a run that is not paused,
    // keepalive on while it is on and has not given up.
    await tasksOk(repo, ["unpause"])
    await tasksOk(repo, ["resume", run])
    await tasksOk(repo, ["keepalive", "on"])
    expect(await readKeepalive(host, dir)).toMatchObject({ action: "nudge", tries: 1 })
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toMatchObject({ action: "nudge", tries: 2 })
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toMatchObject({ action: "stalled", tries: 3 })
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toEqual({ action: "none", reason: "stalled" })
    expect((await tasksOk(repo, ["status"])).text).toContain("retomada desistiu: T01 por fazer, nada rodando, 2 mensagem(ns) sem progresso")
    const events = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action)
    expect(events.filter((a) => a.startsWith("keepalive-"))).toEqual(["keepalive-nudge", "keepalive-nudge", "keepalive-stalled"])
    await tasksOk(repo, ["keepalive", "on"])
    expect(existsSync(join(dir, "keepalive.json"))).toBe(false)

    // An API error: told at once, said by status, quiet after.
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true, cause: "error" })).toMatchObject({ action: "stalled", cause: "error" })
    expect((await tasksOk(repo, ["status"])).text).toContain("retomada parada depois de um erro: T01 por fazer, nada rodando")
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toEqual({ action: "none", reason: "stalled" })
    await tasksOk(repo, ["keepalive", "on"])

    // An interruption holds it until the run moves; pause stops it; unpause starts over.
    await holdKeepalive(host, repo, run)
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0, commit: true })).toEqual({ action: "none", reason: "held" })
    expect((await tasksOk(repo, ["status"])).text).toContain("retomada: em silêncio depois de uma interrupção")
    await tasksOk(repo, ["pause"])
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0 })).toEqual({ action: "none", reason: "paused" })
    await tasksOk(repo, ["unpause"])
    expect(await readKeepalive(host, dir)).toBeUndefined()
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 0 })).toMatchObject({ action: "nudge", tries: 1 })
    expect(await checkKeepalive(host, { root: repo, run, liveAgents: 2 })).toEqual({ action: "none", reason: "agents-running" })
  })

  test("help lists the action", async () => {
    const repo = makeRepo("keepalive-help")
    expect((await tasksOk(repo, ["help"])).text).toContain("keepalive on|off")
    expect((await tasksOk(repo, ["help", "keepalive"])).text).toContain("o host reabre o laço")
  })
})
