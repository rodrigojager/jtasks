// The fold of a run's events (ticket 60): pure and deterministic, so every reader in every process reaches the same
// state, whatever order the events were appended in and whichever snapshot it starts from. And the optimistic commit
// over it: concurrent decisions never lose one another, a decision made on an old read never lands.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { applyEvent, charIndexAt, copyGens, diffState, foldLines, parseLines, utf8Length, type FoldState, type RunEvent } from "../src/events.ts"
import type { RunFile, Task, TasksFile } from "../src/schema.ts"
import { commit, readState, strip } from "../src/store.ts"
import { cleanupTemp, host, makeRepo, tasksOk, runPath, releaseGroup } from "./helpers.ts"
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(300)
  cleanupTemp()
})

/** A small seeded generator: the same cases on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const IDS = ["T01", "T02", "T03", "T04"]

function baseState(): { run: RunFile; tasks: TasksFile } {
  const task = (id: string): Task =>
    ({ id, title: id, status: "pending", dependsOn: [], files: [], acceptance: [], profile: "execute", attempts: 0, owner: null, commit: null }) as unknown as Task
  return {
    run: { version: 1, id: "r", feature: "f", objective: "", status: "active", created: "2026-11-05T00:00:00Z", repo: { root: "/r", baseBranch: "main", branch: "main" }, worktrees: { policy: "none" }, serialize: [], maxAttempts: 2, holdTtl: "2h", sessions: [] } as RunFile,
    tasks: { version: 1, run: "r", revision: 1, profiles: {}, tasks: IDS.map(task) },
  }
}

/** Random events, some of them made on generations that will be old by the time they are folded. */
function randomEvents(next: () => number, n: number): RunEvent[] {
  const out: RunEvent[] = []
  for (let i = 0; i < n; i++) {
    const ops = IDS.filter(() => next() < 0.4).map((task) => {
      const op: RunEvent["ops"][number] = { task, gen: Math.floor(next() * 3) }
      if (next() < 0.8) op.set = { title: `${task}-${i}`, attempts: i, ...(next() < 0.3 ? { lost: "ção ✓ 🚀" } : {}) }
      if (next() < 0.3) op.unset = ["lost"]
      return op
    })
    const e: RunEvent = { v: 1, id: `e${i}`, at: "2026-11-05T00:00:00Z", actor: "test", ops }
    if (next() < 0.3) e.run = { gen: Math.floor(next() * 2), ...(next() < 0.8 ? { set: { objective: `o${i}` } } : {}) }
    if (!ops.length && !e.run) e.ops.push({ task: "T01", gen: Math.floor(next() * 3), set: { title: `x${i}` } })
    out.push(e)
  }
  return out
}

const lineOf = (e: RunEvent) => `\n${JSON.stringify(e)}\n`

function foldAll(text: string): FoldState & { offset: number } {
  const b = baseState()
  const st: FoldState = { run: b.run, tasks: b.tasks, gens: { run: 0, tasks: {} } }
  const read = parseLines(text, 0)
  foldLines(st, read.lines)
  return { ...st, offset: read.end }
}

describe("the fold", () => {
  test("any order of appending: every reader, from any snapshot and folding run and tasks apart, reaches the same state", () => {
    const next = rng(60)
    for (let round = 0; round < 40; round++) {
      const events = randomEvents(next, 12)
      // A different order each round: the order the appends happened to land in.
      const order = [...events].sort(() => next() - 0.5)
      const text = order.map(lineOf).join("")
      const whole = foldAll(text)
      const lines = parseLines(text, 0).lines
      for (let k = 0; k <= lines.length; k++) {
        // A reader that stopped at line k wrote a snapshot there; another reader goes on from it.
        const snapAt = k === 0 ? 0 : lines[k - 1]!.end
        const head = foldAll(new TextDecoder().decode(new TextEncoder().encode(text).slice(0, snapAt)))
        expect(head.offset).toBe(snapAt)
        const rest: FoldState = { run: structuredClone(head.run), tasks: structuredClone(head.tasks), gens: copyGens(head.gens) }
        const read = parseLines(text, snapAt)
        foldLines(rest, read.lines)
        expect(read.end).toBe(whole.offset)
        expect(rest).toEqual({ run: whole.run, tasks: whole.tasks, gens: whole.gens })
        // The run alone and the tasks alone from that snapshot: the same generations, the same contents.
        const runOnly: FoldState = { run: structuredClone(head.run), gens: copyGens(head.gens) }
        const tasksOnly: FoldState = { tasks: structuredClone(head.tasks), gens: copyGens(head.gens) }
        foldLines(runOnly, read.lines)
        foldLines(tasksOnly, read.lines)
        expect(runOnly.gens).toEqual(whole.gens)
        expect(tasksOnly.gens).toEqual(whole.gens)
        expect(runOnly.run).toEqual(whole.run)
        expect(tasksOnly.tasks).toEqual(whole.tasks)
      }
    }
  })

  test("an event applies whole or not at all; a guard op only checks; the generations move by one", () => {
    const b = baseState()
    const st: FoldState = { run: b.run, tasks: b.tasks, gens: { run: 0, tasks: {} } }
    expect(applyEvent(st, { v: 1, id: "a", at: "", actor: "", ops: [{ task: "T01", gen: 0, set: { title: "A" } }, { task: "T02", gen: 0 }] })).toBe(true)
    expect(st.gens.tasks).toEqual({ T01: 1 })
    // T01 moved: an event made on its generation 0 is refused, with its change to T02.
    expect(applyEvent(st, { v: 1, id: "b", at: "", actor: "", ops: [{ task: "T01", gen: 0, set: { title: "B" } }, { task: "T02", gen: 0, set: { title: "B" } }] })).toBe(false)
    expect(st.tasks!.tasks.map((t) => t.title).slice(0, 2)).toEqual(["A", "T02"])
    expect(applyEvent(st, { v: 1, id: "c", at: "", actor: "", ops: [], run: { gen: 0, set: { status: "paused" }, unset: ["serialize"] } })).toBe(true)
    expect(st.run!.status).toBe("paused")
    expect("serialize" in st.run!).toBe(false)
    expect(st.gens.run).toBe(1)
    expect(st.tasks!.revision).toBe(2)
  })

  test("a torn line is skipped by every reader alike; a last line still being written is left for the next read", () => {
    const e1: RunEvent = { v: 1, id: "1", at: "", actor: "", ops: [{ task: "T01", gen: 0, set: { title: "ção" } }] }
    const e2: RunEvent = { v: 1, id: "2", at: "", actor: "", ops: [{ task: "T01", gen: 1, set: { title: "🚀" } }] }
    const text = `${lineOf(e1)}{"v":1,"id":"torn","ops":[{"task":"T0${lineOf(e2)}{"v":1,"id":"3"`
    const read = parseLines(text, 0)
    expect(read.lines.filter((l) => l.event).map((l) => l.event!.id)).toEqual(["1", "2"])
    expect(read.end).toBe(utf8Length(text) - utf8Length(`{"v":1,"id":"3"`))
    const st = foldAll(text)
    expect(st.tasks!.tasks[0]!.title).toBe("🚀")
    expect(charIndexAt("aç🚀b", utf8Length("aç🚀"))).toBe("aç🚀".length)
  })

  test("an edit that adds, removes or reorders tasks is not an event", () => {
    const b = baseState()
    const after = structuredClone(b)
    after.tasks.tasks.reverse()
    expect(() => diffState(b, after, { run: 0, tasks: {} })).toThrow()
    const same = structuredClone(b)
    expect(diffState(b, same, { run: 0, tasks: {} })).toBeUndefined()
    same.tasks.tasks[1]!.title = "x"
    delete (same.run as Partial<RunFile>).serialize
    expect(diffState(b, same, { run: 3, tasks: { T02: 5 } })).toEqual({ ops: [{ task: "T02", gen: 5, set: { title: "x" } }], run: { gen: 3, unset: ["serialize"] } })
  })
})

