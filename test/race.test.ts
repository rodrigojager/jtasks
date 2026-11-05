// Races of the run's state (ticket 60), each written as a deterministic interleaving on a simulated host
// (race-host.ts): the actors' calls are held back until another actor did something, and an actor whose clock runs
// ahead stands for a holder that stalled past the old write lock's stale limit. Every test here failed with the write
// lock of 0.3.x (`withLock`, `.write.lock`) and passes with the events: the fold refuses a decision made on an old
// read, and the run's tree key (serial.ts) keeps the working tree to one transition at a time.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { agentEnded, sweepAwaiting } from "../src/actions.ts"
import type { Effect } from "../src/ledger.ts"
import type { TasksFile } from "../src/schema.ts"
import { mutateTasks, readTasks } from "../src/store.ts"
import { actorHost, looksAtPid, Schedule } from "./race-host.ts"
import { cleanupTemp, context, host, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, runPath, writeFiles } from "./helpers.ts"
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

const runs: string[] = []
const children: { kill(): void }[] = []
afterAll(async () => {
  for (const c of children) c.kill()
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const PLAN = [
  { id: "T01", title: "Base", files: ["src"] },
  { id: "T02", title: "Lib", files: ["lib/b.ts"] },
  { id: "T03", title: "Docs", files: ["docs/c.md"] },
]

async function newRun(extra: Record<string, unknown> = {}) {
  const repo = makeRepo("race", { "src/a.ts": "a\n", "lib/b.ts": "b\n", "docs/c.md": "c\n", "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: { ...extra, tasks: PLAN } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: (await runPath(repo, r.bind!)).replace(/\\/g, "/") }
}

/** The state as every reader sees it (the snapshot alone may be behind the events). */
const stateOf = async (dir: string) => (await readTasks(host, dir)) as TasksFile
const taskOf = async (dir: string, id: string) => (await stateOf(dir)).tasks.find((t) => t.id === id)!
const logOf = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
const effectsOf = (dir: string) =>
  readFileSync(join(dir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Effect)
const head = (repo: string, f: string) => sh(repo, "git", "show", `HEAD:${f}`)
const heldBy = (run: string, task: string) => jlockListJson("--group", run).filter((l) => l.holder?.owner === `gt:${run}/${task}`)

/** A process of our own that lives until the test kills it. */
function sleeper() {
  const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore", stderr: "ignore" })
  children.push(child)
  return child
}


const isLock = (arg: string) => /\/\.write\.lock$/.test(arg)
const isTasks = (arg: string) => /\/tasks\.json$/.test(arg)
const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, value: v }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  )

describe("two writers at once (items 1 and 2 of ticket 60)", () => {
  test("two that find a dead writer's lock break it together: both changes land, none is lost", async () => {
    const { dir } = await newRun()
    // What a writer that died left behind (a 0.3.x one): a lock nobody beats any more.
    mkdirSync(join(dir, ".write.lock"))
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, ".write.lock"), old, old)
    const s = new Schedule()
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        // A breaks the dead lock only once B has seen it dead too.
        if (op === "remove" && isLock(arg)) await s.until(() => s.saw((c) => c.actor === "B" && c.op === "stat" && isLock(c.arg) && c.phase === "after"))
        // A writes only once B has read the tasks twice (its read and its check).
        if (op === "rename" && isTasks(arg))
          await s.until(() => s.calls.filter((c) => c.actor === "B" && c.op === "readText" && isTasks(c.arg) && c.phase === "after").length >= 2)
      },
    })
    const b = actorHost(host, "B", s, {
      async before(op, arg) {
        // B removes what it took for the dead lock after A made its own: A's.
        if (op === "remove" && isLock(arg)) await s.until(() => s.saw((c) => c.actor === "A" && c.op === "mkdirExclusive" && isLock(c.arg) && c.phase === "after" && c.result === true))
        if (op === "rename" && isTasks(arg)) await s.until(() => s.saw((c) => c.actor === "A" && c.op === "rename" && isTasks(c.arg) && c.phase === "after"))
      },
    })
    const [ra, rb] = await Promise.all([
      outcome(mutateTasks(a, dir, (t) => void (t.tasks[0]!.title = "by A"))),
      outcome(mutateTasks(b, dir, (t) => void (t.tasks[1]!.title = "by B"))),
    ])
    expect([ra.ok, rb.ok]).toEqual([true, true])
    const t = await stateOf(dir)
    expect([t.tasks[0]!.title, t.tasks[1]!.title]).toEqual(["by A", "by B"])
  }, 60_000)

  test("a holder whose lock was broken never takes away the next one's: three changes, three land", async () => {
    const { dir } = await newRun()
    const s = new Schedule()
    let aInside = false
    let aDone = false
    const a = actorHost(host, "A", s)
    // B's clock runs ahead: A (stalled) looks dead to it.
    const b = actorHost(host, "B", s, {
      skewMs: 60_000,
      async before(op, arg) {
        // B writes its token only after C got in (A's finally having taken B's lock away).
        if (op === "writeText" && /\/\.write\.lock\/token$/.test(arg))
          await s.until(() => s.saw((c) => c.actor === "C" && c.op === "mkdirExclusive" && isLock(c.arg) && c.phase === "after" && c.result === true))
        if (op === "rename" && isTasks(arg)) await s.until(() => s.saw((c) => c.actor === "C" && c.op === "rename" && isTasks(c.arg) && c.phase === "after"))
      },
    })
    const c = actorHost(host, "C", s, {
      async before(op, arg) {
        if (op === "rename" && isTasks(arg))
          await s.until(() => s.calls.filter((x) => x.actor === "B" && x.op === "readText" && isTasks(x.arg) && x.phase === "after").length >= 2)
      },
    })
    const pa = outcome(
      mutateTasks(a, dir, async (t) => {
        aInside = true
        // A stalls until B got in by breaking its lock.
        await s.until(() => s.saw((x) => x.actor === "B" && x.op === "mkdirExclusive" && isLock(x.arg) && x.phase === "after" && x.result === true))
        t.tasks[0]!.title = "by A"
      }).finally(() => void (aDone = true)),
    )
    await s.until(() => aInside)
    const pb = outcome(mutateTasks(b, dir, (t) => void (t.tasks[1]!.title = "by B")))
    // C comes when A's lock is gone (its holder's finally ran).
    await s.until(() => aDone && s.saw((x) => x.actor === "A" && x.op === "remove" && isLock(x.arg) && x.phase === "after"))
    const pc = outcome(mutateTasks(c, dir, (t) => void (t.tasks[2]!.title = "by C")))
    const results = await Promise.all([pa, pb, pc])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    const t = await stateOf(dir)
    expect([t.tasks[0]!.title, t.tasks[1]!.title, t.tasks[2]!.title]).toEqual(["by A", "by B", "by C"])
  }, 60_000)
})

