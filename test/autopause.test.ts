// The pause a host makes on a transient failure of the provider (rev. 5.7), with real git and jlock: the task stays
// in progress with its locks, the way back takes back what expired and names the agent to resume.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pauseForFailure, resumeIfDue } from "../src/autopause.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { classifyFailure } from "../src/transient.ts"
import { cleanupTemp, context, jlockListJson, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src/a.ts"] },
  { id: "T02", title: "Lib", files: ["lib"] },
]

async function newRun() {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: { tasks: plan } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const runFile = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile
const held = (run: string) => jlockListJson("--group", run).filter((l) => l.holder?.owner === `gt:${run}/T01`).length

const limit = () => {
  const c = classifyFailure({ kind: "rate_limit", texts: ["API Error: You've hit your session limit · resets in 20 minutes"] }, new Date())
  if (!c.transient) throw new Error("not transient")
  return c
}

describe("transient pause", () => {
  test("the task stays in progress with its lock; start is refused; unpause takes back an expired lock and names the agent", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const pause = await pauseForFailure(context(repo), { run, failure: limit(), task: "T01", agent: "a1" })
    expect(pause).toMatchObject({ kind: "quota", tasks: [{ id: "T01", agent: "a1" }], streak: 0 })
    expect(Date.parse(pause!.resetAt!)).toBeGreaterThan(Date.now() + 19 * 60_000)
    expect(Date.parse(pause!.resumeAt!)).toBeGreaterThan(Date.parse(pause!.resetAt!))
    expect(runFile(dir).status).toBe("paused")
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
    expect(held(run)).toBe(1)
    const status = await tasksOk(repo, ["status"])
    expect(status.text).toContain("falha transitória (limite de uso ou cota")
    expect(status.text).toContain("T01 mantida(s) em andamento com as travas")
    expect((await tasks(repo, ["start", "T02"])).ok).toBe(false)
    // The host died meanwhile and the hold expired: unpause takes it back.
    releaseGroup(run)
    await Bun.sleep(300)
    expect(held(run)).toBe(0)
    const back = await tasksOk(repo, ["unpause"])
    expect(back.text).toContain("T01 continua(m) em andamento com as travas")
    expect(back.text).toContain("Resume the same subagent (the same subagent (a1))")
    expect(back.text).toContain("Do not open a new subagent for T01")
    expect(runFile(dir).status).toBe("active")
    expect(runFile(dir).pause).toBeUndefined()
    expect(held(run)).toBe(1)
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
  })

  test("a pause by hand over it stops the automatic resume; the clock resumes one that is due, counting the streak", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await pauseForFailure(context(repo), { run, failure: limit(), task: "T01" })
    await tasksOk(repo, ["pause"])
    expect(runFile(dir).pause?.resumeAt).toBeUndefined()
    expect(await resumeIfDue(context(repo), run)).toBeUndefined()
    await tasksOk(repo, ["unpause"])
    // Again, now due: the host's clock leaves it.
    await pauseForFailure(context(repo), { run, failure: limit(), task: "T01" })
    const r = runFile(dir)
    r.pause!.resumeAt = new Date(Date.now() - 1000).toISOString()
    writeFileSync(join(dir, "run.json"), JSON.stringify(r))
    const left = await resumeIfDue(context(repo), run)
    expect(left?.kept).toEqual(["T01"])
    expect(runFile(dir)).toMatchObject({ status: "active", pauseStreak: { n: 1 } })
    // The next transient pause at the same progress waits longer (no reset said: the backoff doubles).
    const overloaded = classifyFailure({ kind: "overloaded", texts: ["Overloaded"] }, new Date())
    if (!overloaded.transient) throw new Error("not transient")
    const again = await pauseForFailure(context(repo), { run, failure: overloaded })
    expect(again?.streak).toBe(1)
    expect(Date.parse(again!.resumeAt!) - Date.now()).toBeGreaterThan(9 * 60_000)
  })

  test("resume (a new session) keeps the paused task and takes its lock back instead of releasing it", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await pauseForFailure(context(repo), { run, failure: limit(), task: "T01" })
    releaseGroup(run)
    await Bun.sleep(300)
    const r = await tasksOk(repo, ["resume", run])
    expect(r.data).toMatchObject({ kept: ["T01"], released: [] })
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
    expect(runFile(dir).status).toBe("active")
    expect(held(run)).toBe(1)
  })
})
