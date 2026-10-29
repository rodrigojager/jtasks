// A subagent that ends its loop while a process of its task runs (plan rev. 5.8): the task waits for the process in
// progress, with its locks and without spending an attempt; a dead process (or none) counts as the subagent's end,
// apart from the attempts, and too many ends pause the run for a person.

import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { agentEnded, awaitBack, sweepAwaiting } from "../src/actions.ts"
import { parseTasklist, probe, procAlive } from "../src/procs.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { cleanupTemp, context, host, jlockListJson, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

const runs: string[] = []
const children: { kill(): void }[] = []
afterAll(async () => {
  for (const c of children) c.kill()
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

async function newRun(extra: Record<string, unknown> = {}) {
  const repo = makeRepo("await", { "src/a.ts": "a\n", "lib/b.ts": "b\n", "README.md": "# t\n" })
  const r = await tasksOk(repo, ["plan"], { json: { ...extra, tasks: [{ id: "T01", title: "Base", files: ["src"] }, { id: "T02", title: "Lib", files: ["lib/b.ts"] }] } })
  runs.push(r.bind!)
  return { repo, run: r.bind!, dir: join(repo, ".scratch/jtasks/runs", r.bind!) }
}

const tasksOf = (dir: string) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile
const runOf = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile
const t01 = (dir: string) => tasksOf(dir).tasks[0]!
const logOf = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
const heldBy = (run: string, task: string) => jlockListJson("--group", run).filter((l) => l.holder?.owner === `gt:${run}/${task}`)

/** A process of our own that lives until the test kills it. */
function sleeper() {
  const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore", stderr: "ignore" })
  children.push(child)
  return child
}

describe("the processes of a task", () => {
  test("parseTasklist reads the CSV line of the pid, and nothing else", () => {
    expect(parseTasklist('"bun.exe","4242","Console","1","40,000 K"\r\n', 4242)).toEqual({ alive: true, image: "bun.exe" })
    expect(parseTasklist("INFO: No tasks are running which match the specified criteria.\r\n", 4242)).toEqual({ alive: false })
    expect(parseTasklist('"bun.exe","42420","Console","1","40,000 K"', 4242)).toEqual({ alive: false })
  })

  test("probe tells a live pid from a dead one; a reused pid (another executable) is not the registered process", async () => {
    const child = sleeper()
    expect((await probe(host, child.pid)).alive).toBe(true)
    const seen = await probe(host, child.pid, true)
    expect(seen.alive).toBe(true)
    expect(seen.image?.toLowerCase()).toContain("bun")
    expect(await procAlive(host, { pid: child.pid, startedAt: "", command: "x", by: "wait", image: "other.exe" })).toBe(false)
    child.kill()
    await child.exited
    expect((await probe(host, child.pid)).alive).toBe(false)
  })

  test("exec --task registers the pid while the command runs and takes it off at the end; wait lists them", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const running = tasksOk(repo, ["exec", "--task", "T01", "--", "bun", "-e", "await Bun.sleep(2500)"])
    let seen: number | undefined
    for (let i = 0; i < 100 && seen === undefined; i++) {
      await Bun.sleep(50)
      seen = t01(dir).procs?.[0]?.pid
    }
    expect(seen).toBeNumber()
    expect(t01(dir).procs![0]).toMatchObject({ by: "exec", command: 'bun -e await Bun.sleep(2500)' })
    expect((await tasksOk(repo, ["wait", "T01"])).text).toContain(`${seen} bun -e await Bun.sleep(2500) (vivo)`)
    const r = await running
    expect(r.text).toContain(`pid ${seen} registrado em T01`)
    expect(t01(dir).procs).toBeUndefined()
    expect(logOf(dir).some((e) => e.action === "procs" && e.task === "T01")).toBe(true)
  })

  test("wait --pid declares a live process and refuses a dead one", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const child = sleeper()
    const r = await tasksOk(repo, ["wait", "T01", "--pid", String(child.pid), "--command", "bun test e2e"])
    expect(r.text).toContain(`T01 aguarda ${child.pid} (bun test e2e)`)
    expect(t01(dir).procs![0]).toMatchObject({ pid: child.pid, by: "wait", command: "bun test e2e" })
    child.kill()
    await child.exited
    const dead = await tasks(repo, ["wait", "T01", "--pid", String(child.pid)])
    expect(dead.ok).toBe(false)
    expect(dead.text).toContain("nenhum processo vivo")
    expect((await tasks(repo, ["wait", "T01", "--pid", "abc"])).code).toBe(2)
  })
})

