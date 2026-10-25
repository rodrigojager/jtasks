// `jtasks yield` (plan rev. 5.6): a task refused for a deadlock gives back only the contested files, its edits kept
// as patches; it stays in progress, takes them back when they are free, and the two commits come out separate.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { TasksFile } from "../src/schema.ts"
import { chainKeys } from "../src/keep.ts"
import { escapePath, patchRel } from "../src/patches.ts"
import { cleanupTemp, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles } from "./helpers.ts"

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const BASE = "l1\nl2\nl3\nl4\nl5\n"

const plan = [
  { id: "T04", title: "Pytest", files: ["a.ts", "b.ts"] },
  { id: "T05", title: "Vitest", files: ["c.ts", "d"] },
]

async function newRun() {
  const repo = makeRepo("yield", { "a.ts": BASE, "b.ts": BASE, "c.ts": BASE, "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const task = (dir: string, id: string) => tasksFile(dir).tasks.find((t) => t.id === id)!
const read = (repo: string, f: string) => readFileSync(join(repo, f), "utf8")
const committed = (repo: string, ref = "HEAD") => sh(repo, "git", "show", "--format=", ref)

async function until<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(100)
  }
}

/** T04 holds a.ts and waits for c.ts; T05 holds c.ts and asks for a.ts: refused for a deadlock. */
async function deadlock(repo: string, run: string) {
  await tasksOk(repo, ["start", "T04"])
  await tasksOk(repo, ["start", "T05"])
  writeFiles(repo, { "a.ts": "T04 a\n", "b.ts": "T04 b\n", "c.ts": BASE.replace("l1", "T05-l1") })
  const waiting = tasks(repo, ["claim", "T04", "c.ts", "--timeout", "30s"])
  await until(async () => (jlockListJson("--group", run).some((l) => l.queue.some((q) => q.owner === `gt:${run}/T04`)) ? true : undefined))
  const refused = await tasks(repo, ["claim", "T05", "a.ts", "--timeout", "10s"])
  expect(refused.ok).toBe(false)
  return { waiting, refused }
}

describe("yield", () => {
  test("the real case: T05 yields c.ts, T04 takes it and commits alone, T05 gets its edit back and commits it", async () => {
    const { repo, run, dir } = await newRun()
    const { waiting, refused } = await deadlock(repo, run)
    expect(refused.text).toContain("Quem pediu por último cede: jtasks yield T05 devolve só os arquivos disputados")
    expect((refused.data as { yield: string }).yield).toBe("T05")

    const y = await tasksOk(repo, ["yield", "T05"])
    expect(y.text).toContain("T05 cedeu c.ts e continua em andamento; edições guardadas em patch: c.ts → ")
    expect(y.text).toContain("jtasks claim T05")
    const t05 = task(dir, "T05")
    expect(t05.status).toBe("in_progress")
    expect(t05.files).toEqual(["d"])
    expect(t05.yielded).toMatchObject([{ path: "c.ts", from: "files" }])
    expect(t05.patches).toMatchObject([{ file: "c.ts", patch: patchRel("T05", 1, "c.ts"), by: "yield" }])
    expect(read(dir, t05.patches![0]!.patch)).toContain("+T05-l1")
    // c.ts is back to HEAD before T04 gets it.
    expect(read(repo, "c.ts")).toBe(BASE)
    expect((await waiting).ok).toBe(true)

    // The panel and the status: T05 waits for what it yielded; T04 holds it.
    const s = await tasksOk(repo, ["status"])
    expect(s.text).toContain("T05 ⏳ cedeu c.ts (com T04)")
    // A guarded edit of c.ts by T05 is outside its ownership now.
    const { checkEdit } = await import("../src/guard.ts")
    expect(checkEdit({ root: repo, cwd: repo, platform: process.platform, task: task(dir, "T05") }, "c.ts").allow).toBe(false)

    writeFiles(repo, { "c.ts": BASE.replace("l5", "T04-l5") })
    const d4 = await tasksOk(repo, ["done", "T04", "--evidence", "ok"])
    // T04's commit has no line of T05.
    const c4 = committed(repo)
    expect(c4).toContain("+T04-l5")
    expect(c4).not.toContain("T05")
    expect(sh(repo, "git", "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["a.ts", "b.ts", "c.ts"])
    // The done gave c.ts back, and T05 took it back at once with its patch reapplied over T04's commit.
    expect(d4.text).toContain("T05 pegou de volta c.ts; patches reaplicados: c.ts")
    expect(read(repo, "c.ts")).toBe(BASE.replace("l1", "T05-l1").replace("l5", "T04-l5"))
    const back = task(dir, "T05")
    expect(back.files.sort()).toEqual(["c.ts", "d"])
    expect(back.yielded).toBeUndefined()
    expect(back.patches).toBeUndefined()
    expect(existsSync(join(dir, "patches/T05/applied", `001-${escapePath("c.ts")}.patch`))).toBe(true)
    // An explicit claim afterwards says it already came back.
    expect((await tasksOk(repo, ["claim", "T05"])).text).toContain("voltaram sozinhos depois do yield: c.ts")

    await tasksOk(repo, ["done", "T05", "--evidence", "ok"])
    const c5 = committed(repo)
    expect(c5).toContain("+T05-l1")
    expect(c5).not.toContain("+T04-l5")
    const ledger = (await tasksOk(repo, ["ledger", "--run", run])).text
    for (const type of ["patch", "restore", "reapply"]) expect(ledger).toContain(` · ${type} · c.ts`)
    expect(jlockListJson("--group", run)).toEqual([])
  })

  test("a conflict on reapply leaves the markers in the file and the patch saved", async () => {
    const { repo, run, dir } = await newRun()
    const { waiting } = await deadlock(repo, run)
    await tasksOk(repo, ["yield", "T05", "c.ts"])
    expect((await waiting).ok).toBe(true)
    writeFiles(repo, { "c.ts": BASE.replace("l1", "T04-l1") })
    const d4 = await tasksOk(repo, ["done", "T04", "--evidence", "ok"])
    expect(d4.text).toContain("reaplicados com conflito (resolva os marcadores; o patch continua guardado): c.ts (")
    const text = read(repo, "c.ts")
    expect(text).toContain("<<<<<<<")
    expect(text).toContain("T04-l1")
    expect(text).toContain("T05-l1")
    expect(existsSync(join(dir, patchRel("T05", 1, "c.ts")))).toBe(true)
    expect(task(dir, "T05").patches).toBeUndefined()
    // Nothing of the conflict is staged: the index stays at HEAD.
    expect(sh(repo, "git", "diff", "--cached", "--name-only").trim()).toBe("")
  })

  test("an explicit claim takes back a yielded file and reapplies; a new file is saved whole, deleted, and comes back", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T05"])
    writeFiles(repo, { "d/new.ts": "brand new\n", "c.ts": BASE.replace("l3", "T05-l3") })
    const y = await tasksOk(repo, ["yield", "T05", "d"])
    expect(y.text).toContain("T05 cedeu d e continua em andamento")
    expect(existsSync(join(repo, "d/new.ts"))).toBe(false)
    expect(read(repo, "c.ts")).toContain("T05-l3")
    const patch = read(dir, task(dir, "T05").patches![0]!.patch)
    expect(patch).toContain("new file mode")
    expect(patch).toContain("+brand new")
    expect(jlockListJson("--group", run).map((l) => l.key.replace(/^.*\//, ""))).toEqual(["c.ts"])
    const c = await tasksOk(repo, ["claim", "T05"])
    expect(c.text).toContain("T05 recebeu d")
    expect(c.text).toContain("patches reaplicados: d/new.ts")
    expect(read(repo, "d/new.ts")).toBe("brand new\n")
    // Untracked again, not staged.
    expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all", "--", "d").trim()).toBe("?? d/new.ts")
    expect(task(dir, "T05").files.sort()).toEqual(["c.ts", "d"])
  })

  test("undo of the restore puts the edit back; undo of a reapply takes it out", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T05"])
    writeFiles(repo, { "c.ts": BASE.replace("l2", "T05-l2") })
    await tasksOk(repo, ["yield", "T05", "c.ts"])
    expect(read(repo, "c.ts")).toBe(BASE)
    const effects = (await tasksOk(repo, ["ledger", "--run", run, "--json"])).data as { effects: { id: string; type: string }[] }
    const restore = effects.effects.find((e) => e.type === "restore")!
    const u = await tasksOk(repo, ["undo", restore.id])
    expect(u.text).toContain(`${restore.id}: a edição de c.ts voltou`)
    expect(read(repo, "c.ts")).toBe(BASE.replace("l2", "T05-l2"))
    // Taking c.ts back now finds the edit in the tree already: nothing applied twice.
    await tasksOk(repo, ["claim", "T05", "c.ts"])
    expect(read(repo, "c.ts")).toBe(BASE.replace("l2", "T05-l2"))
    // A second yield and claim: the reapply is undone by its own effect.
    await tasksOk(repo, ["yield", "T05", "c.ts"])
    await tasksOk(repo, ["claim", "T05", "c.ts"])
    const after = (await tasksOk(repo, ["ledger", "--run", run, "--json"])).data as { effects: { id: string; type: string; state: string }[] }
    const reapply = after.effects.filter((e) => e.type === "reapply" && e.state === "active").pop()!
    expect((await tasksOk(repo, ["undo", reapply.id])).text).toContain("foi tirada")
    expect(read(repo, "c.ts")).toBe(BASE)
    expect(readdirSync(join(dir, "patches/T05/applied")).length).toBeGreaterThan(0)
  })

  test("refusals: not in progress, a file outside the ownership, a file inside a held folder, nothing to yield from", async () => {
    const { repo } = await newRun()
    expect((await tasks(repo, ["yield", "T05"])).text).toContain("T05 não está em andamento")
    await tasksOk(repo, ["start", "T05"])
    expect((await tasks(repo, ["yield", "T05", "a.ts"])).text).toContain("a.ts não está na posse de T05")
    expect((await tasks(repo, ["yield", "T05", "d/x.ts"])).text).toContain("d/x.ts está dentro de d, que T05 segura inteira")
    const none = await tasks(repo, ["yield", "T05"])
    expect(none.code).toBe(2)
    expect(none.text).toContain("T05 não tem claim recusado por deadlock")
  })

  test("a pending task does not start on a key a task in progress yielded", async () => {
    const repo = makeRepo("yield-res", { "a.ts": BASE, "c.ts": BASE })
    const r = await tasksOk(repo, ["plan"], { json: [{ id: "T01", title: "A", files: ["a.ts"] }, { id: "T02", title: "B", files: ["c.ts"] }] })
    runs.push(r.bind!)
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["claim", "T01", "c.ts"])
    await tasksOk(repo, ["yield", "T01", "c.ts"])
    // status does not take anything: c.ts is free in jlock, but reserved for T01.
    const s = await tasksOk(repo, ["status"])
    expect((s.data as { ready: string[] }).ready).toEqual([])
    expect(s.text).toContain("T02 🔒 T01: c.ts")
    // next takes it back first (it is free), so T02 is still not ready.
    const n = await tasksOk(repo, ["next"])
    expect(n.text).toContain("T01 pegou de volta c.ts")
    expect((n.data as { ready: unknown[] }).ready).toEqual([])
    expect(task(join(repo, ".scratch/jtasks/runs", r.bind!), "T01").claimed).toEqual(["c.ts"])
  })

  test("chain keys: the keys held by the owner", () => {
    const chain = "gt:r/T05 → /p/a (held by gt:r/T04) → gt:r/T04 → /p/c (held by gt:r/T05) → gt:r/T05"
    expect(chainKeys(chain, "gt:r/T05")).toEqual(["/p/c"])
    expect(chainKeys(chain, "gt:r/T04")).toEqual(["/p/a"])
  })
})
