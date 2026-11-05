// Ticket 60: eight real CLI processes changing one run at the same time (claim, wait --pid, status), with no write
// lock: every change lands, no event is lost, and the state every reader folds is the fold of the events from the
// snapshot they started on.

import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { foldLines, parseLines, type FoldState } from "../src/events.ts"
import type { RunFile, TasksFile } from "../src/schema.ts"
import { readState, strip } from "../src/store.ts"
import { CLI, cleanupTemp, host, makeRepo, releaseGroup, tasksOk, runPath } from "./helpers.ts"

const N = 8
const runs: string[] = []
const children: { kill(): void }[] = []
afterAll(async () => {
  for (const c of children) c.kill()
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(600)
  cleanupTemp()
})

async function cli(cwd: string, argv: string[]) {
  const p = Bun.spawn(["bun", CLI, ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, text: `${out}${err}`, argv: argv.join(" ") }
}

describe("eight CLI processes on one run", () => {
  test("claim, wait --pid and status at once: no event lost, every reader's state is the fold", async () => {
    const files: Record<string, string> = { "README.md": "# t\n" }
    for (let i = 1; i <= N; i++) files[`w${i}/own.txt`] = `${i}\n`
    const ids = Array.from({ length: N }, (_, i) => `T0${i + 1}`)
    const repo = makeRepo("multi", files)
    const r = await tasksOk(repo, ["plan"], { json: { branch: "current", tasks: ids.map((id, i) => ({ id, title: `Worker ${i + 1}`, files: [`w${i + 1}/own.txt`] })) } })
    const run = r.bind!
    runs.push(run)
    const dir = (await runPath(repo, run)).replace(/\\/g, "/")
    for (const id of ids) await tasksOk(repo, ["start", id, "--run", run])
    // The snapshot the concurrent phase starts on: a fold of the events from here must give the final state.
    const baseTasks = strip(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as TasksFile)
    const baseRun = strip(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunFile)
    const baseStamp = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as { eventOffset: number; gens: FoldState["gens"] }
    const sleepers = ids.map(() => {
      const c = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore", stderr: "ignore" })
      children.push(c)
      return c
    })
    const results = await Promise.all(
      ids.map(async (id, i) => [
        await cli(repo, ["claim", id, `w${i + 1}/extra.txt`, "--run", run, "--timeout", "30s"]),
        await cli(repo, ["wait", id, "--pid", String(sleepers[i]!.pid), "--run", run]),
        // All eight on the same task too: T01 gets every process, none lost to another's write.
        await cli(repo, ["wait", "T01", "--pid", String(sleepers[i]!.pid), "--run", run]),
        await cli(repo, ["status", "--run", run]),
      ]),
    )
    const failed = results.flat().filter((x) => x.code !== 0)
    expect(failed.map((f) => `${f.argv}: ${f.text}`)).toEqual([])

    const state = (await readState(host, dir))!
    const tasks = strip(state.tasks!)
    ids.forEach((id, i) => {
      const t = tasks.tasks.find((x) => x.id === id)!
      expect(t.status).toBe("in_progress")
      expect(t.claimed).toEqual([`w${i + 1}/extra.txt`])
      if (i > 0) expect(t.procs?.map((p) => p.pid)).toEqual([sleepers[i]!.pid])
    })
    const all = sleepers.map((c) => c.pid).sort((a, b) => a - b)
    expect(tasks.tasks[0]!.procs?.map((p) => p.pid).sort((a, b) => a - b)).toEqual(all)
    // Every line of events.jsonl is a whole event, and folding them from the starting snapshot gives the state.
    const text = readFileSync(join(dir, "events.jsonl"), "utf8")
    const read = parseLines(text, baseStamp.eventOffset)
    expect(read.lines.every((l) => l.event)).toBe(true)
    expect(read.end).toBe(Buffer.byteLength(text))
    const fold: FoldState = { run: baseRun, tasks: baseTasks, gens: structuredClone(baseStamp.gens) }
    const folded = foldLines(fold, read.lines)
    console.log(`multiprocess: ${results.flat().length} commands, ${folded.accepted.length} events accepted, ${folded.refused.length} refused (decided again)`)
    // 8 claims and 16 waits (one of them on T01 may change nothing: its own pid again); refused ones were made again.
    expect(folded.accepted.length).toBeGreaterThanOrEqual(3 * N - 1)
    expect(fold.tasks).toEqual(tasks)
    expect(fold.run).toEqual(strip(state.run!))
    expect(fold.gens).toEqual(state.gens)
    // The snapshot on disk, whichever writer wrote it last, folds to the same state too.
    const again = (await readState(host, dir))!
    expect(strip(again.tasks!)).toEqual(tasks)
    for (const c of sleepers) c.kill()
  }, 180_000)
})