describe("the end of a subagent", () => {
  test("a live process keeps the task in progress, waiting: no attempt spent, the locks kept", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const child = sleeper()
    await tasksOk(repo, ["wait", "T01", "--pid", String(child.pid), "--command", "bun test"])
    const r = await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(r.text).toContain("T01 continua em andamento, aguardando o processo")
    expect(r.data).toMatchObject({ outcome: "awaiting", status: "in_progress" })
    const t = t01(dir)
    expect(t).toMatchObject({ status: "in_progress", attempts: 1, awaiting: { pids: [child.pid] } })
    expect(t.agentEnded).toBeUndefined()
    expect(heldBy(run, "T01")).toHaveLength(1)
    expect(logOf(dir).at(-1)).toMatchObject({ action: "await", task: "T01", pids: [child.pid] })
    // status and the view say so.
    const s = await tasksOk(repo, ["status"])
    expect(s.text).toContain(`aguardando processo: T01 (pid ${child.pid} (bun test), desde`)
    // A second end while it still runs changes nothing either.
    await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(t01(dir)).toMatchObject({ status: "in_progress", attempts: 1 })
    expect(heldBy(run, "T01")).toHaveLength(1)
    // The subagent comes back (the host saw its loop start): the wait is over.
    expect(await awaitBack(context(repo), run, "T01", "turn.start")).toBe(true)
    expect(t01(dir).awaiting).toBeUndefined()
    expect(t01(dir).status).toBe("in_progress")
  })

  test("the host's word (--waiting) keeps it waiting too, with no pid", async () => {
    const { repo, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const r = await tasksOk(repo, ["release", "T01", "--agent-ended", "--waiting", "background: bun test"])
    expect(r.data).toMatchObject({ outcome: "awaiting" })
    expect(t01(dir).awaiting).toMatchObject({ pids: [], host: "background: bun test" })
    // A CLI's status cannot ask that host: the wait is left alone.
    await tasksOk(repo, ["status"])
    expect(t01(dir).awaiting).toBeDefined()
  })

  test("a dead process counts: back to pending without spending an attempt, locks given back", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    const child = sleeper()
    await tasksOk(repo, ["wait", "T01", "--pid", String(child.pid)])
    child.kill()
    await child.exited
    const r = await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(r.text).toContain("T01 voltou a pendente (subagente terminou sem concluir 1/3; nenhuma tentativa gasta)")
    expect(t01(dir)).toMatchObject({ status: "pending", attempts: 0, agentEnded: 1 })
    expect(t01(dir).procs).toBeUndefined()
    expect(heldBy(run, "T01")).toHaveLength(0)
    expect(logOf(dir).at(-1)).toMatchObject({ action: "agent-ended", task: "T01", to: "pending", agentEnded: 1, max: 3 })
  })

  test("the process ends and the subagent does not come back: marked, then after awaitGrace it counts as ended", async () => {
    const { repo, run, dir } = await newRun({ awaitGrace: "3s" })
    await tasksOk(repo, ["start", "T01"])
    const child = sleeper()
    await tasksOk(repo, ["wait", "T01", "--pid", String(child.pid)])
    await tasksOk(repo, ["release", "T01", "--agent-ended"])
    const ctx = context(repo)
    expect(await sweepAwaiting(ctx, run)).toEqual([])
    child.kill()
    await child.exited
    const first = await sweepAwaiting(ctx, run)
    expect(first.map((e) => e.what)).toEqual(["ended"])
    expect(t01(dir).awaiting?.endedAt).toBeString()
    expect(logOf(dir).at(-1)).toMatchObject({ action: "await-ended", task: "T01" })
    expect((await tasksOk(repo, ["status"])).text).toContain("T01 (o processo terminou às")
    await Bun.sleep(3100)
    // `status` runs the same pass: the wait ran out.
    await tasksOk(repo, ["status"])
    expect(t01(dir)).toMatchObject({ status: "pending", attempts: 0, agentEnded: 1 })
    expect(heldBy(run, "T01")).toHaveLength(0)
    expect(logOf(dir).some((e) => e.action === "agent-ended" && e.expired === true)).toBe(true)
  }, 60_000)

  test("maxAgentEnded: the last end fails the task and pauses the run for a person; unpause and retry go on", async () => {
    const { repo, run, dir } = await newRun({ maxAgentEnded: 2, maxAttempts: 1 })
    await tasksOk(repo, ["start", "T01"])
    // maxAttempts 1: an ordinary release would fail it now; the end of a subagent does not spend attempts.
    await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(t01(dir)).toMatchObject({ status: "pending", attempts: 0, agentEnded: 1 })
    await tasksOk(repo, ["start", "T01"])
    const r = await tasksOk(repo, ["release", "T01", "--agent-ended"])
    expect(r.data).toMatchObject({ outcome: "limit", status: "failed" })
    expect(r.text).toContain(`execução ${run} pausada: precisa de uma pessoa`)
    expect(t01(dir)).toMatchObject({ status: "failed", agentEnded: 2, error: "o subagente terminou sem concluir 2 vezes (limite 2); a execução foi pausada para uma pessoa" })
    expect(runOf(dir)).toMatchObject({ status: "paused", needsPerson: { reason: "agent-ended", task: "T01", count: 2, max: 2 } })
    expect(logOf(dir).at(-1)).toMatchObject({ action: "agent-ended", to: "failed", paused: true })
    const s = await tasksOk(repo, ["status"])
    expect(s.text).toContain("precisa de uma pessoa: o subagente de T01 terminou sem concluir 2 vezes (limite 2)")
    expect((await tasks(repo, ["start", "T02"])).ok).toBe(false)
    await tasksOk(repo, ["unpause"])
    expect(runOf(dir).needsPerson).toBeUndefined()
    await tasksOk(repo, ["retry", "T01"])
    expect(t01(dir).agentEnded).toBeUndefined()
    expect(t01(dir).status).toBe("pending")
  })

  test("an explicit release still spends attempts (maxAttempts unchanged)", async () => {
    const { repo, dir } = await newRun({ maxAttempts: 1 })
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["release", "T01"])
    expect(t01(dir).status).toBe("failed")
  })

  test("only the waiting subagent ends the wait: the orchestrator's wait with the same pids (T17, fase3) keeps it and adds new ones", async () => {
    const { repo, dir } = await newRun()
    const agent = { tool: "claude" as const, session: "s1", agent: "a1" }
    const orchestrator = { tool: "claude" as const, session: "s1" }
    await tasksOk(repo, ["start", "T01"], agent)
    const first = sleeper()
    const second = sleeper()
    await tasksOk(repo, ["wait", "T01", "--pid", String(first.pid)], agent)
    await tasksOk(repo, ["release", "T01", "--agent-ended"], agent)
    expect(t01(dir).awaiting).toMatchObject({ agent: "a1", pids: [first.pid] })
    // The orchestrator declares the same pid: the wait goes on, and it is told to leave the task alone.
    const same = await tasksOk(repo, ["wait", "T01", "--pid", String(first.pid)], orchestrator)
    expect(same.text).toContain("T01 continua aguardando o processo do seu subagente")
    expect(same.text).toContain("O orquestrador não mexe na tarefa")
    expect(t01(dir).awaiting).toMatchObject({ agent: "a1", pids: [first.pid] })
    // A new pid is one more to wait for, never the end of the wait.
    await tasksOk(repo, ["wait", "T01", "--pid", `${first.pid},${second.pid}`], orchestrator)
    expect(t01(dir).awaiting).toMatchObject({ agent: "a1", pids: [first.pid, second.pid] })
    // Another subagent is no more the waiting one than the orchestrator.
    await tasksOk(repo, ["wait", "T01", "--pid", String(second.pid)], { ...agent, agent: "b2" })
    expect(t01(dir).awaiting).toBeDefined()
    expect(logOf(dir).some((e) => e.action === "await-back")).toBe(false)
    // The waiting subagent itself registering a process is back at work: the wait is over.
    const back = await tasksOk(repo, ["wait", "T01", "--pid", String(second.pid)], agent)
    expect(back.text).toContain(`T01 aguarda ${second.pid}`)
    expect(t01(dir).awaiting).toBeUndefined()
    expect(logOf(dir).filter((e) => e.action === "await-back")).toMatchObject([{ task: "T01", how: "procs", actor: "claude:s1/agent:a1" }])
  })

  test("a task that lost its wait waits again while its subagent is gone and its processes live; their end is told", async () => {
    const { repo, run, dir } = await newRun()
    await tasksOk(repo, ["start", "T01"], { tool: "claude" as const, session: "s1", agent: "a1" })
    const child = sleeper()
    // Registered and never waited for (the wait cleared by someone else's wait before 0.3.3, or never declared).
    await tasksOk(repo, ["wait", "T01", "--pid", String(child.pid)], { tool: "claude" as const, session: "s1", agent: "a1" })
    expect(t01(dir).awaiting).toBeUndefined()
    const ctx = context(repo, { tool: "claude" as const, session: "s1" })
    // No word on the agent, or the agent at work: left alone.
    expect(await sweepAwaiting(ctx, run)).toEqual([])
    expect(await sweepAwaiting(ctx, run, undefined, async () => true)).toEqual([])
    expect(await sweepAwaiting(ctx, run, undefined, async () => undefined)).toEqual([])
    expect(t01(dir).awaiting).toBeUndefined()
    // The agent is gone and the process lives: the task waits for it again, with the agent its owner names.
    const asked: string[] = []
    const gone = async (agent: string) => {
      asked.push(agent)
      return false
    }
    expect(await sweepAwaiting(ctx, run, undefined, gone)).toEqual([])
    expect(asked).toEqual(["a1"])
    expect(t01(dir)).toMatchObject({ status: "in_progress", awaiting: { agent: "a1", pids: [child.pid] } })
    expect(logOf(dir).at(-1)).toMatchObject({ action: "await", task: "T01", how: "sweep", agent: "a1", pids: [child.pid] })
    // The process ends: the usual "ended", naming the agent to resume.
    child.kill()
    await child.exited
    expect(await sweepAwaiting(ctx, run, undefined, gone)).toEqual([{ task: "T01", what: "ended", agent: "a1" }])
    expect(logOf(dir).at(-1)).toMatchObject({ action: "await-ended", task: "T01", agent: "a1" })
  })

  test("agentEnded as a function: expired waits only for a task still waiting", async () => {
    const { repo, run } = await newRun()
    await tasksOk(repo, ["start", "T01"])
    await expect(agentEnded(context(repo), { action: "release", positionals: ["T01"], options: { run } }, { expired: true })).rejects.toThrow("T01: o subagente voltou")
  })
})