describe("the working tree under a slow transition (item 3): done against release of the same task", () => {
  test("one wins, the other gets the right answer, and the task is never done with its edits kept aside", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, the code\n" })
    const s = new Schedule()
    let bDone = false
    // A: the release, stalled just before it puts the file back to HEAD (its event loop blocked, a slow disk).
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        if (op === "run" && / checkout -q HEAD -- src\/a\.ts$/.test(arg)) await s.until(() => bDone, 5000)
      },
    })
    // B: the done, whose clock says A's stall went on for a minute.
    const b = actorHost(host, "B", s, { skewMs: 60_000 })
    const pa = outcome(tasksOk(repo, ["release", "T01"], { host: a }))
    await s.until(() => s.saw((c) => c.actor === "A" && c.op === "run" && / diff .*src\/a\.ts$/.test(c.arg)), 20_000)
    const pb = outcome(tasksOk(repo, ["done", "T01", "--evidence", "tests pass"], { host: b })).finally(() => void (bDone = true))
    const [ra, rb] = await Promise.all([pa, pb])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    const t01 = await taskOf(dir, "T01")
    const kept = effectsOf(dir).filter((e) => e.type === "restore" && e.state === "active" && e.task === "T01")
    if (t01.status === "done") {
      // The done won: its commit has the code, nothing of it is kept aside, the release was told it was not running.
      expect(head(repo, "src/a.ts")).toBe("a, the code\n")
      expect(kept).toHaveLength(0)
      expect(t01.patches).toBeUndefined()
      expect(ra.ok ? "" : ra.error).toContain("não está em andamento")
    } else {
      // The release won: the code is kept as a patch, HEAD untouched, the done was told to start the task again.
      expect(t01.status).toBe("pending")
      expect(head(repo, "src/a.ts")).toBe("a\n")
      expect(t01.patches?.map((p) => p.file)).toEqual(["src/a.ts"])
      expect(rb.ok ? "" : rb.error).toContain("jtasks start T01")
    }
    expect(heldBy(run, "T01")).toHaveLength(0)
  }, 90_000)
})

