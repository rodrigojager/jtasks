import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readEffects } from "../src/ledger.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { StaleRevisionError, mutateTasks, readTasks, writeTasks } from "../src/store.ts"
import { CLI, cleanupTemp, host, makeRepo, sh, tasks, tasksOk, tempDir } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const plan = {
  feature: "cursory-nativo",
  objective: "Integrar o gerador",
  tasks: [
    { id: "T01", title: "Tornar o movimento substituível", files: ["src/move.ts"], acceptance: ["passa"] },
    { id: "T02", title: "Gerador nativo", dependsOn: ["T01"], files: ["src/recorder/**"] },
    { id: "T03", title: "Paridade", dependsOn: ["T01"], files: ["src/parity"], profile: "implement-deep", boundary: "sem UI" },
  ],
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const branches = (repo: string) => sh(repo, "git", "branch", "--format=%(refname:short)").split("\n").filter(Boolean)
const excludeText = (repo: string) => readFileSync(join(repo, ".git/info/exclude"), "utf8")

describe("tasks plan", () => {
  test("creates run.json, tasks.json, tickets, the run branch and the ledger", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["plan"], { json: plan })
    const id = (r.data as { run: string }).run
    expect(id).toMatch(/^cursory-nativo-\d{6}-[a-z0-9]{4}$/)
    expect(r.bind).toBe(id)
    const dir = join(repo, ".scratch/goal-tasks/runs", id)

    const run = json(join(dir, "run.json")) as RunFile
    expect(run).toMatchObject({
      version: 1,
      id,
      feature: "cursory-nativo",
      objective: "Integrar o gerador",
      status: "active",
      repo: { baseBranch: "main", branch: `gt/${id}` },
      worktrees: { policy: "none" },
      serialize: [],
      maxAttempts: 2,
      sessions: [],
    })
    expect(run.repo.root.toLowerCase()).toBe(repo.toLowerCase())

    const t = json(join(dir, "tasks.json")) as TasksFile
    expect(t.revision).toBe(1)
    expect(Object.keys(t.profiles)).toEqual(["implement", "implement-deep", "review"])
    expect(t.tasks.map((x) => [x.id, x.status, x.attempts, x.profile])).toEqual([
      ["T01", "pending", 0, "implement"],
      ["T02", "pending", 0, "implement"],
      ["T03", "pending", 0, "implement-deep"],
    ])
    expect(t.tasks[1]!.files).toEqual(["src/recorder"])
    expect(t.tasks[0]!.acceptance).toEqual([{ text: "passa", done: false }])

    expect(readdirSync(join(dir, "tickets")).sort()).toEqual([
      "01-tornar-o-movimento-substituivel.md",
      "02-gerador-nativo.md",
      "03-paridade.md",
    ])

    expect(sh(repo, "git", "branch", "--show-current").trim()).toBe(`gt/${id}`)
    expect(excludeText(repo)).toContain(".scratch/\n")
    expect(sh(repo, "git", "status", "--porcelain")).toBe("")

    const effects = await readEffects(host, join(dir, "ledger.jsonl"))
    expect(effects.map((e) => [e.id, e.type, e.undo.kind, e.state])).toEqual([
      ["e-0001", "dir", "rmdir", "active"],
      ["e-0002", "exclude", "remove-line", "active"],
      ["e-0003", "branch", "git-branch-delete", "active"],
    ])
    expect(effects[2]).toMatchObject({ ref: `gt/${id}`, from: "main", run: id })
    const global = await readEffects(host, join(process.env.GOAL_TASKS_HOME!, "ledger.jsonl"))
    expect(global.filter((e) => e.run === id).map((e) => e.id)).toEqual(["e-0001", "e-0002", "e-0003"])

    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log[0]).toMatchObject({ action: "plan", actor: "cli", tasks: 3 })
  })

  test("a plan with errors creates nothing", async () => {
    const repo = makeRepo()
    const r = await tasks(repo, ["plan"], { json: [{ id: "T01", title: "a", files: ["src/*.ts"] }] })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("plano recusado, nada foi gravado")
    expect(existsSync(join(repo, ".scratch"))).toBe(false)
    expect(branches(repo)).toEqual(["main"])
    expect(existsSync(join(repo, ".git/info/exclude")) ? excludeText(repo) : "").not.toContain(".scratch/")
  })

  test("a second run does not repeat the exclude line; runs lists both", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan", "--name", "primeira"], { json: { ...plan, branch: "current" } })
    await tasksOk(repo, ["plan", "--name", "segunda"], { json: { ...plan, branch: "current" } })
    expect(excludeText(repo).split("\n").filter((l) => l === ".scratch/")).toHaveLength(1)
    const runs = await tasksOk(repo, ["runs"])
    const lines = runs.text.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^primeira-\d{6}-[a-z0-9]{4} · active · 0\/3 \(0%\) · Integrar o gerador$/)
    expect(lines[1]).toMatch(/^segunda-/)
  })

  test('branch "current" stays on the current branch and records no branch effect', async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["plan"], { json: { ...plan, branch: "current" } })
    const id = (r.data as { run: string }).run
    expect(branches(repo)).toEqual(["main"])
    const run = json(join(repo, ".scratch/goal-tasks/runs", id, "run.json")) as RunFile
    expect(run.repo.branch).toBe("main")
    const effects = await readEffects(host, join(repo, ".scratch/goal-tasks/runs", id, "ledger.jsonl"))
    expect(effects.map((e) => e.type)).toEqual(["dir", "exclude"])
  })

  test("outside a git repository plan refuses", async () => {
    const dir = tempDir("nogit")
    const r = await tasks(dir, ["plan"], { json: plan })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("não é um repositório git")
    expect(existsSync(join(dir, ".scratch"))).toBe(false)
  })

  test("the CLI reads the plan from @file and prints the run id", () => {
    const repo = makeRepo()
    const files = tempDir("planfile")
    writeFileSync(join(files, "plan.json"), JSON.stringify(plan))
    const p = Bun.spawnSync(["bun", CLI, "plan", `@${files}/plan.json`], { cwd: repo, env: process.env })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toMatch(/^execução cursory-nativo-\d{6}-[a-z0-9]{4} criada: 3 tarefa\(s\), branch gt\//)
  })
})

describe("atomic writes and revision", () => {
  test("a write based on a stale revision is refused; concurrent read-change-writes both land under the write lock", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["plan"], { json: { ...plan, branch: "current" } })
    const dir = join(repo, ".scratch/goal-tasks/runs", (r.data as { run: string }).run).replace(/\\/g, "/")
    const first = (await readTasks(host, dir))!
    const second = structuredClone(first)
    second.tasks[0]!.title = "mudado"
    await writeTasks(host, dir, second, 1)
    first.tasks[1]!.title = "perdido"
    await expect(writeTasks(host, dir, first, 1)).rejects.toBeInstanceOf(StaleRevisionError)
    expect((await readTasks(host, dir))!.revision).toBe(2)

    // Two concurrent read-modify-writes: both changes land, the revision counts both.
    await Promise.all([
      mutateTasks(host, dir, (t) => void (t.tasks[1]!.title = "A")),
      mutateTasks(host, dir, (t) => void (t.tasks[2]!.title = "B")),
    ])
    const final = (await readTasks(host, dir))!
    expect(final.revision).toBe(4)
    expect([final.tasks[0]!.title, final.tasks[1]!.title, final.tasks[2]!.title]).toEqual(["mudado", "A", "B"])
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })
})
