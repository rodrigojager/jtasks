// The plugin's side of rev. 5.8: a child session that goes idle while a process of its task runs leaves the task
// waiting for it (in progress, locks and binding kept); the process ending tells the root session to resume that
// same session (OpenCode does not reopen it); every transition the root did not ask for reaches it at once as a
// synthetic message, with the status line, and the TUI as an `alert` event; a subagent call's result carries the
// status line.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TasksRpc } from "../src/rpc.ts"
import { cleanupTemp, fakeHost, makeRepo, sh } from "./fake-host.ts"

setDefaultTimeout(60_000)

const cleanups: (() => Promise<void>)[] = []
const children: { kill(): void }[] = []
afterAll(async () => {
  for (const c of children) c.kill()
  for (const c of cleanups) await c()
  await Bun.sleep(400)
  cleanupTemp()
})

const until = async (check: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !check(); i++) await Bun.sleep(50)
  expect(check()).toBe(true)
}

async function setup(plan: Record<string, unknown> = {}) {
  const repo = makeRepo()
  const h = await fakeHost(repo, undefined, { alertEveryMs: 60 })
  if (h.cleanup) cleanups.push(h.cleanup)
  const planned = await h.call("s1", "plan", { ...plan, tasks: [{ id: "T01", title: "Base", files: ["src/a.ts"] }, { id: "T02", title: "Depois", files: ["src/b.ts"], dependsOn: ["T01"] }] })
  const run = /execução (\S+) criada/.exec(planned.text)![1]!
  const dir = join(repo, ".scratch/jtasks/runs", run)
  const alerts: { run: string; notice: string }[] = []
  h.rpcClient(TasksRpc).events.on("alert", (e: { data: unknown }) => void alerts.push(e.data as { run: string; notice: string }))
  h.addSession("c1", "s1")
  expect((await h.call("c1", "start T01")).ok).toBe(true)
  const t01 = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0]
  const locks = () => (JSON.parse(sh(repo, "jlock", "list", "--group", run, "--json")) as { locks: unknown[] }).locks
  const toRoot = () => h.synthetics.filter((s) => s.sessionID === "s1").map((s) => s.text)
  return { repo, h, run, dir, alerts, t01, locks, toRoot }
}

describe("rev. 5.8 in OpenCode", () => {
  test("a child session idle while its registered process runs: the task waits; the process ends: the root is told to resume that session", async () => {
    const s = await setup({ awaitGrace: "1h" })
    const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore", stderr: "ignore" })
    children.push(child)
    expect((await s.h.call("c1", `wait T01 --pid ${child.pid} --command "bun test e2e"`)).ok).toBe(true)
    s.h.emit("session.idle", { sessionID: "c1" })
    await until(() => !!s.t01().awaiting)
    expect(s.t01()).toMatchObject({ status: "in_progress", attempts: 1, awaiting: { agent: "c1", pids: [child.pid] } })
    expect(s.locks()).toHaveLength(1)
    // The root hears of it at once, and the TUI shows a toast.
    await until(() => s.toRoot().some((t) => t.includes("T01: its subagent's loop ended while a process it started still runs")))
    expect(s.toRoot().at(-1)).toContain("Status now: feitas 0/2 (0%) · 1 em andamento · restam 2 · em andamento: T01 (aguardando processo)")
    await until(() => s.alerts.some((a) => a.notice.includes("T01 aguarda o processo")))
    // The session keeps its binding: a second idle (still running) changes nothing.
    s.h.emit("session.idle", { sessionID: "c1" })
    await Bun.sleep(300)
    expect(s.t01()).toMatchObject({ status: "in_progress", attempts: 1 })
    // The process ends: the root is told to resume the same session (task_id).
    child.kill()
    await child.exited
    await until(() => s.toRoot().some((t) => t.includes("T01: the process its subagent waited for ended.") && t.includes("the task tool with task_id c1")))
    expect(s.t01().awaiting.endedAt).toBeString()
    // The root resumes it: its execution starts, the wait is over.
    s.h.emit("session.execution.started", { sessionID: "c1" })
    await until(() => !s.t01().awaiting)
    expect(s.t01().status).toBe("in_progress")
    // A subagent call's result carries the status line read at its end.
    const event = { tool: "subagent", sessionID: "s1", agent: "build", messageID: "m", id: "c", input: {}, status: "completed", result: { content: "T01 pronta" } }
    await s.h.hooks.get("tool.execute.after")!(event)
    expect(event.result.content).toBe(`T01 pronta\n\njtasks status of run ${s.run}, read now from tasks.json: feitas 0/2 (0%) · 1 em andamento · restam 2 · em andamento: T01`)
  })

  test("a child session idle with nothing running: back to the queue, no attempt spent, and the root told even with nothing ready", async () => {
    const s = await setup()
    s.h.emit("session.idle", { sessionID: "c1" })
    await until(() => s.t01().status === "pending")
    expect(s.t01()).toMatchObject({ attempts: 0, agentEnded: 1 })
    await until(() => s.toRoot().some((t) => t.includes("T01: its subagent ended without finishing: back to pending")))
    await until(() => s.alerts.some((a) => a.notice.includes("T01 voltou à fila")))
  })

  test("the limit of ends pauses the run for a person, and the root is told so", async () => {
    const s = await setup({ maxAgentEnded: 1 })
    s.h.emit("session.idle", { sessionID: "c1" })
    await until(() => s.t01().status === "failed")
    expect(JSON.parse(readFileSync(join(s.dir, "run.json"), "utf8"))).toMatchObject({ status: "paused", needsPerson: { task: "T01", count: 1, max: 1 } })
    await until(() => s.toRoot().some((t) => t.includes("T01 failed and the run is paused for a person") && t.includes("The run is paused: do not call jtasks next or start.")))
  })
})
