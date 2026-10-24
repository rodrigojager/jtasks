import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TasksFile } from "../src/schema.ts"
import { cleanupTemp, makeRepo, tasks, tasksOk } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const batch1 = {
  objective: "Lotes",
  tasks: [
    { id: "T01", title: "Base", files: ["src/base.ts"] },
    { id: "T02", title: "Tipos", files: ["src/types.ts"] },
  ],
}
const batch2 = [
  { id: "T03", title: "Usa a base", dependsOn: ["T01", "T05"], files: ["src/a.ts"] },
  { id: "T04", title: "Usa os tipos", dependsOn: ["T02"], files: ["src/b.ts"] },
]
const batch3 = [{ id: "T05", title: "Final", dependsOn: ["T04"], files: ["src/c.ts"], acceptance: ["ok"] }]

const runDir = (repo: string, id: string) => join(repo, ".scratch/jtasks/runs", id)
const tasksJson = (repo: string, id: string) => JSON.parse(readFileSync(join(runDir(repo, id), "tasks.json"), "utf8")) as TasksFile

describe("plan in batches", () => {
  test("three batches with cross dependencies pass at --commit; the draft is not a run and disappears", async () => {
    const repo = makeRepo()
    const opened = await tasksOk(repo, ["plan", "--draft", "--name", "lotes"])
    const id = (opened.data as { draft: string }).draft
    expect(id).toMatch(/^lotes-\d{6}-[a-z0-9]{4}$/)
    expect(existsSync(join(runDir(repo, id), "draft.json"))).toBe(true)

    expect((await tasksOk(repo, ["plan", "--add"], { json: batch1 })).text).toContain("lote aceito: 2 tarefa(s) (T01, T02)")
    // T03 depends on T05, which only arrives in the third batch: fine inside a batch.
    await tasksOk(repo, ["plan", "--add"], { json: batch2 })
    await tasksOk(repo, ["plan", "--add"], { json: batch3 })

    const runs = await tasksOk(repo, ["runs"])
    expect(runs.text).toBe("nenhuma execução neste repositório (crie uma com tasks plan)")

    const show = await tasksOk(repo, ["plan", "--show"])
    expect(show.text.split("\n")).toEqual([
      `rascunho ${id}: 5 tarefa(s)`,
      "T01 · Base · depende de: - · posse: src/base.ts",
      "T02 · Tipos · depende de: - · posse: src/types.ts",
      "T03 · Usa a base · depende de: T01, T05 · posse: src/a.ts",
      "T04 · Usa os tipos · depende de: T02 · posse: src/b.ts",
      "T05 · Final · depende de: T04 · posse: src/c.ts",
    ])

    const committed = await tasksOk(repo, ["plan", "--commit"])
    expect(committed.bind).toBe(id)
    expect(existsSync(join(runDir(repo, id), "draft.json"))).toBe(false)
    expect(existsSync(join(runDir(repo, id), "run.json"))).toBe(true)
    expect(tasksJson(repo, id).tasks.map((t) => t.id)).toEqual(["T01", "T02", "T03", "T04", "T05"])
    expect((await tasksOk(repo, ["runs"])).text).toContain(`${id} · active · 0/5 (0%) · Lotes`)
  })

  test("a batch with its own errors is refused whole; ids repeated across batches are caught at --add", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan", "--draft"])
    await tasksOk(repo, ["plan", "--add"], { json: batch1 })
    const bad = await tasks(repo, ["plan", "--add"], {
      json: [
        { id: "T01", title: "de novo" },
        { id: "T09", title: "padrão", files: ["src/*.ts"], profile: "nope" },
      ],
    })
    expect(bad.ok).toBe(false)
    expect(bad.text.split("\n")).toEqual([
      "lote recusado, o rascunho não mudou. 3 erro(s):",
      "- id repetido: T01",
      `- T09: perfil desconhecido "nope" (perfis: implement, implement-deep, review)`,
      "- T09: src/*.ts: o jlock trava arquivos e pastas, não padrões; liste os arquivos ou use a pasta src",
    ])
    expect((await tasksOk(repo, ["plan", "--show"])).text).toContain("2 tarefa(s)")
  })

  test("a cycle and an ownership conflict across batches only show at --commit, with the exact message; --fix repairs", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan", "--draft"])
    await tasksOk(repo, ["plan", "--add"], { json: [{ id: "T01", title: "a", dependsOn: ["T02"], files: ["src/x.ts"] }] })
    await tasksOk(repo, ["plan", "--add"], { json: [{ id: "T02", title: "b", dependsOn: ["T01"] }] })
    await tasksOk(repo, ["plan", "--add"], { json: [{ id: "T03", title: "c", files: ["src"] }] })
    const first = await tasks(repo, ["plan", "--commit"])
    expect(first.ok).toBe(false)
    expect(first.text.split("\n")).toEqual([
      "plano recusado, nada foi gravado; o rascunho continua aberto. 2 erro(s):",
      "- ciclo: T01 → T02 → T01",
      "- T01 e T03 tocam src/x.ts (src cobre src/x.ts) e podem rodar juntas: adicione uma dependência ou separe o arquivo",
    ])
    await tasksOk(repo, ["plan", "--fix", "T02"], { json: { title: "b", files: [] } })
    await tasksOk(repo, ["plan", "--fix", "T03"], { json: { id: "T03", title: "c", dependsOn: ["T01"], files: ["src"] } })
    const unknown = await tasks(repo, ["plan", "--fix", "T09"], { json: { title: "x" } })
    expect(unknown.text).toBe("o rascunho não tem a tarefa T09 (veja tasks plan --show)")
    const renamed = await tasks(repo, ["plan", "--fix", "T03"], { json: { id: "T07", title: "x" } })
    expect(renamed.text).toContain("--fix T03 recebeu a tarefa T07: o id não muda numa correção")
    await tasksOk(repo, ["plan", "--commit"])
  })

  test("a second --draft is refused while one is open; --add without a draft explains", async () => {
    const repo = makeRepo()
    const none = await tasks(repo, ["plan", "--add"], { json: batch1 })
    expect(none.text).toBe("não há rascunho aberto: comece com tasks plan --draft")
    const opened = await tasksOk(repo, ["plan", "--draft"])
    const again = await tasks(repo, ["plan", "--draft"])
    expect(again.ok).toBe(false)
    expect(again.text).toContain(`já há um rascunho aberto: ${(opened.data as { draft: string }).draft}`)
  })

  test("plan <json> in one call gives the same tasks.json as the batches", async () => {
    const whole = { ...batch1, tasks: [...batch1.tasks, ...batch2, ...batch3] }
    const a = makeRepo()
    const single = await tasksOk(a, ["plan"], { json: whole })
    const b = makeRepo()
    await tasksOk(b, ["plan", "--draft"])
    await tasksOk(b, ["plan", "--add"], { json: batch1 })
    await tasksOk(b, ["plan", "--add"], { json: batch2 })
    await tasksOk(b, ["plan", "--add"], { json: batch3 })
    const batched = await tasksOk(b, ["plan", "--commit"])
    const strip = (t: TasksFile) => ({ ...t, run: "" })
    expect(strip(tasksJson(b, batched.bind!))).toEqual(strip(tasksJson(a, single.bind!)))
  })
})
