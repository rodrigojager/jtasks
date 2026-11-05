import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readEffects } from "../src/ledger.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { cleanupTemp, foreignHold, host, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles, runPath } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src/a.ts"], acceptance: ["a existe"] },
  { id: "T02", title: "Tipos", files: ["src/types"] },
  { id: "T03", title: "Junta", dependsOn: ["T01", "T02"], files: ["src"] },
]

async function newRun(extra: object = {}) {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: { tasks: plan, ...extra } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: (await runPath(repo, r.bind!)) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const runFile = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile
const commitFiles = (repo: string, ref = "HEAD") => sh(repo, "git", "show", "--name-only", "--format=", ref).trim().split("\n")

describe("done: one commit per task", () => {
  test("three tasks, each done is a commit of its ownership only, and status ends at restam 0", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["start", "T02"])
    writeFiles(repo, { "src/a.ts": "export const a = 1\n", "src/types/x.ts": "export type X = 1\n" })

    const d1 = await tasksOk(repo, ["done", "T01", "--evidence", "bun test: 3 passed"])
    expect(d1.text).toMatch(/^T01 feita: commit [0-9a-f]{7,} \(T01: Base\); posse devolvida\nfeitas 1\/3 \(33%\) · 1 em andamento · restam 2$/)
    expect(commitFiles(repo)).toEqual(["src/a.ts"])
    expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all")).toBe("?? src/types/x.ts\n")
    await tasksOk(repo, ["done", "T02", "--evidence", "tipos compilam"])
    expect(commitFiles(repo)).toEqual(["src/types/x.ts"])

    await tasksOk(repo, ["start", "T03"])
    writeFiles(repo, { "src/a.ts": "export const a = 2\n", "src/index.ts": "export * from './a'\n" })
    await tasksOk(repo, ["done", "T03", "--evidence", "junta"])
    expect(commitFiles(repo).sort()).toEqual(["src/a.ts", "src/index.ts"])

    const subjects = sh(repo, "git", "log", "--format=%s", "-4").trim().split("\n")
    expect(subjects).toEqual(["T03: Junta", "T02: Tipos", "T01: Base", "init"])
    expect(sh(repo, "git", "branch", "--show-current").trim()).toBe(`gt/${run}`)

    const status = await tasksOk(repo, ["status"])
    expect(status.text.split("\n")[0]).toBe("feitas 3/3 (100%) · restam 0")
    expect(status.text).toContain("travas ativas: nenhuma")
    expect(jlockListJson("--group", run)).toEqual([])

    const t = tasksFile(dir)
    expect(t.tasks.map((x) => [x.id, x.status, x.owner, x.evidence])).toEqual([
      ["T01", "done", null, "bun test: 3 passed"],
      ["T02", "done", null, "tipos compilam"],
      ["T03", "done", null, "junta"],
    ])
    expect(t.tasks[0]!.acceptance).toEqual([{ text: "a existe", done: true }])
    expect(t.tasks[0]!.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect(runFile(dir).status).toBe("done")
    expect(readFileSync(join(dir, "tickets/01-base.md"), "utf8")).toContain("- [x] a existe")

    const commits = (await readEffects(host, join(dir, "ledger.jsonl"))).filter((e) => e.type === "commit")
    expect(commits.map((e) => [e.task, e.ref as string | null | undefined, e.undo.kind])).toEqual([
      ["T01", t.tasks[0]!.commit, "git-revert"],
      ["T02", t.tasks[1]!.commit, "git-revert"],
      ["T03", t.tasks[2]!.commit, "git-revert"],
    ])
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.filter((e) => e.action === "done").map((e) => [e.task, e.from, e.to, e.evidence])).toEqual([
      ["T01", "in_progress", "done", "bun test: 3 passed"],
      ["T02", "in_progress", "done", "tipos compilam"],
      ["T03", "in_progress", "done", "junta"],
    ])
  })

  test("done commits every owned path once when the full path list exceeds Windows argv limits", async () => {
    const { repo, dir } = await newRun({ tasks: [{ id: "T01", title: "Many owned paths", files: ["src"] }] })
    await tasksOk(repo, ["start", "T01"])
    const paths = Array.from({ length: 884 }, (_, index) =>
      `src/owned-${String(index).padStart(4, "0")}-${"x".repeat(70)}/leaf-${"y".repeat(38)}.txt`)
    expect(["git", "add", "-A", "--", ...paths].join(" ").length).toBeGreaterThan(32767)
    writeFiles(repo, Object.fromEntries(paths.map((p, index) => [p, `owned fixture ${index}\n`])))
    const addCalls: string[][] = []
    let commits = 0
    // Exercise real Git/jlock with a deterministic Windows command-line boundary on every platform.
    // The old single-add implementation is refused before staging; do not launch an oversized OS command.
    const boundedHost: typeof host = {
      ...host,
      async run(argv, options) {
        if (argv[0] === "git" && argv[1] === "add") {
          const separator = argv.indexOf("--")
          expect(argv.slice(1, separator + 1)).toEqual(["add", "-A", "--"])
          addCalls.push(argv.slice(separator + 1))
          if (argv.join(" ").length > 32767)
            return { code: 127, stdout: "", stderr: "spawn E2BIG: Windows command line exceeds 32767 characters" }
        }
        if (argv[0] === "git" && argv[1] === "commit") commits++
        return host.run(argv, options)
      },
    }
    const done = await tasksOk(repo, ["done", "T01", "--evidence", "884 owned paths through bounded argv"], { host: boundedHost })
    expect(done.ok).toBe(true)
    expect(addCalls.length).toBeGreaterThan(1)
    expect(addCalls.flat()).toEqual(paths)
    expect(new Set(addCalls.flat()).size).toBe(paths.length)
    expect(addCalls.every(batch => ["git", "add", "-A", "--", ...batch].join(" ").length <= 32767)).toBe(true)
    expect(commits).toBe(1)
    expect(commitFiles(repo).sort()).toEqual(paths)
    expect(sh(repo, "git", "rev-list", "--count", "HEAD").trim()).toBe("2")
    expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(tasksFile(dir).tasks[0]!.status).toBe("done")
    const effects = (await readEffects(host, join(dir, "ledger.jsonl"))).filter(effect => effect.type === "commit")
    expect(effects.length).toBe(1)
    expect(effects[0]!.ref).toBe(tasksFile(dir).tasks[0]!.commit!)
  })

  test("done is refused without evidence, for a task not in progress, and with a file outside the ownership", async () => {
    const { repo, dir } = await newRun()
    expect((await tasks(repo, ["done", "T01", "--evidence", "x"])).text).toBe("T01 não está em andamento (está pending)")
    await tasksOk(repo, ["start", "T01"])
    const bare = await tasks(repo, ["done", "T01"])
    expect(bare).toMatchObject({ ok: false, code: 2 })
    expect(bare.text).toContain("done sem evidência é recusado")
    writeFiles(repo, { "src/a.ts": "1\n", "README.md": "mudou\n", "notes/n.md": "x\n" })
    const outside = await tasks(repo, ["done", "T01", "--evidence", "ok"])
    expect(outside.ok).toBe(false)
    expect(outside.text).toContain("arquivos modificados fora da posse: README.md, notes/n.md")
    expect(outside.text).toContain("jtasks claim T01 <arquivo>")
    expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
    expect(sh(repo, "git", "log", "--format=%s", "-1").trim()).toBe("init")
  })

  test("done is refused when the lock was lost and someone else holds the file now", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "1\n" })
    sh(repo, "jlock", "release", "--group", run, "--owner", `gt:${run}/T01`, "--json")
    // Lost and still free, done would take it back (test/renew.test.ts); here another program took it.
    const other = await foreignHold([join(repo, "src/a.ts").replace(/\\/g, "/")], "vim")
    try {
      const r = await tasks(repo, ["done", "T01", "--evidence", "ok"])
      expect(r.ok).toBe(false)
      expect(r.text).toMatch(/^posse perdida: src\/a\.ts já não está com T01 no jlock; o done foi recusado/)
      expect(tasksFile(dir).tasks[0]!.status).toBe("in_progress")
    } finally {
      await other.stop()
    }
  })

  test("done with nothing changed records no commit", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const r = await tasksOk(repo, ["done", "T01", "--evidence", "já estava feito"])
    expect(r.text).toContain("T01 feita: nenhuma mudança na posse, sem commit; posse devolvida")
    expect(tasksFile(dir).tasks[0]!.commit).toBeNull()
  })
})

