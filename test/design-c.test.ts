// Design C (0.7.0, jlock 0.3): owners in families, exclusive scopes, resources. Every test here failed with
// jtasks 0.6 and jlock 0.2 (an exclusive task held `*`; an exec under it, a fresh owner, waited for a key its own task
// held; nothing knew of resources), and passes now. The file runs on a JLOCK_HOME of its own, so the "machine" tests
// see no lock left by another test file.

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Resident } from "../src/host.ts"
import { cleanupTemp, foreignHold, jlockListJson, makeRepo, releaseGroup, tasks, tasksOk, tempDir, writeFiles } from "./helpers.ts"

setDefaultTimeout(120_000)

const runs: string[] = []
const residents: Resident[] = []
const previousHome = process.env.JLOCK_HOME
beforeAll(() => {
  const home = join(tempDir("design-c-jlock"), "jlock").replace(/\\/g, "/")
  mkdirSync(home, { recursive: true })
  process.env.JLOCK_HOME = home
})
afterAll(async () => {
  for (const r of residents) await r.stop()
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  process.env.JLOCK_HOME = previousHome
  cleanupTemp()
})

async function newRun(plan: object, files?: Record<string, string>) {
  const repo = makeRepo("design-c", files)
  const r = await tasksOk(repo, ["plan"], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind! }
}

const ready = (r: { data?: unknown }) => (r.data as { ready: { id: string }[] }).ready.map((t) => t.id)

describe("design C: owners in families", () => {
  test("an exec of a serialized command inside an exclusive task runs at once (no deadlock); two execs of it still serialize", async () => {
    const slow = `
const [file, id] = process.argv.slice(2)
const { appendFileSync } = require("node:fs")
appendFileSync(file, "start " + id + "\\n")
await Bun.sleep(600)
appendFileSync(file, "end " + id + "\\n")
`
    const { repo, run } = await newRun({ serialize: ["bun slow.ts"], tasks: [{ id: "T01", title: "Integração", exclusive: true }] }, { "slow.ts": slow })
    await tasksOk(repo, ["start", "T01"])
    const logFile = join(tempDir("design-c-serial"), "serial.log").replace(/\\/g, "/")
    const began = Date.now()
    const one = await tasks(repo, ["exec", "--task", "T01", "--timeout", "30s", "--", "bun", "slow.ts", logFile, "A"])
    expect(one.ok).toBe(true)
    expect(one.text).toContain("serializado por jlock run name:gt/")
    expect(Date.now() - began).toBeLessThan(20_000)
    // Two execs of the same task are siblings: they exclude each other on the serialize key.
    const [a, b] = await Promise.all([
      tasks(repo, ["exec", "--task", "T01", "--timeout", "30s", "--", "bun", "slow.ts", logFile, "B"]),
      tasks(repo, ["exec", "--task", "T01", "--timeout", "30s", "--", "bun", "slow.ts", logFile, "C"]),
    ])
    expect(a.ok && b.ok).toBe(true)
    const events = readFileSync(logFile, "utf8").trim().split("\n").map((l) => l.split(" "))
    expect(events.map((e) => e[0])).toEqual(["start", "end", "start", "end", "start", "end"])
    expect(events[2]![1]).toBe(events[3]![1])
    releaseGroup(run)
  })

  test("tree transitions of an exclusive task (release, start with patches, done) work under child owners, with no workaround", async () => {
    const { repo, run } = await newRun({ tasks: [{ id: "T01", title: "Tudo", exclusive: true }] }, { "README.md": "# x\n", "src/a.ts": "a\n" })
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a changed\n" })
    // release keeps the edit as a patch (under the tree key), start brings it back (under the tree key too).
    const released = await tasksOk(repo, ["release", "T01"])
    expect(released.text).toContain("src/a.ts")
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("a\n")
    const again = await tasksOk(repo, ["start", "T01"])
    expect(again.text).toContain("src/a.ts")
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("a changed\n")
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "ok"])
    expect(done.ok).toBe(true)
    // Nothing of the run is left in jlock: no tree key, no task hold.
    expect(jlockListJson("--group", run).filter((l) => l.holders.some((h) => h.owner.startsWith(`gt:${run}/`)))).toEqual([])
    expect(jlockListJson().filter((l) => l.key.startsWith(`name:jtasks:${run}:`))).toEqual([])
  })
})

