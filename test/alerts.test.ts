// What the host tells the orchestrator by itself (plan rev. 5.8): which log entries are news, where a host reads from,
// the message (English, for the model) with the status line, and the person's notice.

import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { alertNotice, alertText, briefStatus, deliveryKind, deliveryLabel, isAlert, logEnd, readAlerts, readBrief } from "../src/alerts.ts"
import { keepaliveDecision, nudgeText } from "../src/keepalive.ts"
import type { AutoPause } from "../src/schema.ts"
import { resumeText } from "../src/transient.ts"
import { readRun, readTasks, type LogEntry } from "../src/store.ts"
import { cleanupTemp, host, makeRepo, releaseGroup, tasksOk } from "./helpers.ts"

const runs: string[] = []
afterAll(async () => {
  for (const run of runs) releaseGroup(run)
  await Bun.sleep(400)
  cleanupTemp()
})

const ME = "claude:s1"
const entry = (e: Partial<LogEntry> & { action: string }): LogEntry => ({ at: "2026-10-27T10:00:00.000Z", actor: ME, ...e })

describe("which transitions are news", () => {
  test("what the host or the core did by itself always is", () => {
    for (const action of ["agent-ended", "await", "await-ended", "lost", "renew-lost"]) expect(isAlert(entry({ action, actor: `${ME}/agent:a1` }), ME)).toBe(true)
    expect(isAlert(entry({ action: "agent-ended" }), ME)).toBe(true)
  })

  test("what the orchestrator or its subagents asked for is not; a failure other than fail, or someone else, is", () => {
    expect(isAlert(entry({ action: "start", actor: `${ME}/agent:a1` }), ME)).toBe(false)
    expect(isAlert(entry({ action: "done", actor: `${ME}/agent:a1` }), ME)).toBe(false)
    expect(isAlert(entry({ action: "fail", actor: `${ME}/agent:a1`, to: "failed" }), ME)).toBe(false)
    expect(isAlert(entry({ action: "release", to: "failed" }), ME)).toBe(false)
    expect(isAlert(entry({ action: "pause" }), ME)).toBe(false)
    expect(isAlert(entry({ action: "pause", actor: "cli" }), ME)).toBe(true)
    expect(isAlert(entry({ action: "release", actor: "claude:other", to: "pending" }), ME)).toBe(true)
    expect(isAlert(entry({ action: "resume-release", actor: "claude:other", to: "failed" }), ME)).toBe(true)
    expect(isAlert(entry({ action: "keepalive-nudge" }), ME)).toBe(false)
  })
})