describe("the end of a subagent and the processes of its task (items 4 and 5, ticket 57)", () => {
  const agent = { tool: "claude" as const, session: "s1", agent: "a1" }
  const orchestrator = { tool: "claude" as const, session: "s1" }

  /** T01 started by subagent a1, with one process registered that is dead by now. */
  async function withDeadProc() {
    const r = await newRun({ awaitGrace: "1s" })
    await tasksOk(r.repo, ["start", "T01"], agent)
    const child = sleeper()
    await tasksOk(r.repo, ["wait", "T01", "--pid", String(child.pid)], agent)
    child.kill()
    await child.exited
    return r
  }

  test("a process registered while the end of the subagent is decided is not ignored (item 5)", async () => {
    const { repo, run, dir } = await withDeadProc()
    const live = sleeper()
    const s = new Schedule()
    let injected = false
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        if (injected || !looksAtPid(op, arg)) return
        injected = true
        // The subagent's `jtasks exec` registers its command now.
        await tasksOk(repo, ["wait", "T01", "--pid", String(live.pid)], agent)
      },
    })
    const r = await outcome(agentEnded({ ...context(repo, agent), host: a }, { action: "release", positionals: ["T01"], options: {} }))
    expect(injected).toBe(true)
    expect(r.ok).toBe(true)
    const t01 = await taskOf(dir, "T01")
    expect(t01.status).toBe("in_progress")
    expect(t01.awaiting?.pids).toContain(live.pid)
    expect(heldBy(run, "T01").length).toBeGreaterThan(0)
    live.kill()
  }, 60_000)

  test("the orchestrator's wait --pid at the same time as the end of the subagent keeps the task waiting (ticket 57)", async () => {
    const { repo, run, dir } = await withDeadProc()
    const live = sleeper()
    const s = new Schedule()
    let injected = false
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        if (injected || !looksAtPid(op, arg)) return
        injected = true
        await tasksOk(repo, ["wait", "T01", "--pid", String(live.pid)], orchestrator)
      },
    })
    const r = await outcome(tasks(repo, ["release", "T01", "--agent-ended"], { ...agent, host: a }))
    expect(injected).toBe(true)
    expect(r.ok).toBe(true)
    const t01 = await taskOf(dir, "T01")
    expect(t01.status).toBe("in_progress")
    expect(t01.awaiting?.pids).toContain(live.pid)
    expect(heldBy(run, "T01").length).toBeGreaterThan(0)
    live.kill()
  }, 60_000)

  test("a wait that ran out is expired, never a new one the subagent began meanwhile (item 4)", async () => {
    const { repo, run, dir } = await withDeadProc()
    // The subagent ends with its process gone: the task waits (the host said so), then the clock marks the end.
    const first = sleeper()
    await tasksOk(repo, ["wait", "T01", "--pid", String(first.pid)], agent)
    await tasksOk(repo, ["release", "T01", "--agent-ended"], agent)
    first.kill()
    await first.exited
    expect((await sweepAwaiting(context(repo), run)).map((e) => e.what)).toEqual(["ended"])
    await Bun.sleep(1200)
    // The next pass of the clock decides the wait ran out; meanwhile the subagent came back and waits again.
    const second = sleeper()
    const s = new Schedule()
    let injected = false
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        if (injected || !looksAtPid(op, arg)) return
        injected = true
        await tasksOk(repo, ["wait", "T01", "--pid", String(second.pid)], agent)
        await tasksOk(repo, ["release", "T01", "--agent-ended"], agent)
      },
    })
    await sweepAwaiting({ ...context(repo), host: a }, run)
    expect(injected).toBe(true)
    const t01 = await taskOf(dir, "T01")
    expect(t01.status).toBe("in_progress")
    expect(t01.awaiting?.pids).toContain(second.pid)
    expect(t01.awaiting?.endedAt).toBeUndefined()
    expect(t01.agentEnded ?? 0).toBe(0)
    expect(heldBy(run, "T01").length).toBeGreaterThan(0)
    second.kill()
  }, 60_000)

  test("two ends of the same subagent at once count once; the other is told the task is not running", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"], agent)
    writeFiles(repo, { "src/a.ts": "a, the code\n" })
    const s = new Schedule()
    let bDone = false
    // A stalls in the middle (before it looks at the tree); B's clock says the stall went on for a minute.
    const a = actorHost(host, "A", s, {
      async before(op, arg) {
        if (op === "run" && / status /.test(` ${arg} `) && arg.startsWith("git")) await s.until(() => bDone, 5000)
      },
    })
    const b = actorHost(host, "B", s, { skewMs: 60_000 })
    const pa = outcome(tasksOk(repo, ["release", "T01", "--agent-ended"], { ...agent, host: a }))
    await s.until(() => s.saw((c) => c.actor === "A" && c.op === "run" && c.arg.startsWith("git") && / status /.test(` ${c.arg} `)), 20_000)
    const pb = outcome(tasksOk(repo, ["release", "T01", "--agent-ended"], { ...agent, host: b })).finally(() => void (bDone = true))
    const results = await Promise.all([pa, pb])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)!
    expect(loser.ok ? "" : loser.error).toContain("não está em andamento")
    const t01 = await taskOf(dir, "T01")
    expect(t01).toMatchObject({ status: "pending", agentEnded: 1 })
    expect(logOf(dir).filter((e) => e.action === "agent-ended")).toHaveLength(1)
    expect(t01.patches?.map((p) => p.file)).toEqual(["src/a.ts"])
    expect(heldBy(run, "T01")).toHaveLength(0)
  }, 90_000)
})
