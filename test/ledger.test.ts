import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readEffects } from "../src/ledger.ts"
import type { TasksFile } from "../src/schema.ts"
import { cleanupTemp, host, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(400)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src/a.ts"] },
  { id: "T02", title: "Tipos", files: ["src/t.ts"] },
]

/** A run with both tasks done: two commits on the run branch. */
async function finishedRun() {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: plan })
  const run = r.bind!
  runs.push(run)
  for (const [id, file] of [
    ["T01", "src/a.ts"],
    ["T02", "src/t.ts"],
  ] as const) {
    await tasksOk(repo, ["start", id])
    writeFiles(repo, { [file]: `${id}\n` })
    await tasksOk(repo, ["done", id, "--evidence", "ok"])
  }
  return { repo, run, dir: join(repo, ".scratch/goal-tasks/runs", run) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const subjects = (repo: string, n = 5) => sh(repo, "git", "log", "--format=%s", `-${n}`).trim().split("\n")

describe("ledger", () => {
  test("lists exclude, branch and commits in order, for the run, the repository and every project", async () => {
    const { repo, run } = await finishedRun()
    const r = await tasksOk(repo, ["ledger", "--run", run])
    const lines = r.text.split("\n")
    expect(lines[0]).toBe(`ledger da execução ${run}: 5 efeito(s), 5 ativo(s)`)
    expect(lines.slice(1).map((l) => l.split(" · ").slice(0, 2).join(" · "))).toEqual([
      "e-0001 · dir",
      "e-0002 · exclude",
      "e-0003 · branch",
      "e-0004 · commit",
      "e-0005 · commit",
    ])
    expect(lines[3]).toContain(`gt/${run} (de main)`)
    expect(lines[4]).toContain(`${run}/T01`)
    expect((await tasksOk(repo, ["ledger"])).text).toContain(`ledger do repositório`)
    const all = await tasksOk(repo, ["ledger", "--all-projects"])
    expect(all.text).toContain(repo)
  })
})

describe("undo", () => {
  test("undo --task reverts the task's commit, records the revert, and sends the task back to pending", async () => {
    const { repo, run, dir } = await finishedRun()
    const r = await tasksOk(repo, ["undo", "--task", "T02"])
    expect(r.text).toMatch(/^e-0005: revert de [0-9a-f]+ → commit [0-9a-f]+\nT02 → pending\nfeitas 1\/2 \(50%\) · restam 1$/)
    expect(subjects(repo, 4)).toEqual(['Revert "T02: Tipos"', "T02: Tipos", "T01: Base", "init"])
    expect(existsSync(join(repo, "src/t.ts"))).toBe(false)
    expect(tasksFile(dir).tasks[1]).toMatchObject({ status: "pending", commit: null })
    const effects = await readEffects(host, join(dir, "ledger.jsonl"))
    expect(effects.find((e) => e.id === "e-0005")!.state).toBe("undone")
    expect(effects.at(-1)).toMatchObject({ id: "e-0006", type: "commit", task: "T02", reverts: "e-0005", state: "active" })
    const global = (await readEffects(host, join(process.env.GOAL_TASKS_HOME!, "ledger.jsonl"))).filter((e) => e.run === run)
    expect(global.find((e) => e.id === "e-0005")!.state).toBe("undone")
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.at(-1)).toMatchObject({ action: "undo", task: "T02", from: "done", to: "pending" })
  })

  test("undo refuses with unsaved work, and a branch with commits not merged without --force", async () => {
    const { repo, run } = await finishedRun()
    writeFiles(repo, { "README.md": "sujo\n" })
    const dirty = await tasks(repo, ["undo", "e-0004"])
    expect(dirty.ok).toBe(false)
    expect(dirty.text).toBe("e-0004: a árvore tem mudanças não salvas (README.md); commite ou descarte antes do undo")
    sh(repo, "git", "checkout", "--", "README.md")
    const branch = await tasks(repo, ["undo", "e-0003"])
    expect(branch.text).toBe(`e-0003: o branch gt/${run} tem commits que não estão em main; integre-os (git merge) ou use --force`)
    expect(sh(repo, "git", "branch", "--show-current").trim()).toBe(`gt/${run}`)
  })

  test("undo --run undoes everything newest first (with --force for the unmerged branch)", async () => {
    const { repo, run, dir } = await finishedRun()
    const r = await tasksOk(repo, ["undo", "--run", run, "--force"])
    const lines = r.text.split("\n").slice(1)
    expect(lines.map((l) => l.split(":")[0])).toEqual(["e-0005", "e-0004", "e-0003", "e-0002", "e-0001"])
    expect(sh(repo, "git", "branch", "--format=%(refname:short)").trim()).toBe("main")
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).not.toContain(".scratch/")
    expect(existsSync(dir)).toBe(false)
    const global = (await readEffects(host, join(process.env.GOAL_TASKS_HOME!, "ledger.jsonl"))).filter((e) => e.run === run)
    expect(global.filter((e) => e.state === "active").map((e) => e.id)).toEqual(["e-0006", "e-0007"])
  })
})

describe("effects --check", () => {
  test("a branch deleted by hand is marked gone; nothing else is touched", async () => {
    const { repo, run, dir } = await finishedRun()
    sh(repo, "git", "switch", "-q", "main")
    sh(repo, "git", "branch", "-D", `gt/${run}`)
    const r = await tasksOk(repo, ["effects", "--check", "--run", run])
    expect(r.text).toContain("5 efeito(s) ativo(s) conferido(s)")
    expect(r.text).toContain(`e-0003 · branch · gt/${run} (de main) · ${run}`)
    const effects = await readEffects(host, join(dir, "ledger.jsonl"))
    expect(effects.map((e) => e.state)).toEqual(["active", "active", "gone", "gone", "gone"])
  })
})