describe("reading a run's log", () => {
  test("from where the host started; only whole lines; the message and the notice", async () => {
    const repo = makeRepo("alerts", { "src/a.ts": "a\n", "README.md": "# t\n" })
    const r = await tasksOk(repo, ["plan"], { json: { tasks: [{ id: "T01", title: "Base", files: ["src"] }, { id: "T02", title: "Depois", files: ["lib"], dependsOn: ["T01"] }] } })
    const run = r.bind!
    runs.push(run)
    const dir = join(repo, ".scratch/jtasks/runs", run)
    const from = await logEnd(host, repo, run)
    expect((await readAlerts(host, repo, run, from, "cli")).entries).toEqual([])
    // A subagent of the CLI orchestrator starts and ends without finishing (as a host would report it).
    await tasksOk(repo, ["start", "T01"], { agent: "a1" })
    await tasksOk(repo, ["release", "T01", "--agent-ended"], { agent: "a1" })
    const read = await readAlerts(host, repo, run, from, "cli")
    expect(read.entries.map((e) => e.action)).toEqual(["agent-ended"])
    expect((await readAlerts(host, repo, run, read.offset, "cli")).entries).toEqual([])
    const file = (await readRun(host, dir))!
    const tasks = (await readTasks(host, dir))!
    const text = alertText(file, tasks, read.entries, "claude")
    expect(text).toContain(`jtasks: run ${run} changed without your asking`)
    expect(text).toContain("- T01: its subagent ended without finishing: back to pending, ready to start again with a new subagent (ends without finishing: 1 of 3; no attempt spent).")
    expect(text).toContain("Status now: feitas 0/2 (0%) · restam 2")
    expect(text).toContain("Go on with the protocol: jtasks next")
    expect(alertNotice(file, tasks, read.entries)).toBe("T01 voltou à fila: o subagente terminou sem concluir (1/3)")
    expect(await readBrief(host, repo, run)).toBe("feitas 0/2 (0%) · restam 2")
    // The person sees a few words for each message the host sends; the model reads the whole text.
    expect(deliveryKind(text)).toBe("alert")
    expect(deliveryLabel(text)).toBe("aviso da execução")
    expect(deliveryLabel(nudgeText(file, tasks, ["T01"], []))).toBe("execução parada, retomando")
    const pause = { kind: "rate_limit", detail: "429", tasks: [] } as unknown as AutoPause
    expect(deliveryLabel(resumeText(file, pause, [], "claude"))).toBe("execução volta da pausa")
    expect(deliveryLabel("something else")).toBe("mensagem")
  })

  test("the waits and the limit read as such; a paused run says to stop", async () => {
    const repo = makeRepo("alerts2", { "src/a.ts": "a\n", "README.md": "# t\n" })
    const r = await tasksOk(repo, ["plan"], { json: { maxAgentEnded: 1, tasks: [{ id: "T01", title: "Base", files: ["src"] }] } })
    const run = r.bind!
    runs.push(run)
    const dir = join(repo, ".scratch/jtasks/runs", run)
    const from = await logEnd(host, repo, run)
    await tasksOk(repo, ["start", "T01"], { agent: "a1" })
    await tasksOk(repo, ["release", "T01", "--agent-ended", "--waiting", "background: bun test"], { agent: "a1" })
    let read = await readAlerts(host, repo, run, from, "cli")
    let text = alertText((await readRun(host, dir))!, (await readTasks(host, dir))!, read.entries, "claude")
    expect(text).toContain("- T01: its subagent's loop ended while a process it started still runs (background: bun test)")
    expect(text).toContain("Status now: feitas 0/1 (0%) · 1 em andamento · restam 1 · em andamento: T01 (aguardando processo)")
    expect(alertNotice((await readRun(host, dir))!, (await readTasks(host, dir))!, read.entries)).toBe("T01 aguarda o processo (background: bun test); o subagente volta quando ele terminar")
    // Ended for good now (no process, no word from the host): the limit (1) fails it and pauses the run.
    await tasksOk(repo, ["release", "T01", "--agent-ended"], { agent: "a1" })
    read = await readAlerts(host, repo, run, read.offset, "cli")
    const file = (await readRun(host, dir))!
    const tasks = (await readTasks(host, dir))!
    text = alertText(file, tasks, read.entries, "opencode")
    expect(text).toContain("T01: its subagent ended without finishing, 1 times (the run's limit 1): T01 failed and the run is paused for a person.")
    expect(text).toContain("The run is paused: do not call jtasks next or start.")
    expect(briefStatus(file, tasks)).toContain("precisa de uma pessoa: o subagente de T01 terminou sem concluir 1 vezes (limite 1)")
    expect(alertNotice(file, tasks, read.entries)).toContain(`execução ${run} pausada: o subagente de T01 terminou 1 vezes sem concluir; precisa de uma pessoa`)
  })
})

describe("the keepalive", () => {
  test("a task waiting for its process is no orphan: nothing to nudge for it", async () => {
    const repo = makeRepo("alerts3", { "src/a.ts": "a\n", "README.md": "# t\n" })
    const r = await tasksOk(repo, ["plan"], { json: { tasks: [{ id: "T01", title: "Base", files: ["src"] }] } })
    runs.push(r.bind!)
    const dir = join(repo, ".scratch/jtasks/runs", r.bind!)
    await tasksOk(repo, ["start", "T01"])
    await tasksOk(repo, ["release", "T01", "--agent-ended", "--waiting", "x"])
    const state = { root: repo, dir, run: (await readRun(host, dir))!, tasks: (await readTasks(host, dir))! }
    expect(keepaliveDecision({ state, locks: [], platform: process.platform, liveAgents: 0, actor: "cli" })).toEqual({ action: "none", reason: "nothing-ready" })
  })
})
