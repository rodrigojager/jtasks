// Ticket 58: a task never becomes done while it keeps edits aside. The sequence of 30/10/2026 (flashevents T04):
// done refused (files outside) → release --agent-ended (25 files kept as patches, 18 s inside the run's write lock)
// → the resumed subagent's done broke the "stale" lock after 10 s, committed what was still dirty, and the
// release's tasks.json write lost: task.patches empty, restore effects active, the task done without its code.
// Also the way back for a task already done: `adopt` (and `undo <e-id> --force`, what jtasks 0.3.x has).

import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Effect } from "../src/ledger.ts"
import type { TasksFile } from "../src/schema.ts"
import { withTree } from "../src/serial.ts"
import { cleanupTemp, context, makeRepo, releaseGroup, sh, tasks, tasksOk, tempDir, writeFiles, runPath } from "./helpers.ts"
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src"] },
  { id: "T02", title: "Lib", files: ["lib/b.ts"] },
]

async function newRun() {
  const repo = makeRepo("kept", { "src/a.ts": "a\n", "src/c.ts": "c\n", "lib/b.ts": "b\n", "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: (await runPath(repo, r.bind!)) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const task = (dir: string, id: string) => tasksFile(dir).tasks.find((t) => t.id === id)!
const read = (repo: string, f: string) => readFileSync(join(repo, f), "utf8")
const head = (repo: string, f: string) => sh(repo, "git", "show", `HEAD:${f}`)
const effects = (dir: string) =>
  readFileSync(join(dir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Effect)

/** T01 edits src/a.ts and src/c.ts; its done is refused for a file outside; then its subagent ends (agent-ended). */
async function refusedThenEnded(repo: string) {
  await tasksOk(repo, ["start", "T01"])
  writeFiles(repo, { "src/a.ts": "a, the code\n", "src/c.ts": "c, the code\n", "README.md": "# another session\n" })
  const refused = await tasks(repo, ["done", "T01", "--evidence", "tests pass"])
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain("fora da posse")
  // The other session's file goes away (as in flashevents); the host sees the subagent's loop end.
  sh(repo, "git", "checkout", "--", "README.md")
  return tasksOk(repo, ["release", "T01", "--agent-ended"])
}

/**
 * The state the race of 30/10 left: the release kept the edits (patches on disk, `restore` effects active, files at
 * HEAD) but its tasks.json write lost to the done, so tasks.json is the one from before the release.
 */
async function releaseLostItsWrite(repo: string, dir: string) {
  await tasksOk(repo, ["start", "T01"])
  writeFiles(repo, { "src/a.ts": "a, the code\n", "src/c.ts": "c, the code\n" })
  const before = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))
  await tasksOk(repo, ["release", "T01", "--agent-ended"])
  expect(read(repo, "src/a.ts")).toBe("a\n")
  // With events (ticket 60) the write cannot be lost: the old content comes back as a snapshot that claims to have
  // folded everything (a run carried over from 0.3.x in that state).
  const after = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ ...before, eventOffset: after.eventOffset, gens: after.gens }, null, 2))
}

describe("done never leaves kept edits behind (ticket 58)", () => {
  test("done refused → agent-ended → done again: refused, saying to start again; the start brings the edits back", async () => {
    const { repo, dir } = await newRun()
    const ended = await refusedThenEnded(repo)
    expect(ended.text).toContain("src/a.ts, src/c.ts")
    expect(task(dir, "T01").status).toBe("pending")
    const again = await tasks(repo, ["done", "T01", "--evidence", "tests pass"])
    expect(again.ok).toBe(false)
    expect(again.text).toContain("foi liberada e guarda as edições em patch (src/a.ts, src/c.ts)")
    expect(again.text).toContain("jtasks start T01")
    expect(task(dir, "T01").status).toBe("pending")
    await tasksOk(repo, ["start", "T01"])
    expect(read(repo, "src/a.ts")).toBe("a, the code\n")
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "tests pass"])
    expect(done.text).toContain("commit")
    expect(head(repo, "src/a.ts")).toBe("a, the code\n")
    expect(head(repo, "src/c.ts")).toBe("c, the code\n")
  })

  test("a release whose tasks.json write was lost: done brings the edits back from the ledger and commits them", async () => {
    const { repo, dir } = await newRun()
    await releaseLostItsWrite(repo, dir)
    expect(task(dir, "T01").status).toBe("in_progress")
    expect(task(dir, "T01").patches).toBeUndefined()
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "tests pass"])
    expect(done.text).toContain("edições guardadas trazidas de volta antes do commit: src/a.ts, src/c.ts")
    expect(head(repo, "src/a.ts")).toBe("a, the code\n")
    expect(head(repo, "src/c.ts")).toBe("c, the code\n")
    expect(task(dir, "T01").patches).toBeUndefined()
  })

  test("the kept edit conflicts with HEAD: done refused, the markers in the tree, and the next done commits", async () => {
    const { repo, dir } = await newRun()
    await releaseLostItsWrite(repo, dir)
    // Someone changed the same line meanwhile (another task's commit).
    writeFiles(repo, { "src/a.ts": "a, theirs\n" })
    sh(repo, "git", "commit", "-q", "-am", "theirs")
    const refused = await tasks(repo, ["done", "T01", "--evidence", "tests pass"])
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("voltaram com conflitos em src/a.ts")
    expect(read(repo, "src/a.ts")).toContain("<<<<<<<")
    expect(read(repo, "src/c.ts")).toBe("c, the code\n")
    writeFiles(repo, { "src/a.ts": "a, both\n" })
    await tasksOk(repo, ["done", "T01", "--evidence", "tests pass"])
    expect(head(repo, "src/a.ts")).toBe("a, both\n")
    expect(head(repo, "src/c.ts")).toBe("c, the code\n")
  })

  test("the start brings back what tasks.json lost; --fresh drops it for good", async () => {
    const { repo, dir } = await newRun()
    await releaseLostItsWrite(repo, dir)
    // Back to pending by hand, still without patches: the start finds them in the ledger.
    const t = tasksFile(dir)
    t.tasks[0]!.status = "pending"
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(t, null, 2))
    releaseGroup(t.run)
    const fresh = await tasksOk(repo, ["start", "T01", "--fresh"])
    expect(fresh.text).toContain("--fresh")
    expect(read(repo, "src/a.ts")).toBe("a\n")
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "nothing to do"])
    expect(done.text).not.toContain("trazidas de volta")
    expect(head(repo, "src/a.ts")).toBe("a\n")
  })
})