describe("design C: exclusive scopes", () => {
  test("an exclusive project task neither waits for nor blocks locks of another repository", async () => {
    const elsewhere = tempDir("design-c-other").replace(/\\/g, "/")
    const theirs = await foreignHold([join(elsewhere, "src").replace(/\\/g, "/")], "gt:other-261109-zzzz/T01")
    residents.push(theirs)
    const { repo, run } = await newRun({ tasks: [{ id: "T01", title: "Integração", exclusive: "project" }] })
    expect(ready(await tasksOk(repo, ["next"]))).toEqual(["T01"])
    await tasksOk(repo, ["start", "T01"])
    // While it runs, another project still takes its own paths at once.
    const more = await foreignHold([join(elsewhere, "lib").replace(/\\/g, "/")], "gt:other-261109-zzzz/T02")
    residents.push(more)
    await more.send("release\n")
    await theirs.send("release\n")
    releaseGroup(run)
  })

  test("a machine task waits for a running ordinary task of another run, then keeps new ones out", async () => {
    const a = await newRun({ tasks: [{ id: "T01", title: "Comum", files: ["src/a.ts"] }, { id: "T02", title: "Outra", files: ["src/b.ts"] }] })
    const b = await newRun({ tasks: [{ id: "T01", title: "Medição", exclusive: "machine" }] })
    await tasksOk(a.repo, ["start", "T01"])
    const waiting = await tasksOk(b.repo, ["next"])
    expect(ready(waiting)).toEqual([])
    expect(waiting.text).toContain(`T01 🔒 ${a.run}/T01: resource:machine (travada shared: a máquina inteira`)
    const refused = await tasks(b.repo, ["start", "T01"])
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("resource:machine em uso por")
    await tasksOk(a.repo, ["release", "T01"])
    await tasksOk(b.repo, ["start", "T01"])
    const blocked = await tasksOk(a.repo, ["next"])
    expect(ready(blocked)).toEqual([])
    expect(blocked.text).toContain(`🔒 ${b.run}/T01: resource:machine (travada exclusive:`)
    const out = await tasks(a.repo, ["start", "T02"])
    expect(out.ok).toBe(false)
    await tasksOk(b.repo, ["release", "T01"])
    await tasksOk(a.repo, ["start", "T02"])
    releaseGroup(a.run)
  })
})

describe("design C: resources", () => {
  test("tasks of two runs that both use the desktop run one at a time; a task without it runs alongside", async () => {
    const a = await newRun({ tasks: [{ id: "T01", title: "Clica", files: ["src/a.ts"], uses: ["desktop"] }] })
    const b = await newRun({
      tasks: [
        { id: "T01", title: "Clica também", files: ["src/a.ts"], uses: ["desktop"] },
        { id: "T02", title: "Sem mouse", files: ["src/b.ts"] },
      ],
    })
    await tasksOk(a.repo, ["start", "T01"])
    const next = await tasksOk(b.repo, ["next"])
    expect(ready(next)).toEqual(["T02"])
    // The reason names the resource, its holder and jlock's own description of it (in the tool's language).
    expect(next.text).toContain(`T01 🔒 ${a.run}/T01: resource:desktop (travada exclusive: o mouse, o teclado e as janelas reais`)
    const refused = await tasks(b.repo, ["start", "T01"])
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain(`resource:desktop em uso por ${a.run}/T01 (o mouse, o teclado`)
    await tasksOk(b.repo, ["start", "T02"])
    const ticket = await tasksOk(b.repo, ["status"])
    expect(ticket.text).toContain("resource:desktop")
    await tasksOk(a.repo, ["release", "T01"])
    await tasksOk(b.repo, ["start", "T01"])
    releaseGroup(b.run)
  })
})
