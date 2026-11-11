// Real, disposable process trees and an unrelated sibling. No live run registry or model calls.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test"
import { createServer } from "node:net"
import { createNodeHost } from "../src/node-host.ts"
import { cleanupTemp, JLOCK, makeRepo, releaseGroup, tasks, tasksOk } from "./helpers.ts"

setDefaultTimeout(30_000)
const runs: string[] = []
afterAll(() => { for (const run of runs) releaseGroup(run); cleanupTemp() })

for (const serialized of [false, true]) {
  test(`cancellation stops only its native command tree (${serialized ? "serialized" : "direct"})`, async () => {
    const host = createNodeHost()
    const controller = new AbortController()
    let ready!: (pid: number) => void
    const childReady = new Promise<number>((r) => { ready = r })
    const server = createServer((socket) => { socket.once("data", (data) => ready(Number(data.toString()))); socket.on("error", () => {}) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as { port: number }).port
    const node = Bun.which("node")!
    const script = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',"const s=require('node:net').connect(${port},'127.0.0.1',()=>s.end(String(process.pid))); setTimeout(()=>{},8000)"],{stdio:'inherit'});
setTimeout(()=>{},8000)`
    const repo = makeRepo("cancel", { "runner.cjs": script })
    const planned = await tasksOk(repo, ["plan"], { json: { ...(serialized ? { serialize: ["runner.cjs"] } : {}), tasks: [{ id: "T01", title: "Cancel", files: ["runner.cjs"] }] } })
    runs.push(planned.bind!)
    await tasksOk(repo, ["start", "T01"])
    const unrelated = await host.spawn([node, "-e", "setTimeout(()=>{},15000)"])
    try {
      const running = tasks(repo, ["exec", "--task", "T01", "--timeout", "10s", "--", node, "runner.cjs"], { signal: controller.signal })
      const grandchild = await childReady
      const began = Date.now()
      controller.abort()
      controller.abort()
      const result = await running
      expect(Date.now() - began).toBeLessThan(4000)
      expect(result.ok).toBe(false)
      expect(await host.alive!(grandchild)).toBe(false)
      expect(await host.alive!(unrelated.pid!)).toBe(true)
      const status = await tasksOk(repo, ["status"])
      expect(status.text).toContain("T01")
      const { readTasks, runDir, requirePaths } = await import("../src/index.ts")
      const paths = await requirePaths(host, repo)
      const task = (await readTasks(host, runDir(paths.dataDir, planned.bind!)))!.tasks[0]!
      expect(task.status).toBe("in_progress")
      expect(task.attempts).toBe(1)
      expect(task.procs ?? []).toHaveLength(0)
    } finally {
      controller.abort()
      await unrelated.stop()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
}

test("already aborted invocation never spawns, and later abort cannot affect an exited child", async () => {
  const host = createNodeHost()
  const controller = new AbortController()
  controller.abort()
  let spawned = false
  const result = await host.run([JLOCK, "--version"], { signal: controller.signal, onStart: () => { spawned = true } })
  expect(spawned).toBe(false)
  expect(result.code).not.toBe(0)
  const later = new AbortController()
  expect((await host.run([JLOCK, "--version"], { signal: later.signal })).code).toBe(0)
  later.abort()
})
