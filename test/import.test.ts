import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseTicket } from "../src/tickets.ts"
import type { TasksFile } from "../src/schema.ts"
import { REPO_ROOT, cleanupTemp, makeRepo, tasks, tasksOk } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const FIXTURES = join(REPO_ROOT, "test/fixtures/tickets").replace(/\\/g, "/")

describe("reading tickets", () => {
  test("the jlock format: heading, What to build, Blocked by, Files, criteria, Scope boundary", () => {
    const t = parseTicket(readFileSync(join(FIXTURES, "01-um.md"), "utf8"), "01-um.md", 0)
    expect(t.task).toEqual({
      id: "T01",
      title: "Esqueleto e chaves",
      what: "o esqueleto do projeto e a normalização das chaves, com testes. Demonstrável: `cargo test` passa.",
      files: ["Cargo.toml", "src/main.rs", "src/key.rs", "tests/keys.rs"],
      acceptance: ["chaves normalizadas como caminhos absolutos", "`cargo test` passa"],
      boundary: "nada de travas ainda.",
    })
    expect(t.status).toBe("done")
    expect(t.notes).toEqual([])
    const three = parseTicket(readFileSync(join(FIXTURES, "03-tres.md"), "utf8"), "03-tres.md", 2)
    expect(three.task).toMatchObject({ id: "T03", dependsOn: ["T01", "T02"], exclusive: true })
    expect(three.notes).toEqual(["sem Files: vira exclusive (nunca em paralelo) até alguém declarar os arquivos"])
  })

  test("import --check reports what it read and what was missing, and writes nothing", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["import", FIXTURES, "--check"])
    expect(r.text.split("\n").slice(0, 6)).toEqual([
      `3 ticket(s) lido(s) de ${FIXTURES}:`,
      "  01-um.md → T01 · Esqueleto e chaves · depende de: - · posse: Cargo.toml, src/main.rs, src/key.rs, tests/keys.rs · 2 critério(s)",
      "  02-dois.md → T02 · Acquire e release atômicos · depende de: T01 · posse: src/cmd/acquire.rs, src/cmd/release.rs, tests/race.rs · 2 critério(s)",
      "  03-tres.md → T03 · Fila por senha · depende de: T01, T02 · posse: exclusive · 1 critério(s)",
      "    faltou: sem Files: vira exclusive (nunca em paralelo) até alguém declarar os arquivos",
      "o plano lido é válido; crie a execução com --yes",
    ])
    expect(r.text).toContain("nada foi gravado (--check)")
    expect(existsSync(join(repo, ".scratch"))).toBe(false)
  })

  test("validate accepts a folder of tickets", async () => {
    const repo = makeRepo()
    expect((await tasksOk(repo, ["validate", FIXTURES])).text).toBe("ok: 3 tarefa(s), nenhum erro")
  })

  test("import --yes creates the run (all pending); generated tickets read back give the same tasks", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["import", FIXTURES, "--yes", "--name", "jlock-fixtures"])
    const dir = join(repo, ".scratch/goal-tasks/runs", r.bind!)
    const first = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
    expect(first.tasks.map((t) => [t.id, t.status, !!t.exclusive])).toEqual([
      ["T01", "pending", false],
      ["T02", "pending", false],
      ["T03", "pending", true],
    ])
    expect(first.tasks[0]!.acceptance.every((a) => !a.done)).toBe(true)

    // Round trip: the run's own tickets, imported into another repository, give the same tasks.
    const other = makeRepo()
    const again = await tasksOk(other, ["import", join(dir, "tickets"), "--yes"])
    const second = JSON.parse(readFileSync(join(other, ".scratch/goal-tasks/runs", again.bind!, "tasks.json"), "utf8")) as TasksFile
    expect(second.tasks).toEqual(first.tasks)
  })

  test("a folder without tickets is refused", async () => {
    const repo = makeRepo()
    const r = await tasks(repo, ["import", join(REPO_ROOT, "test")])
    expect(r.ok).toBe(false)
    expect(r.text).toContain("nenhum ticket .md")
  })
})
