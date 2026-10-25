// Planning the contention (plan rev. 5.6): `shared` registry files, the warning about parallel tasks touching one,
// `sharedPolicy: "serialize"` as a mutex per file in the frontier, and `status --claims` after a run.

import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { validatePlan } from "../src/validate.ts"
import { cleanupTemp, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

const base = {
  shared: ["src/manifests.ts", "src/run/types.ts"],
  tasks: [
    { id: "T01", title: "Pytest", files: ["src/adapters/pytest"], touchesShared: ["src/manifests.ts"] },
    { id: "T02", title: "Vitest", files: ["src/adapters/vitest"], touchesShared: ["src/manifests.ts"] },
    { id: "T03", title: "Go", files: ["src/adapters/go"], touchesShared: ["src/run/types.ts"] },
  ],
}

describe("shared files in the plan", () => {
  test("two parallel tasks touching one shared file: a warning (not an error) that says how to order them", () => {
    const r = validatePlan(base, { platform: "linux" })
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([
      'T01 e T02 tocam o arquivo compartilhado src/manifests.ts e nenhuma dependência as ordena: encadeie-as com dependsOn, deixe o arquivo com uma delas, ou use "sharedPolicy": "serialize"',
    ])
    // A file of the task's own ownership counts as touching it too.
    const owned = { ...base, tasks: [...base.tasks, { id: "T04", title: "Tipos", files: ["src/run"] }] }
    expect(validatePlan(owned, { platform: "linux" }).warnings).toHaveLength(2)
  })

  test("no warning with a dependency between them, nor with sharedPolicy serialize", () => {
    const chained = { ...base, tasks: base.tasks.map((t) => (t.id === "T02" ? { ...t, dependsOn: ["T01"] } : t)) }
    expect(validatePlan(chained, { platform: "linux" }).warnings).toEqual([])
    expect(validatePlan({ ...base, sharedPolicy: "serialize" }, { platform: "linux" }).warnings).toEqual([])
  })

  test("refusals: touchesShared outside shared, wrong types", () => {
    const outside = { ...base, tasks: [{ id: "T01", title: "x", touchesShared: ["src/other.ts"] }] }
    expect(validatePlan(outside, { platform: "linux" }).errors).toEqual(["T01: touchesShared src/other.ts não está no shared do plano; liste-o lá também"])
    expect(validatePlan({ shared: "src/a.ts", sharedPolicy: "always", tasks: [{ id: "T01", title: "x", touchesShared: "a" }] }, { platform: "linux" }).errors).toEqual([
      "shared deve ser uma lista de caminhos",
      'sharedPolicy deve ser "warn" ou "serialize"',
      "T01: touchesShared deve ser uma lista de caminhos",
    ])
  })

  test("validate and plan print the warnings; the run keeps shared and sharedPolicy", async () => {
    const repo = makeRepo()
    const v = await tasksOk(repo, ["validate"], { json: base })
    expect(v.text).toContain("ok: 3 tarefa(s), nenhum erro\n1 aviso(s):\n- T01 e T02 tocam o arquivo compartilhado src/manifests.ts")
    const p = await tasksOk(repo, ["plan"], { json: { ...base, sharedPolicy: "serialize" } })
    runs.push(p.bind!)
    const run = JSON.parse(await Bun.file(join(repo, ".scratch/jtasks/runs", p.bind!, "run.json")).text())
    expect(run).toMatchObject({ shared: ["src/manifests.ts", "src/run/types.ts"], sharedPolicy: "serialize" })
  })
})

describe("sharedPolicy serialize", () => {
  test("next never hands out two tasks touching the same shared file; start refuses the second while the first runs", async () => {
    const repo = makeRepo()
    const p = await tasksOk(repo, ["plan"], { json: { ...base, sharedPolicy: "serialize" } })
    runs.push(p.bind!)
    const n = await tasksOk(repo, ["next"])
    expect((n.data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T01", "T03"])
    await tasksOk(repo, ["start", "T01"])
    const after = await tasksOk(repo, ["next"])
    expect((after.data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T03"])
    expect(after.text).toContain("T02 🔗 T01: src/manifests.ts (compartilhado)")
    const refused = await tasks(repo, ["start", "T02"])
    expect(refused.ok).toBe(false)
    expect(refused.text).toBe("T02 não está pronta: o arquivo compartilhado src/manifests.ts é tocado por T01, em andamento (sharedPolicy serialize)")
    // Neither task owns the file: no lock for it.
    expect((await tasksOk(repo, ["status"])).text).not.toContain("src/manifests.ts →")
    await tasksOk(repo, ["done", "T01", "--evidence", "ok"])
    expect((await tasksOk(repo, ["next"])).data).toMatchObject({ ready: [{ id: "T02" }, { id: "T03" }] })
  })

  test("without the policy, the two run together (only the warning)", async () => {
    const repo = makeRepo()
    const p = await tasksOk(repo, ["plan"], { json: base })
    runs.push(p.bind!)
    expect(((await tasksOk(repo, ["next"])).data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T01", "T02", "T03"])
  })
})

describe("status --claims", () => {
  test("counts claim, claim-timeout, claim-deadlock and yield per file, with the tasks, from the run's log", async () => {
    const repo = makeRepo()
    const p = await tasksOk(repo, ["plan"], { json: base })
    runs.push(p.bind!)
    const dir = join(repo, ".scratch/jtasks/runs", p.bind!)
    const key = (f: string) => join(repo, f).replace(/\\/g, "/")
    const at = new Date().toISOString()
    const lines = [
      { action: "claim", task: "T01", files: ["src/manifests.ts"], keys: [key("src/manifests.ts")] },
      { action: "claim-timeout", task: "T02", keys: [key("src/manifests.ts")] },
      { action: "claim-deadlock", task: "T02", keys: [key("src/run/types.ts")], chain: "…" },
      { action: "yield", task: "T02", keys: [key("src/manifests.ts")], files: [] },
      { action: "claim", task: "T03", files: ["src/run/types.ts"], keys: [key("src/run/types.ts")] },
      { action: "claim", task: "T03", files: ["README.md"], keys: [key("README.md")] },
    ]
    for (const l of lines) appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at, actor: "cli", ...l })}\n`)
    const s = await tasksOk(repo, ["status", "--claims"])
    expect(s.text).toContain(`arquivos mais disputados de ${p.bind}:
  src/run/types.ts: 1 claim(s) · 1 deadlock(s) (T02, T03)
  src/manifests.ts: 1 claim(s) · 1 espera(s) vencida(s) · 1 yield(s) (T01, T02)
  README.md: 1 claim(s) (T03)`)
    expect((s.data as { claims: unknown[] }).claims[0]).toEqual({ file: "src/run/types.ts", claims: 1, timeouts: 0, deadlocks: 1, yields: 0, tasks: ["T02", "T03"] })
    // Without --claims, status is what it was.
    expect((await tasksOk(repo, ["status"])).text).not.toContain("mais disputados")
  })
})
