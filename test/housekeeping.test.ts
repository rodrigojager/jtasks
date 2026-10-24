import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readEffects } from "../src/ledger.ts"
import { cleanupTemp, host, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(400)
  cleanupTemp()
})

const plan = [{ id: "T01", title: "Base", files: ["src/a.ts"] }]

async function newRun(repo = makeRepo(), name = "limpa") {
  const r = await tasksOk(repo, ["plan", "--name", name], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!).replace(/\\/g, "/") }
}

const globalEffects = async (run: string) =>
  (await readEffects(host, join(process.env.JTASKS_HOME!, "ledger.jsonl"))).filter((e) => e.run === run)

describe("clean", () => {
  test("without --yes it only lists the folder and the active effects", async () => {
    const { repo, run, dir } = await newRun()
    const r = await tasksOk(repo, ["clean", run])
    expect(r.text).toContain(`apagar ${dir}; os commits ficam (são código)`)
    expect(r.text).toContain(`e-0003 · branch · gt/${run} (de main)`)
    expect(r.text).toContain(`→  tasks undo e-0003 --run ${run}`)
    expect(r.text).toContain(`nada foi apagado; confirme com tasks clean ${run} --yes`)
    expect(existsSync(dir)).toBe(true)
  })

  test("with --yes it removes the folder, marks dir undone and keeps the other effects; refuses with a task in progress", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const busy = await tasks(repo, ["clean", run, "--yes"])
    expect(busy.ok).toBe(false)
    expect(busy.text).toContain(`recusado: há tarefas em andamento: ${run} (T01)`)
    await tasksOk(repo, ["release", "T01"])
    const r = await tasksOk(repo, ["clean", run, "--yes"])
    expect(r.text).toContain(`apagado: ${dir}`)
    expect(existsSync(dir)).toBe(false)
    const effects = await globalEffects(run)
    expect(effects.map((e) => [e.type, e.state])).toEqual([
      ["dir", "undone"],
      ["exclude", "active"],
      ["branch", "active"],
    ])
    expect((await tasksOk(repo, ["runs"])).text).toBe("nenhuma execução neste repositório (crie uma com tasks plan)")
  })

  test("--all --yes removes .scratch/jtasks", async () => {
    const repo = makeRepo()
    await newRun(repo, "um")
    await tasksOk(repo, ["plan", "--name", "dois"], { json: { tasks: plan, branch: "current" } })
    await tasksOk(repo, ["clean", "--all", "--yes"])
    expect(existsSync(join(repo, ".scratch/jtasks"))).toBe(false)
  })
})

describe("archive", () => {
  test("archive moves the run out of the project; resume --from-archive brings it back", async () => {
    const { repo, run, dir } = await newRun()
    const r = await tasksOk(repo, ["archive", run])
    const to = join(process.env.JTASKS_HOME!, "archive", repo.split("/").pop()!, run).replace(/\\/g, "/")
    expect(r.text).toBe(`execução ${run} arquivada em ${to}; volta com tasks resume ${run} --from-archive`)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(to, "tasks.json"))).toBe(true)
    expect((await tasksOk(repo, ["runs"])).text).not.toContain(run)
    expect((await globalEffects(run)).find((e) => e.type === "archive")).toMatchObject({ state: "active", to, undo: { kind: "unarchive" } })

    const back = await tasksOk(repo, ["resume", run, "--from-archive"])
    expect(back.text.split("\n")[0]).toBe(`execução ${run} trazida de volta de ${to}`)
    expect(back.bind).toBe(run)
    expect(existsSync(join(dir, "tasks.json"))).toBe(true)
    expect(existsSync(to)).toBe(false)
    expect((await tasksOk(repo, ["runs"])).text).toContain(run)
    expect((await globalEffects(run)).find((e) => e.type === "archive")!.state).toBe("undone")
    expect((await readEffects(host, join(dir, "ledger.jsonl"))).find((e) => e.type === "archive")!.state).toBe("undone")
  })

  test("archive refuses a run with a task in progress", async () => {
    const { repo, run } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    expect((await tasks(repo, ["archive", run])).text).toBe(`${run} tem tarefas em andamento (T01); libere-as antes de arquivar`)
  })
})
