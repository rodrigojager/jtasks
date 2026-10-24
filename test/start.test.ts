import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Resident } from "../src/host.ts"
import type { TasksFile } from "../src/schema.ts"
import { CLI, cleanupTemp, foreignHold, jlockListJson, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
const residents: Resident[] = []
afterAll(async () => {
  for (const r of residents) await r.stop()
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src/a.ts"] },
  { id: "T02", title: "Tipos", files: ["src/types"] },
  { id: "T03", title: "Junta", dependsOn: ["T01", "T02"], files: ["src"] },
  { id: "T04", title: "Integração", dependsOn: ["T03"], exclusive: true },
]

async function newRun(extra: object = {}) {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: { tasks: plan, ...extra } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/goal-tasks/runs", r.bind!) }
}

const readTasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile

describe("next / start / status with the real jlock", () => {
  test("two independent tasks come out of next together; start holds their keys in jlock list --group", async () => {
    const { repo, run, dir } = await newRun()
    const next = await tasksOk(repo, ["next"])
    expect((next.data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T01", "T02"])
    expect(next.text).toContain("bloqueadas: T03 ⛔ T01, T02 | T04 ⛔ T03")

    // The CLI form: holds are detached and outlive the command.
    const p = Bun.spawnSync(["bun", CLI, "start", "T01"], { cwd: repo, env: process.env })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain(`T01 em andamento (tentativa 1): posse travada no jlock (1 chave(s), dono gt:${run}/T01)`)
    await tasksOk(repo, ["start", "T02"])

    const locks = jlockListJson("--group", run)
    expect(locks.map((l) => [l.key.replace(/^.*\/(src\/.*)$/, "$1"), l.holder?.owner])).toEqual([
      ["src/a.ts", `gt:${run}/T01`],
      ["src/types", `gt:${run}/T02`],
    ])
    const t = readTasksFile(dir)
    const t1 = t.tasks[0]!
    expect(t1).toMatchObject({ status: "in_progress", attempts: 1, owner: "cli" })
    expect(t1.holds).toHaveLength(1)
    expect(t1.holds![0]).toMatchObject({ kind: "start", keys: [expect.stringMatching(/src\/a\.ts$/)] })
    expect(existsSync(join(dir, t1.holds![0]!.out!))).toBe(true)
    expect(readFileSync(join(dir, "tickets/01-base.md"), "utf8")).toContain("**Status:** in_progress")

    const status = await tasksOk(repo, ["status"])
    expect(status.text.split("\n")[0]).toBe("feitas 0/4 (0%) · 2 em andamento · restam 4")
    expect(status.text).toContain(`travas ativas (jlock --group ${run}): src/a.ts → T01 · src/types → T02`)
  })

  test("a second start of the same task is refused", async () => {
    const { repo } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const again = await tasks(repo, ["start", "T01"])
    expect(again.ok).toBe(false)
    expect(again.text).toBe("T01 não está pendente: está in_progress (dono: cli)")
  })

  test("a key held by someone else: next leaves the task out and start refuses without writing", async () => {
    const { repo, run, dir } = await newRun()
    const other = await foreignHold([join(repo, "src")], "editor-x")
    residents.push(other)
    const next = await tasksOk(repo, ["next"])
    expect((next.data as { ready: unknown[] }).ready).toEqual([])
    expect(next.text).toContain("T01 🔒 outro programa: editor-x: src/a.ts (via src)")
    const start = await tasks(repo, ["start", "T02"])
    expect(start.ok).toBe(false)
    expect(start.text).toBe("T02 não estava pronta: src/types em uso por outro programa: editor-x (via src); nada foi gravado")
    expect(readTasksFile(dir).tasks[1]!.status).toBe("pending")
    expect(readTasksFile(dir).revision).toBe(1)
    expect(jlockListJson("--group", run)).toEqual([])
    await other.send("release\n")
    expect(await other.exited).toBe(0)
  })

  test("dependencies and pause are checked by start; an exclusive task holds *", async () => {
    // `*` conflicts with every lock on the machine: give back what the earlier tests still hold.
    for (const r of runs) releaseGroup(r)
    for (const r of residents) await r.stop()
    const { repo, run, dir } = await newRun()
    const early = await tasks(repo, ["start", "T03"])
    expect(early.text).toBe("T03 não está pronta: depende de T01, T02")
    // Finish the chain by hand (done comes in the next ticket): mark T01..T03 as done in the file.
    const t = readTasksFile(dir)
    for (const x of t.tasks.slice(0, 3)) x.status = "done"
    await Bun.write(join(dir, "tasks.json"), JSON.stringify(t))
    const next = await tasksOk(repo, ["next"])
    expect((next.data as { ready: { id: string; exclusive: boolean }[] }).ready).toMatchObject([{ id: "T04", exclusive: true }])
    await tasksOk(repo, ["start", "T04"])
    expect(jlockListJson("--group", run).map((l) => l.key)).toEqual(["*"])
    releaseGroup(run)
  })

  test("long-lived host: the hold stays attached and lives in ctx.residents", async () => {
    const { repo, run } = await newRun()
    const residentsMap = new Map<string, Resident[]>()
    await tasksOk(repo, ["start", "T01"], { residents: residentsMap })
    const mine = residentsMap.get(`${run}/T01`)!
    expect(mine).toHaveLength(1)
    residents.push(...mine)
    expect(jlockListJson("--group", run)).toHaveLength(1)
    expect(await mine[0]!.send("release\n")).toBe(true)
    expect(await mine[0]!.exited).toBe(0)
    expect(jlockListJson("--group", run)).toEqual([])
  })
})
