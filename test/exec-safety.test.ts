// Real, bounded descendants in a private test registry. No model calls or live run data.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createNodeHost } from "../src/node-host.ts"
import { cleanupTemp, makeRepo, releaseGroup, runPath, tasks, tasksOk, tempDir } from "./helpers.ts"

setDefaultTimeout(60_000)
const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

for (const serialized of [false, true]) {
  test(`exec deadline cleans shell descendants and preserves task state (${serialized ? "serialized" : "direct"})`, async () => {
    const marker = join(tempDir("exec-marker"), "late.txt")
    const script = `
const { spawn } = require("node:child_process")
spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'escaped'), 1800)", process.argv[2]], { stdio: "inherit" })
setTimeout(() => {}, 4000)
`
    const repo = makeRepo("exec-safety", { "runner.cjs": script, "README.md": "original\n" })
    // PowerShell reproduces the original inherited-pipe failure on Windows. Unix uses a shell too.
    const node = Bun.which("node") ?? process.execPath
    const argv = process.platform === "win32"
      ? ["pwsh", "-NoProfile", "-Command", "& $args[0] $args[1] $args[2]", node, "runner.cjs", marker]
      : ["sh", "-c", '"$0" "$1" "$2"', node, "runner.cjs", marker]
    // PowerShell -Command consumes its trailing arguments as code, so use literal paths safely.
    if (process.platform === "win32") {
      const literal = (s: string) => `'${s.replace(/'/g, "''")}'`
      argv.splice(3, argv.length, `& ${literal(node)} ${literal("runner.cjs")} ${literal(marker)}`)
    }
    const plan = await tasksOk(repo, ["plan"], { json: {
      ...(serialized ? { serialize: [argv.join(" ")] } : {}),
      tasks: [{ id: "T01", title: "Execution", exclusive: "project" }],
    } })
    const run = plan.bind!
    runs.push(run)
    await tasksOk(repo, ["start", "T01"])
    writeFileSync(join(repo, "README.md"), "work in progress\n")
    const dir = await runPath(repo, run)
    const before = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0]
    const began = Date.now()
    const result = await tasks(repo, ["exec", "--task", "T01", "--timeout", "900ms", "--", ...argv])
    expect(result.code).toBe(124)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ timedOut: true, serialized, task: "T01" })
    expect(Date.now() - began).toBeLessThan(5000)
    const after = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0]
    expect(after.status).toBe("in_progress")
    expect(after.owner).toBe(before.owner)
    expect(after.attempts).toBe(before.attempts)
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("work in progress\n")
    const status = await tasksOk(repo, ["status"])
    expect(status.text).toContain("T01")
    await Bun.sleep(2000)
    expect(existsSync(marker)).toBe(false)
    // A second exec still works under the same exclusive task; no stuck serialization keeper.
    expect((await tasks(repo, ["exec", "--task", "T01", "--timeout", "10s", "--", node, "-e", "process.exit(0)"])).ok).toBe(true)
  })
}

test("Node host drains large output while keeping bounded, explicitly truncated tails", async () => {
  const result = await createNodeHost().run([process.execPath, "-e", 'process.stdout.write("x".repeat(2*1024*1024)+"END"); process.stderr.write("y".repeat(2*1024*1024)+"END")'], { timeoutMs: 10_000 })
  expect(result.code).toBe(0)
  for (const text of [result.stdout, result.stderr]) {
    expect(text).toContain("truncated")
    expect(text.endsWith("END")).toBe(true)
    expect(text.length).toBeLessThan(1024 * 1024 + 100)
  }
})