describe("the optimistic commit on a real run folder", () => {
  async function newRun() {
    const repo = makeRepo("events", { "README.md": "# t\n" })
    const r = await tasksOk(repo, ["plan"], { json: { branch: "current", tasks: IDS.map((id) => ({ id, title: id })) } })
    runs.push(r.bind!)
    return { repo, run: r.bind!, dir: (await runPath(repo, r.bind!)).replace(/\\/g, "/") }
  }

  test("16 decisions at once on the same tasks: every one lands once, the snapshot and a fold from scratch agree", async () => {
    const { dir } = await newRun()
    const base = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile & { eventOffset: number }
    const baseRun = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile
    expect(base.eventOffset).toBe(0)
    const next = rng(7)
    const picks = Array.from({ length: 16 }, () => IDS[Math.floor(next() * IDS.length)]!)
    const done = await Promise.all(
      picks.map((id, i) =>
        commit(host, dir, (d) => {
          const t = d.tasks.tasks.find((x) => x.id === id)!
          t.attempts += 1
          t.title = `${t.title}+${i}`
          if (i % 5 === 0) d.run.objective = `${d.run.objective}|${i}`
        }),
      ),
    )
    expect(done.every((c) => c.changed)).toBe(true)
    const state = (await readState(host, dir))!
    const tasks = strip(state.tasks!)
    for (const id of IDS) expect(tasks.tasks.find((t) => t.id === id)!.attempts).toBe(picks.filter((p) => p === id).length)
    expect(strip(state.run!).objective.split("|").filter(Boolean).sort()).toEqual(["0", "5", "10", "15"].sort())
    // From the first snapshot (offset 0) the events alone give the same state.
    const scratch: FoldState = { run: strip(baseRun), tasks: strip(base), gens: { run: 0, tasks: {} } }
    const text = readFileSync(join(dir, "events.jsonl"), "utf8")
    const read = parseLines(text, 0)
    const folded = foldLines(scratch, read.lines)
    expect(folded.accepted).toHaveLength(16)
    expect(scratch.tasks).toEqual(state.tasks ? strip(state.tasks) : undefined)
    expect(scratch.run).toEqual(strip(state.run!))
    expect(read.end).toBe(state.offset)
  })

  test("a run from before ticket 60 (no events, no generations) opens and goes on; the first event writes format 2", async () => {
    const { repo, dir } = await newRun()
    // What 0.3.x left: the plain files, no stamps.
    for (const f of ["run.json", "tasks.json"]) {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8"))
      delete v.eventOffset
      delete v.gens
      delete v.format
      writeFileSync(join(dir, f), JSON.stringify(v, null, 2))
    }
    rmSync(join(dir, "events.jsonl"), { force: true })
    const status = await tasksOk(repo, ["status"])
    expect(status.text).toContain("0/4")
    await tasksOk(repo, ["start", "T01"])
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true)
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))
    expect(run.format).toBe(2)
    const tasks = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))
    expect(tasks.gens.tasks.T01).toBe(1)
    expect(tasks.eventOffset).toBeGreaterThan(0)
    await tasksOk(repo, ["release", "T01"])
    expect((await readState(host, dir))!.tasks!.tasks[0]!.status).toBe("pending")
  })
})