describe("the run's tree key (tickets 58, 60)", () => {
  test("a holder working for more than 10 s is not taken for a dead one", async () => {
    const ctx = context(tempDir("lock"))
    const run = `slow-${Date.now().toString(36)}`
    const spans: [string, number, number][] = []
    const slow = withTree(ctx, run, async () => {
      const at = Date.now()
      await Bun.sleep(11_500)
      spans.push(["slow", at, Date.now()])
    })
    await Bun.sleep(1000)
    const quick = withTree(ctx, run, async () => {
      spans.push(["quick", Date.now(), Date.now()])
    })
    await Promise.all([slow, quick])
    const s = spans.find((x) => x[0] === "slow")!
    const q = spans.find((x) => x[0] === "quick")!
    expect(q[1]).toBeGreaterThanOrEqual(s[2])
  }, 60_000)
})

describe("the kept edits of a task already done go to a task in progress (ticket 58)", () => {
  /** flashevents T04 after the race: done, its code only in patches, task.patches empty. */
  async function doneWithoutItsCode() {
    const r = await newRun()
    await releaseLostItsWrite(r.repo, r.dir)
    const t = tasksFile(r.dir)
    t.tasks[0]!.status = "done"
    t.tasks[0]!.owner = null
    writeFileSync(join(r.dir, "tasks.json"), JSON.stringify(t, null, 2))
    releaseGroup(r.run)
    await tasksOk(r.repo, ["start", "T02"])
    return r
  }

  test("adopt: claim first, then the edits come into the tree and go in the adopting task's commit", async () => {
    const { repo, dir } = await doneWithoutItsCode()
    const early = await tasks(repo, ["adopt", "T02", "--from", "T01"])
    expect(early.ok).toBe(false)
    expect(early.text).toContain("jtasks claim T02 src/a.ts src/c.ts")
    await tasksOk(repo, ["claim", "T02", "src/a.ts", "src/c.ts"])
    const adopted = await tasksOk(repo, ["adopt", "T02", "--from", "T01"])
    expect(adopted.text).toContain("T02 trouxe para a árvore 2 edição(ões) guardada(s) de T01")
    expect(read(repo, "src/a.ts")).toBe("a, the code\n")
    expect(effects(dir).filter((e) => e.type === "restore" && e.task === "T01").map((e) => e.state)).toEqual(["undone", "undone"])
    expect((await tasks(repo, ["adopt", "T02", "--from", "T01"])).text).toContain("T01 não tem edições guardadas")
    await tasksOk(repo, ["done", "T02", "--evidence", "T01's code, recovered"])
    expect(head(repo, "src/a.ts")).toBe("a, the code\n")
    expect(head(repo, "src/c.ts")).toBe("c, the code\n")
    expect(sh(repo, "git", "log", "-1", "--format=%s").trim()).toBe("T02: Lib")
    expect(task(dir, "T01").status).toBe("done")
  })

  test("undo <e-id> --force on each restore (jtasks 0.3.x): the same, file by file, after the claim", async () => {
    const { repo, dir } = await doneWithoutItsCode()
    await tasksOk(repo, ["claim", "T02", "src/a.ts", "src/c.ts"])
    const restores = effects(dir).filter((e) => e.type === "restore" && e.task === "T01" && e.state === "active")
    expect(restores.length).toBe(2)
    const owned = await tasks(repo, ["undo", restores[0]!.id])
    expect(owned.ok).toBe(false)
    expect(owned.text).toContain("na posse de T02")
    for (const e of restores) await tasksOk(repo, ["undo", e.id, "--force"])
    expect(read(repo, "src/a.ts")).toBe("a, the code\n")
    await tasksOk(repo, ["done", "T02", "--evidence", "T01's code, recovered"])
    expect(head(repo, "src/a.ts")).toBe("a, the code\n")
    expect(head(repo, "src/c.ts")).toBe("c, the code\n")
  })
})
