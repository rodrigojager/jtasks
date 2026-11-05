// The effects of a transition made again (ticket 60): the optimistic commit decides again when its event is refused,
// and the decisions that touch the working tree run their effects again. A done made again makes no second commit, a
// release made again does not lose the patches the first try saved.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Effect } from "../src/ledger.ts"
import { mutateTasks, readTasks } from "../src/store.ts"
import { actorHost, Schedule } from "./race-host.ts"
import { cleanupTemp, host, makeRepo, releaseGroup, sh, tasksOk, runPath, writeFiles } from "./helpers.ts"

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

async function newRun() {
  const repo = makeRepo("idem", { "src/a.ts": "a\n", "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: [{ id: "T01", title: "Base", files: ["src"] }, { id: "T02", title: "Other" }] })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: (await runPath(repo, r.bind!)).replace(/\\/g, "/") }
}

const effectsOf = (dir: string) =>
  readFileSync(join(dir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Effect)

/** A host whose first event is refused: right before it is appended, another change to T01 lands. */
function refusedOnce(dir: string) {
  const s = new Schedule()
  let injected = false
  return {
    get injected() {
      return injected
    },
    host: actorHost(host, "A", s, {
      async before(op, arg) {
        if (injected || op !== "appendText" || !arg.endsWith("/events.jsonl")) return
        injected = true
        await mutateTasks(host, dir, (t) => void (t.tasks[0]!.what = "changed meanwhile"))
      },
    }),
  }
}

describe("effects made again", () => {
  test("done whose event is refused after its commit: decided again, no second commit, one commit effect", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, the code\n" })
    const commitsBefore = Number(sh(repo, "git", "rev-list", "--count", "HEAD").trim())
    const a = refusedOnce(dir)
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "tests pass"], { host: a.host })
    expect(a.injected).toBe(true)
    expect(Number(sh(repo, "git", "rev-list", "--count", "HEAD").trim())).toBe(commitsBefore + 1)
    const message = sh(repo, "git", "log", "-1", "--format=%B")
    expect(message).toContain(`Jtasks-Task: ${run}/T01 gen `)
    const t01 = (await readTasks(host, dir))!.tasks[0]!
    expect(t01.status).toBe("done")
    expect(t01.what).toBe("changed meanwhile")
    expect(t01.commit).toBe(sh(repo, "git", "rev-parse", "--short", "HEAD").trim())
    expect((done.data as { commit: string }).commit).toBe(t01.commit!)
    expect(effectsOf(dir).filter((e) => e.type === "commit" && e.task === "T01")).toHaveLength(1)
  }, 60_000)

  test("release whose event is refused after the files went back to HEAD: the patch saved by the first try stays the task's", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, the code\n" })
    const a = refusedOnce(dir)
    await tasksOk(repo, ["release", "T01"], { host: a.host })
    expect(a.injected).toBe(true)
    const t01 = (await readTasks(host, dir))!.tasks[0]!
    expect(t01.status).toBe("pending")
    expect(t01.patches?.map((p) => p.file)).toEqual(["src/a.ts"])
    expect(existsSync(join(dir, t01.patches![0]!.patch))).toBe(true)
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("a\n")
    expect(effectsOf(dir).filter((e) => e.type === "patch" && e.task === "T01")).toHaveLength(1)
    // And the start brings it back.
    await tasksOk(repo, ["start", "T01"])
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("a, the code\n")
  }, 60_000)

  test("a done whose process died after its commit: the next done takes that commit, no empty second one", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, the code\n" })
    // The commit the dead done made (with its trailer), its event never written.
    sh(repo, "git", "add", "-A", "--", "src/a.ts")
    sh(repo, "git", "commit", "-q", "-m", "T01: Base", "-m", `Jtasks-Task: ${run}/T01 gen 1`)
    const head = sh(repo, "git", "rev-parse", "--short", "HEAD").trim()
    const r = await tasksOk(repo, ["done", "T01", "--evidence", "tests pass"])
    expect((r.data as { commit: string }).commit).toBe(head)
    expect(sh(repo, "git", "rev-parse", "--short", "HEAD").trim()).toBe(head)
    expect(effectsOf(dir).filter((e) => e.type === "commit" && e.task === "T01").map((e) => e.ref)).toEqual([head])
  }, 60_000)
})