describe("skip, fail, release, retry", () => {
  test("release twice reaches maxAttempts and fails; retry reopens", async () => {
    const { repo, run, dir } = await newRun({ maxAttempts: 2 })
    await tasksOk(repo, ["start", "T01"])
    writeFiles(repo, { "src/a.ts": "rascunho\n" })
    const r1 = await tasksOk(repo, ["release", "T01"])
    expect(r1.text).toContain("T01 voltou a pendente (tentativa 1/2); posse devolvida; edições guardadas em patch (voltam no próximo start; --fresh as deixa de fora): src/a.ts")
    expect(jlockListJson("--group", run)).toEqual([])
    expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all").trim()).toBe("")
    expect((await tasksOk(repo, ["start", "T01"])).text).toContain("patches reaplicados: src/a.ts")
    const r2 = await tasksOk(repo, ["release", "T01"])
    expect(r2.text).toContain("T01 falhou: liberada; tentativas esgotadas (2/2)")
    expect(tasksFile(dir).tasks[0]!.status).toBe("failed")
    const next = await tasksOk(repo, ["next"])
    expect(next.text).toContain("T03 ⛔ T01 (falha) · ⛔ T02")
    expect((await tasksOk(repo, ["status"])).text.split("\n")[0]).toBe("feitas 0/3 (0%) · 1 falha · restam 3")
    await tasksOk(repo, ["retry", "T01"])
    expect(tasksFile(dir).tasks[0]).toMatchObject({ status: "pending", attempts: 0 })
  })

  test("skip frees the dependents; fail blocks them; retry --all-failed", async () => {
    const { repo, dir } = await newRun()
    expect((await tasks(repo, ["skip", "T01"])).text).toContain("skip sem motivo é recusado")
    await tasksOk(repo, ["skip", "T01", "--reason", "coberto por outra execução"])
    await tasksOk(repo, ["start", "T02"])
    expect((await tasks(repo, ["fail", "T02"])).code).toBe(2)
    await tasksOk(repo, ["fail", "T02", "--error", "tipos não fecham"])
    const next = await tasksOk(repo, ["next"])
    expect(next.text).toContain("T03 ⛔ T02 (falha)")
    expect((await tasksOk(repo, ["status"])).text).toContain("falhas: T02: tipos não fecham")
    const all = await tasksOk(repo, ["retry", "--all-failed"])
    expect(all.text.split("\n")[0]).toBe("reabertas: T02")
    await tasksOk(repo, ["start", "T02"])
    await tasksOk(repo, ["done", "T02", "--evidence", "ok"])
    const ready = await tasksOk(repo, ["next"])
    expect((ready.data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T03"])
    expect(tasksFile(dir).tasks[0]).toMatchObject({ status: "skipped", reason: "coberto por outra execução" })
    expect((await tasksOk(repo, ["status"])).text.split("\n")[0]).toBe("feitas 1/3 (33%) · 1 pulada · restam 1")
  })
})
