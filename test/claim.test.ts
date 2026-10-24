import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TasksFile } from "../src/schema.ts"
import { chainText, parseDuration } from "../src/actions.ts"
import { cleanupTemp, jlockListJson, makeRepo, releaseGroup, sh, tasks, tasksOk, writeFiles } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const plan = [
  { id: "T01", title: "Base", files: ["src"] },
  { id: "T02", title: "Lib", files: ["lib/a.ts"] },
  { id: "T03", title: "Docs", files: ["docs/b.md"] },
]

async function newRun() {
  const repo = makeRepo()
  const r = await tasksOk(repo, ["plan"], { json: plan })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/goal-tasks/runs", r.bind!) }
}

const tasksFile = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile

async function until<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(100)
  }
}

describe("claim", () => {
  test("a free file is granted at once; it joins claimed and the done commit", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T02"])
    expect((await tasks(repo, ["claim", "T03", "x.md"])).text).toContain("T03 não está em andamento (está pending)")
    expect((await tasks(repo, ["claim", "T02", "lib/*.ts"])).text).toContain("claim recusado: lib/*.ts: o jlock trava arquivos e pastas")
    expect((await tasksOk(repo, ["claim", "T02", "lib/a.ts"])).text).toBe("T02 já tem lib/a.ts na posse: nada a fazer")
    const r = await tasksOk(repo, ["claim", "T02", "README.md", "conf/**"])
    expect(r.text).toMatch(/^T02 recebeu README\.md, conf \(esperou [\d.]+ s\); posse: lib\/a\.ts, README\.md, conf$/)
    const t = tasksFile(dir).tasks[1]!
    expect(t.claimed).toEqual(["README.md", "conf"])
    expect(t.holds!.map((h) => h.kind)).toEqual(["start", "claim"])
    expect(jlockListJson("--group", run).filter((l) => l.holder?.owner === `gt:${run}/T02`)).toHaveLength(3)
    writeFiles(repo, { "lib/a.ts": "a\n", "README.md": "novo\n", "conf/c.json": "{}\n" })
    const done = await tasksOk(repo, ["done", "T02", "--evidence", "ok"])
    expect(done.text).toContain("reclamados durante a tarefa: README.md, conf; atualize o plano")
    expect(sh(repo, "git", "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["README.md", "conf/c.json", "lib/a.ts"])
    expect(jlockListJson("--group", run)).toEqual([])
  })

  test("a file in use: the task waits in jlock's queue, status shows ⏳ with holder/position/via, and the claim is granted when the owner is done", async () => {
    const { repo, run } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["start", "T02"])
    const claim = tasks(repo, ["claim", "T02", "src/x.ts", "--timeout", "20s"])

    const waiting = await until(async () => {
      const s = await tasksOk(repo, ["status"])
      const w = (s.data as { inProgress: { id: string; waitingFor: unknown }[] }).inProgress.find((x) => x.id === "T02")?.waitingFor
      return w ? { s, w } : undefined
    })
    expect(waiting.w).toMatchObject({ holder: `gt:${run}/T01`, position: 1 })
    expect((waiting.w as { key: string }).key).toMatch(/src\/x\.ts$/)
    expect((waiting.w as { via: string }).via).toMatch(/\/src$/)
    expect(waiting.s.text).toContain("aguardando: T02 ⏳ T01: src/ · posição 1")
    const next = await tasksOk(repo, ["next"])
    expect(next.text).toContain("aguardando: T02 ⏳ T01: src/ · posição 1")

    writeFiles(repo, { "src/x.ts": "x\n" })
    await tasksOk(repo, ["done", "T01", "--evidence", "base pronta"])
    const granted = await claim
    expect(granted.ok).toBe(true)
    expect(granted.text).toMatch(/^T02 recebeu src\/x\.ts \(esperou [\d.]+ s\)/)
    const after = await tasksOk(repo, ["status"])
    expect(after.text).not.toContain("aguardando")
    expect(after.text).toContain("src/x.ts → T02")
  })

  test("--timeout: the claim gives up with holder, position and via; nothing is recorded", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["start", "T02"])
    const r = await tasks(repo, ["claim", "T02", "src/deep/y.ts", "--timeout", "1s"])
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/^T02 esperou [\d.]+ s por src\/deep\/y\.ts: continua em uso por T01 \(via src\), posição 1 na fila\. Opções:/)
    expect(r.data).toMatchObject({ result: "timeout", holder: "T01", position: 1 })
    expect(tasksFile(dir).tasks[1]!.claimed).toBeUndefined()
  })

  test("a claim that would close a cycle is refused with jlock's chain, and the asker yields", async () => {
    const { repo, run } = await newRun()
    await tasksOk(repo, ["start", "T02"])
    await tasksOk(repo, ["start", "T03"])
    const first = tasks(repo, ["claim", "T02", "docs/b.md", "--timeout", "20s"])
    await until(async () => (jlockListJson("--group", run).some((l) => l.queue.some((q) => q.owner === `gt:${run}/T02`)) ? true : undefined))
    const second = await tasks(repo, ["claim", "T03", "lib/a.ts", "--timeout", "20s"])
    expect(second.ok).toBe(false)
    expect(second.text).toContain("claim recusado: fecharia um ciclo de espera (deadlock): T03 → ")
    expect(second.text).toContain("Quem pediu por último cede: T03")
    expect((second.data as { chain: string }).chain).toContain(`gt:${run}/T02`)
    await tasksOk(repo, ["release", "T03"])
    expect((await first).ok).toBe(true)
  })

  test("durations and chains", () => {
    expect(parseDuration("60s")).toBe(60_000)
    expect(parseDuration("2m")).toBe(120_000)
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("90")).toBe(90_000)
    expect(chainText("gt:r1/T02 → d:/p/a (held by gt:r1/T01) → gt:r2/T09", "r1")).toBe("T02 → d:/p/a (held by T01) → r2/T09")
  })
})
