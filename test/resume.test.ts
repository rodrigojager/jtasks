import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Resident } from "../src/host.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { CLI, REPO_ROOT, cleanupTemp, tempDir, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
const windows: number[] = []
afterAll(async () => {
  for (const pid of windows) killTree(pid)
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

/** Ends one of our own child processes together with its children (the window and its holds), by PID. */
function killTree(pid: number) {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)])
  else
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
}

const plan = [
  { id: "T01", title: "Base", files: ["src/a.ts"] },
  { id: "T02", title: "Lib", files: ["lib"] },
  { id: "T03", title: "Fim", dependsOn: ["T01", "T02"] },
]

async function newRun(extra: object = {}) {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: { tasks: plan, ...extra } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const runFile = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(100)
  }
}

describe("pause", () => {
  test("pause refuses start; unpause allows it again", async () => {
    const { repo, dir } = await newRun()
    const p = await tasksOk(repo, ["pause"])
    expect(p.text).toContain("pausada: start recusado")
    expect(runFile(dir).status).toBe("paused")
    expect((await tasks(repo, ["start", "T01"])).text).toContain("está pausada: não inicie tarefas")
    expect((await tasksOk(repo, ["status"])).text).toContain("pausada: não inicie tarefas")
    expect((await tasksOk(repo, ["next"])).text).toContain("execução pausada: não inicie tarefas")
    await tasksOk(repo, ["unpause"])
    expect(runFile(dir).status).toBe("active")
    await tasksOk(repo, ["start", "T01"])
  })
})

describe("resume after a dead window", () => {
  test("the window dies with its holds; the lock expires and resume releases the task, keeping one whose locks live", async () => {
    const { repo, run, dir } = await newRun()
    // T02 is held by the CLI (`hold --detach`: jlock's keeper lives on): resume must keep it.
    await tasksOk(repo, ["start", "T02"])
    const win = Bun.spawn(["bun", join(REPO_ROOT, "test/window.ts"), repo, "T01"], { stdout: "pipe", env: process.env })
    windows.push(win.pid)
    const reader = win.stdout.getReader()
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]!)
    reader.releaseLock()
    expect(first.ok).toBe(true)
    expect(jlockListJson("--group", run).map((l) => l.holder?.owner).sort()).toEqual([`gt:${run}/T01`, `gt:${run}/T02`])
    writeFiles(repo, { "src/a.ts": "metade\n" })

    killTree(win.pid)
    // ≤ JLOCK_STALE_MS (1.5 s in the tests): the holder of T01 is dead.
    const t0 = Date.now()
    await until(() => (jlockListJson("--group", run).some((l) => l.holder?.owner === `gt:${run}/T01` && !(l.holder as { stale?: boolean }).stale) ? undefined : true))
    expect(Date.now() - t0).toBeLessThan(1500 + 3500)
    expect((await tasksOk(repo, ["status"])).text).toContain("posse perdida: T01 (sem travas no jlock")

    const r = await tasksOk(repo, ["resume", run], { tool: "claude", session: "nova-janela" })
    expect(r.bind).toBe(run)
    expect(r.text).toContain("T01 liberada (sem travas no jlock) → pending; edições no disco: src/a.ts")
    expect(r.text).toContain("mantidas em andamento: T02 (travas vivas)")
    const t = tasksFile(dir)
    expect(t.tasks.map((x) => [x.id, x.status])).toEqual([
      ["T01", "pending"],
      ["T02", "in_progress"],
      ["T03", "pending"],
    ])
    expect(runFile(dir).sessions).toMatchObject([{ tool: "claude", id: "nova-janela" }])
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("metade\n")
    // The next window starts it again.
    await tasksOk(repo, ["start", "T01"])
    expect(tasksFile(dir).tasks[0]!.attempts).toBe(2)
  })

  test("--keep-owners touches no task; resume takes the run out of pause", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    sh(repo, "jlock", "release", "--group", run, "--owner", `gt:${run}/T01`, "--json")
    await tasksOk(repo, ["pause"])
    const r = await tasksOk(repo, ["resume", run, "--keep-owners"])
    expect(r.text).toContain("mantidas em andamento: T01 (--keep-owners)")
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
    expect(runFile(dir).status).toBe("active")
  })
})

