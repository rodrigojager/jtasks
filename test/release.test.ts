// A task leaving `in_progress` without a commit keeps its edits as patches (plan rev. 5.6): the tree is left clean,
// nobody inherits them, the next start reapplies them (or `--fresh` leaves them out), and the ledger undoes it.

import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TasksFile } from "../src/schema.ts"
import { cleanupTemp, foreignHold, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles } from "./helpers.ts"

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
  const repo = makeRepo("release", { "src/a.ts": "a\n", "lib/b.ts": "b\n", "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const t01 = (dir: string) => tasksFile(dir).tasks[0]!
const read = (repo: string, f: string) => readFileSync(join(repo, f), "utf8")
const clean = (repo: string) => sh(repo, "git", "status", "--porcelain", "--untracked-files=all").trim()

describe("releasing keeps the edits", () => {
  test("release: the tree is clean, the patches saved; start reapplies them; a new file comes back too", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, half done\n", "src/new.ts": "new\n" })
    const r = await tasksOk(repo, ["release", "T01"])
    expect(r.text).toContain("edições guardadas em patch (voltam no próximo start; --fresh as deixa de fora): src/a.ts, src/new.ts")
    expect(clean(repo)).toBe("")
    expect(existsSync(join(repo, "src/new.ts"))).toBe(false)
    expect(t01(dir).patches!.map((p) => [p.file, p.by])).toEqual([
      ["src/a.ts", "release"],
      ["src/new.ts", "release"],
    ])
    const s = await tasksOk(repo, ["start", "T01"])
    expect(s.text).toContain("patches reaplicados: src/a.ts, src/new.ts")
    expect(read(repo, "src/a.ts")).toBe("a, half done\n")
    expect(read(repo, "src/new.ts")).toBe("new\n")
    expect(t01(dir).patches).toBeUndefined()
    // The index stays at HEAD: the new file is untracked again, the edit unstaged.
    expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort()).toEqual([" M src/a.ts", "?? src/new.ts"])
  })

  test("start --fresh leaves the patches out, kept in the run folder and the ledger", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "a, first try\n" })
    await tasksOk(repo, ["release", "T01"])
    const patch = join(dir, t01(dir).patches![0]!.patch)
    const s = await tasksOk(repo, ["start", "T01", "--fresh"])
    expect(s.text).toContain("--fresh: 1 patch(es) guardado(s) deixado(s) de fora")
    expect(read(repo, "src/a.ts")).toBe("a\n")
    expect(t01(dir).patches).toBeUndefined()
    expect(existsSync(patch)).toBe(true)
  })

  test("undo of the restore puts a released task's edit back on disk", async () => {
    const { repo, run } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/new.ts": "new\n" })
    await tasksOk(repo, ["release", "T01"])
    expect(existsSync(join(repo, "src/new.ts"))).toBe(false)
    const effects = (await tasksOk(repo, ["ledger", "--run", run, "--json"])).data as { effects: { id: string; type: string; path?: string }[] }
    const restore = effects.effects.find((e) => e.type === "restore" && e.path === "src/new.ts")!
    expect((await tasksOk(repo, ["undo", restore.id])).text).toContain("a edição de src/new.ts voltou")
    expect(read(repo, "src/new.ts")).toBe("new\n")
  })

  test("fail and the agent's end keep the edits too; skip as well", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "tried\n" })
    const f = await tasksOk(repo, ["fail", "T01", "--error", "não fecha"])
    expect(f.text).toContain("edições guardadas em patch")
    expect(clean(repo)).toBe("")
    await tasksOk(repo, ["retry", "T01"])
    expect((await tasksOk(repo, ["start", "T01"])).text).toContain("patches reaplicados: src/a.ts")
    const e = await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(e.text).toContain("edições guardadas em patch")
    expect(clean(repo)).toBe("")
    await tasksOk(repo, ["start", "T02"])
    writeFiles(repo, { "lib/b.ts": "skipped work\n" })
    await tasksOk(repo, ["skip", "T02", "--reason", "fora do escopo"])
    expect(clean(repo)).toBe("")
    expect(tasksFile(dir).tasks[1]!.patches).toHaveLength(1)
  })

  test("never puts back a file whose key another owner holds now", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "T01's edit\n" })
    // T01's lock is gone (expired, say) and another program took the folder.
    const key = join(repo, "src").replace(/\\/g, "/")
    sh(repo, "jlock", "release", key, "--owner", `gt:${run}/T01`, "--json")
    const other = await foreignHold([key], "outro-programa")
    try {
      const r = await tasksOk(repo, ["release", "T01"])
      expect(r.text).toContain("não mexidos (outro dono os segura agora): src/a.ts")
      expect(read(repo, "src/a.ts")).toBe("T01's edit\n")
      expect(t01(dir).patches).toBeUndefined()
    } finally {
      await other.send("release\n")
      await other.stop()
    }
  })

  test("the fallback: edits a released task left on disk neither block nor join another task's done", async () => {
    const { repo, dir } = await newRun()
    // A run from before rev. 5.6: T01 was released with its edit left on disk.
    writeFiles(repo, { "src/a.ts": "left by T01\n" })
    await tasksOk(repo, ["start", "T02"])
    writeFiles(repo, { "lib/b.ts": "T02\n" })
    // Without the log line, the edit is nobody's and the done is refused.
    expect((await tasks(repo, ["done", "T02", "--evidence", "ok"])).text).toContain("arquivos modificados fora da posse: src/a.ts")
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), actor: "cli", action: "release", task: "T01", from: "in_progress", to: "pending", uncommitted: ["src/a.ts"] })}\n`)
    const d = await tasksOk(repo, ["done", "T02", "--evidence", "ok"])
    expect(d.text).toContain("T01, liberada, tem edições pendentes em: src/a.ts (ficam no disco, fora deste commit)")
    expect(sh(repo, "git", "show", "--name-only", "--format=", "HEAD").trim()).toBe("lib/b.ts")
    expect(read(repo, "src/a.ts")).toBe("left by T01\n")
    // Once T01 starts again, the file is its own: no longer counted as left behind.
    expect(jlockListJson("--group", tasksFile(dir).run)).toEqual([])
  })
})
