import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../src/host.ts"
import type { Check } from "../src/doctor.ts"
import { cleanupTemp, host, makeRepo, REPO_ROOT, tasks, tempDir } from "./helpers.ts"

afterAll(cleanupTemp)

/** The node host with some variables replaced (the doctor reads them through the host). */
function withEnv(vars: Record<string, string>): Host {
  return { ...host, env: (name) => (name in vars ? vars[name] : host.env(name)) }
}

async function doctor(cwd: string, vars: Record<string, string>, argv: string[] = []) {
  return tasks(cwd, ["doctor", ...argv], { host: withEnv(vars), packageRoot: REPO_ROOT })
}

const checksOf = (r: { data?: unknown }) => (r.data as { checks: Check[] }).checks
const check = (r: { data?: unknown }, name: string) => checksOf(r).find((c) => c.name === name)!

describe("tasks doctor", () => {
  test("a healthy machine: eight checks in order, none failing, exit 0, the same in --json", async () => {
    const repo = makeRepo()
    const home = tempDir("user-home")
    const r = await doctor(repo, { GOAL_TASKS_USER_HOME: home })
    expect(checksOf(r).map((c) => c.name)).toEqual(["version", "git", "jlock", "home", "opencode", "claude", "skills", "language"])
    expect(checksOf(r).filter((c) => c.status === "fail")).toEqual([])
    expect(r.code).toBe(0)
    expect(check(r, "version").detail).toMatch(/^goal-tasks \d+\.\d+\.\d+ · bun \d/)
    expect(check(r, "jlock").detail).toMatch(/^jlock \d+\.\d+\.\d+/)
    expect(check(r, "language").detail).toBe("pt-BR (GOAL_TASKS_LANG)")
    // No agent is installed in this home: nothing to check for OpenCode nor the skills.
    expect(check(r, "opencode").status).toBe("ok")
    expect(check(r, "skills").status).toBe("ok")
    expect(r.text.split("\n").at(-1)).toMatch(/^ok: \d+, avisos: \d+, falhas: 0$/)
    const json = (r.data as { result: string; summary: { fail: number } })
    expect(json.result).toBe("ok")
    expect(json.summary.fail).toBe(0)
  })

  test("GOAL_TASKS_HOME pointing at a file fails with exit 20 and says what to do", async () => {
    const repo = makeRepo()
    const file = join(tempDir("not-a-home"), "file.txt")
    writeFileSync(file, "x")
    const r = await doctor(repo, { GOAL_TASKS_HOME: file, GOAL_TASKS_USER_HOME: tempDir("user-home") })
    expect(r.code).toBe(20)
    expect(check(r, "home")).toMatchObject({ status: "fail" })
    expect(check(r, "home").fix).toBeString()
  })

  test("without jlock: a failure whose fix is doctor --fix", async () => {
    const repo = makeRepo()
    const r = await doctor(repo, { JLOCK_BIN: "jlock-that-does-not-exist", GOAL_TASKS_USER_HOME: tempDir("user-home") })
    expect(r.code).toBe(20)
    expect(check(r, "jlock").status).toBe("fail")
    expect(check(r, "jlock").fix).toContain("tasks doctor --fix --yes")
  })

  test("OpenCode installed without the agents and the skills: warnings, exit 0", async () => {
    const repo = makeRepo()
    const home = tempDir("user-home")
    mkdirSync(join(home, ".config/opencode"), { recursive: true })
    const r = await doctor(repo, { GOAL_TASKS_USER_HOME: home })
    expect(r.code).toBe(0)
    expect(check(r, "opencode")).toMatchObject({ status: "warn", fix: "tasks doctor --fix --yes" })
    expect(check(r, "opencode").detail).toContain("implement, implement-deep, review")
    expect(check(r, "skills")).toMatchObject({ status: "warn", fix: "tasks doctor --fix --yes" })
    expect(check(r, "skills").detail).toContain("opencode/to-tickets, opencode/goal-tasks")
  })

  test("the agents found in opencode.json count; the language follows --lang", async () => {
    const repo = makeRepo()
    const home = tempDir("user-home")
    mkdirSync(join(home, ".config/opencode"), { recursive: true })
    writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({ agent: { implement: {}, "implement-deep": {}, review: {} }, plugins: ["D:/goal-tasks/opencode"] }))
    const r = await doctor(repo, { GOAL_TASKS_USER_HOME: home }, ["--lang", "en"])
    expect(check(r, "opencode").status).toBe("ok")
    expect(check(r, "language").detail).toBe("en (--lang)")
    expect(r.text.split("\n").at(-1)).toMatch(/^ok: \d+, warnings: \d+, failures: 0$/)
  })
})