describe("lost ownership in a long-lived host", () => {
  test("a hold that ends with 14 sends the task back to pending with log lost", async () => {
    const { repo, run, dir } = await newRun()
    const residents = new Map<string, Resident[]>()
    const exits: number[] = []
    await tasksOk(repo, ["start", "T01"], { residents, onHoldExit: (_r, _t, code) => exits.push(code) })
    sh(repo, "jlock", "unlock", "--group", run, "--force", "--by", "test", "--reason", "simula unlock --force", "--json")
    await until(() => (tasksFile(dir).tasks[0]!.status === "pending" && exits.length ? true : undefined))
    expect(exits).toEqual([14])
    const t = tasksFile(dir).tasks[0]!
    expect(t.lost).toBeString()
    expect(t.holds).toBeUndefined()
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.at(-1)).toMatchObject({ action: "lost", task: "T01", from: "in_progress", to: "pending" })
    expect((await tasksOk(repo, ["status"])).text).toContain("posse perdida: T01")
  })
})

describe("serialize through jlock run", () => {
  const slow = `
const [file, id] = process.argv.slice(2)
const { appendFileSync } = require("node:fs")
appendFileSync(file, "start " + id + " " + Date.now() + "\\n")
await Bun.sleep(700)
appendFileSync(file, "end " + id + " " + Date.now() + "\\n")
`
  test("two exec of a serialized command run one after the other; others run directly", async () => {
    const { repo } = await newRun({ serialize: ["bun slow.ts"] })
    writeFiles(repo, { "slow.ts": slow })
    const logFile = join(tempDir("serial"), "serial.log").replace(/\\/g, "/")
    const a = Bun.spawn(["bun", CLI, "exec", "--", "bun", "slow.ts", logFile, "A"], { cwd: repo, env: process.env, stdout: "pipe" })
    const b = Bun.spawn(["bun", CLI, "exec", "--", "bun", "slow.ts", logFile, "B"], { cwd: repo, env: process.env, stdout: "pipe" })
    expect(await a.exited).toBe(0)
    expect(await b.exited).toBe(0)
    expect(await new Response(a.stdout).text()).toContain("[serializado por jlock run name:gt/")
    const events = readFileSync(logFile, "utf8").trim().split("\n").map((l) => l.split(" "))
    expect(events.map((e) => e[0])).toEqual(["start", "end", "start", "end"])
    expect(events[0]![1]).toBe(events[1]![1])

    const direct = await tasks(repo, ["exec", "--", "git", "--version"])
    expect(direct.ok).toBe(true)
    expect(direct.text).toContain("[direto (fora de serialize); saiu com 0]")
    const failing = await tasks(repo, ["exec", "--", "git", "nao-existe"])
    expect(failing.ok).toBe(false)
    expect(failing.code).toBe(1)
  })
})

describe("the ttl of the run's holds", () => {
  test("a hold whose ttl runs out is a lost ownership: status says so and resume gives the task back", async () => {
    const { repo, run, dir } = await newRun({ holdTtl: "1s" })
    await tasksOk(repo, ["start", "T01"])
    expect(jlockListJson("--group", run).map((l) => (l.holder as { ttl_secs?: number } | null)?.ttl_secs)).toEqual([1])
    await until(() => (jlockListJson("--group", run).some((l) => l.holder?.owner === `gt:${run}/T01` && !(l.holder as { stale?: boolean }).stale) ? undefined : true))
    expect((await tasksOk(repo, ["status"])).text).toContain("posse perdida: T01 (sem travas no jlock")
    const r = await tasksOk(repo, ["resume", run])
    expect(r.text).toContain("T01 liberada (sem travas no jlock) → pending")
    expect(tasksFile(dir).tasks[0]!.status).toBe("pending")
  })
})
