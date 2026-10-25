import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Resident } from "../src/host.ts"
import { earliestExpiry, renewRun, renewMargin, ttlMs } from "../src/renew.ts"
import { takenSince } from "../src/keep.ts"
import type { TasksFile } from "../src/schema.ts"
import { cleanupTemp, context, foreignHold, jlockListJson, makeRepo, releaseGroup, tasks, tasksOk, tempDir, writeFiles } from "./helpers.ts"

// Real git and jlock processes, and holds that expire in seconds.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Longa", files: ["src/a.ts"] },
  { id: "T02", title: "Depois", files: ["src/b.ts"], dependsOn: ["T01"] },
]

async function newRun(holdTtl: string, extra: object = {}) {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: { tasks: plan, holdTtl }, ...extra })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const logActions = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action as string)
const mine = (run: string, task = "T01") => jlockListJson("--group", run).filter((l) => l.holder?.owner === `gt:${run}/${task}` && !(l.holder as { stale?: boolean }).stale)
const since = (run: string) => (mine(run)[0]?.holder as { since?: string } | undefined)?.since
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(100)
  expect(check()).toBe(true)
}

describe("holds that outlive the run's holdTtl", () => {
  test("durations and margins", () => {
    expect(ttlMs("2h")).toBe(7_200_000)
    expect(ttlMs("500ms")).toBe(500)
    expect(ttlMs("1d")).toBe(86_400_000)
    expect(ttlMs("x")).toBe(0)
    // Ten minutes before a 2 h hold expires; half of a short one, but never less than two passes of the host.
    expect(renewMargin(ttlMs("2h"))).toBe(600_000)
    expect(renewMargin(ttlMs("4s"), 1000)).toBe(2000)
    expect(renewMargin(ttlMs("90s"))).toBe(120_000)
  })

  test("the expiry is jlock's own (it counts renew), else since + ttl from a jlock before 0.2.0", () => {
    const since = "2026-10-25T10:00:00.000Z"
    const lock = (holder: object) => ({ key: "k", holder: { owner: "o", since, ...holder }, queue: [] })
    expect(earliestExpiry([lock({ ttl_secs: 3600 })])).toBe(Date.parse("2026-10-25T11:00:00.000Z"))
    expect(earliestExpiry([lock({ ttl_secs: 3600, expires: "2026-10-25T15:00:00.000Z" })])).toBe(Date.parse("2026-10-25T15:00:00.000Z"))
    expect(earliestExpiry([lock({ ttl_secs: null, expires: null })])).toBeUndefined()
    expect(earliestExpiry([lock({ ttl_secs: 60 }), lock({ ttl_secs: 3600, expires: "2026-10-25T10:00:30.000Z" })])).toBe(Date.parse("2026-10-25T10:00:30.000Z"))
  })

  test("done takes back its own keys when the hold expired and nobody took them; the commit goes in", async () => {
    const { repo, run, dir } = await newRun("2s")
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    await until(() => mine(run).length === 0)
    expect((await tasksOk(repo, ["status"])).text).toContain("posse perdida: T01")
    const r = await tasksOk(repo, ["done", "T01", "--evidence", "ok"])
    expect(r.text).toMatch(/T01 feita: commit \w+/)
    expect(tasksFile(dir).tasks[0]!.status).toBe("done")
    expect(logActions(dir)).toContain("retake")
    expect(mine(run)).toEqual([])
  })

  test("done still refuses when someone else took the expired keys", async () => {
    const { repo, run } = await newRun("2s")
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    await until(() => mine(run).length === 0)
    const other = await foreignHold([join(repo, "src/a.ts").replace(/\\/g, "/")], "vim")
    try {
      const r = await tasks(repo, ["done", "T01", "--evidence", "ok"])
      expect(r.ok).toBe(false)
      expect(r.text).toContain("T01")
      expect(r.text).toContain("src/a.ts")
    } finally {
      await other.stop()
    }
  })

  test("a host that stays open renews the hold before it expires: the lock outlives the ttl (jlock hold --detach)", async () => {
    const { repo, run, dir } = await newRun("4s")
    await tasksOk(repo, ["start", "T01"])
    const first = since(run)
    const ctx = context(repo, { boundRun: run })
    // Far from the expiry (more than half the ttl left): nothing to do.
    expect(await renewRun(ctx, run, () => true, 1000)).toEqual([{ task: "T01", result: "fresh" }])
    await Bun.sleep(2500)
    expect(await renewRun(ctx, run, () => true, 1000)).toEqual([{ task: "T01", result: "renewed" }])
    // In place (jlock renew): the same grant, never let go, and the new deadline is far again.
    expect(since(run)).toBe(first)
    expect(await renewRun(ctx, run, () => true, 1000)).toEqual([{ task: "T01", result: "fresh" }])
    // Past the first hold's ttl, the task still holds its file.
    await Bun.sleep(2500)
    expect(mine(run).length).toBe(1)
    expect(since(run)).toBe(first)
    expect(logActions(dir)).toContain("renew")
    expect(logActions(dir)).not.toContain("retake")
    // Tasks the host did not start are not its to renew.
    expect(await renewRun(ctx, run, (owner) => owner.startsWith("opencode:"), 1000)).toEqual([])
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    await tasksOk(repo, ["done", "T01", "--evidence", "ok"])
    expect(mine(run)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("with a jlock before 0.2.0 (no renew), the holds are given back and taken again", async () => {
    // A jlock that says it is 0.1.1 and knows no renew; everything else goes to the real one.
    const real = Bun.which("jlock")!
    const old = join(tempDir("old-jlock"), "jlock")
    writeFileSync(old, `#!/bin/sh\ncase "$1" in --version) echo "jlock 0.1.1"; exit 0;; renew) echo "unknown command: renew" >&2; exit 2;; esac\nexec "${real}" "$@"\n`)
    chmodSync(old, 0o755)
    const { repo, run, dir } = await newRun("4s")
    await tasksOk(repo, ["start", "T01"])
    const first = since(run)
    const ctx = context(repo, { boundRun: run, host: { ...context(repo).host, env: (name: string) => (name === "JLOCK_BIN" ? old : process.env[name]) } })
    await Bun.sleep(2500)
    expect(await renewRun(ctx, run, () => true, 1000)).toEqual([{ task: "T01", result: "renewed" }])
    expect(since(run)).not.toBe(first)
    await Bun.sleep(2500)
    expect(mine(run).length).toBe(1)
    expect(logActions(dir)).toContain("renew")
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    await tasksOk(repo, ["done", "T01", "--evidence", "ok"])
    expect(mine(run)).toEqual([])
  })

  test("the plugin's holds (--release-on-eof) are renewed too, and the task is never marked lost", async () => {
    const residents = new Map<string, Resident[]>()
    const extra = { tool: "opencode" as const, session: "ses1", residents, holdMode: "eof" as const }
    const { repo, run, dir } = await newRun("4s", extra)
    await tasksOk(repo, ["start", "T01"], extra)
    const ctx = context(repo, { ...extra, boundRun: run })
    await Bun.sleep(2500)
    expect(await renewRun(ctx, run, (owner) => owner.startsWith("opencode:ses1"), 1000)).toEqual([{ task: "T01", result: "renewed" }])
    await Bun.sleep(2500)
    expect(tasksFile(dir).tasks[0]).toMatchObject({ status: "in_progress" })
    expect(tasksFile(dir).tasks[0]!.lost).toBeUndefined()
    expect(mine(run).length).toBe(1)
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    await tasksOk(repo, ["done", "T01", "--evidence", "ok"], extra)
    await until(() => mine(run).length === 0)
    for (const list of residents.values()) for (const r of list) await r.stop()
  })

  test("done does not take back a key another task took meanwhile (its edits would go in this commit)", async () => {
    const { repo, run, dir } = await newRun("2s")
    await tasksOk(repo, ["start", "T01"])
    await until(() => mine(run).length === 0)
    const key = join(repo, "src/a.ts").replace(/\\/g, "/").toLowerCase()
    const t01 = tasksFile(dir).tasks[0]!
    const state = { root: repo, dir, run: { id: run } as never, tasks: tasksFile(dir) }
    const ctx = context(repo)
    expect(await takenSince(ctx.host, state.dir, t01.id, [key])).toEqual([])
    // Another task of the run claims the file after T01's hold, then gives it back with its edits on disk.
    const later = new Date(Date.now() + 1000).toISOString()
    const { appendFileSync } = await import("node:fs")
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: later, actor: "cli", action: "claim", task: "T02", keys: [key] })}\n`)
    expect(await takenSince(ctx.host, state.dir, t01.id, [key])).toEqual([key])
    writeFiles(repo, { "src/a.ts": "edits of T02\n" })
    const r = await tasks(repo, ["done", "T01", "--evidence", "ok"])
    expect(r.ok).toBe(false)
    expect(r.text).toContain("src/a.ts")
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
  })

  test("a key someone else took does not cost the free ones: those are taken back, the pass says lost", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["plan"], { json: { holdTtl: "2s", tasks: [{ id: "T01", title: "Duas", files: ["src/a.ts", "src/b.ts"] }] } })
    const run = r.bind!
    runs.push(run)
    await tasksOk(repo, ["start", "T01"])
    await until(() => mine(run).length === 0)
    const other = await foreignHold([join(repo, "src/b.ts").replace(/\\/g, "/")], "vim")
    try {
      expect(await renewRun(context(repo, { boundRun: run }), run, () => true, 1000)).toEqual([{ task: "T01", result: "lost" }])
      expect(mine(run).map((l) => l.key.endsWith("src/a.ts"))).toEqual([true])
    } finally {
      await other.stop()
    }
  })
})

