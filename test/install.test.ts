import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../src/host.ts"
import { cleanupTemp, host, makeRepo, REPO_ROOT, tasks, tasksOk, tempDir } from "./helpers.ts"

afterAll(cleanupTemp)

function withEnv(vars: Record<string, string>): Host {
  return { ...host, env: (name) => (name in vars ? vars[name] : host.env(name)) }
}

/** A user home where OpenCode, Claude Code and Codex are "installed" (their folders exist) and nothing of ours is. */
function agentHome(): string {
  const home = tempDir("user-home")
  for (const d of [".claude", ".config/opencode", ".codex"]) mkdirSync(join(home, d), { recursive: true })
  return home
}

describe("jtasks doctor --fix", () => {
  test("without --yes it lists what it would install and writes nothing", async () => {
    const repo = makeRepo()
    const home = agentHome()
    const ctx = { host: withEnv({ JTASKS_USER_HOME: home }), packageRoot: REPO_ROOT }
    const r = await tasksOk(repo, ["doctor", "--fix"], ctx)
    const planned = (r.data as { planned: string[] }).planned
    // 3 agents + 3 hosts × (to-tickets: 3 files, jtasks: 1 file).
    expect(planned).toHaveLength(3 + 3 * 4)
    expect(existsSync(join(home, ".config/opencode/agents/implement.md"))).toBe(false)
  })

  test("--fix --yes copies the agents and the skills, records each file in the global ledger, and undo removes one", async () => {
    const repo = makeRepo()
    const home = agentHome()
    // A skill file the user already has, with other content: kept.
    mkdirSync(join(home, ".agents/skills/jtasks"), { recursive: true })
    writeFileSync(join(home, ".agents/skills/jtasks/SKILL.md"), "mine\n")
    const ctx = { host: withEnv({ JTASKS_USER_HOME: home }), packageRoot: REPO_ROOT }
    const r = await tasksOk(repo, ["doctor", "--fix", "--yes"], ctx)
    const agent = join(home, ".config/opencode/agents/implement-deep.md")
    expect(readFileSync(agent, "utf8")).toBe(readFileSync(join(REPO_ROOT, "opencode/agents/implement-deep.md"), "utf8"))
    for (const h of [".claude/skills", ".config/opencode/skills", ".agents/skills"]) expect(existsSync(join(home, h, "to-tickets/schema.json"))).toBe(true)
    expect(readFileSync(join(home, ".claude/skills/jtasks/SKILL.md"), "utf8")).toBe(readFileSync(join(REPO_ROOT, "skills/claude-code/jtasks/SKILL.md"), "utf8"))
    // The user's own file stays, and the next check still sees a skill there.
    expect(readFileSync(join(home, ".agents/skills/jtasks/SKILL.md"), "utf8")).toBe("mine\n")
    const after = (r.data as { after: { name: string; status: string }[] }).after
    expect(after.find((c) => c.name === "opencode")!.status).toBe("ok")
    expect(after.find((c) => c.name === "skills")!.status).toBe("ok")

    const ledger = await tasksOk(repo, ["ledger", "--all-projects"])
    const installs = (ledger.data as { effects: { id: string; type: string; path: string; state: string }[] }).effects.filter((e) => e.type === "install")
    expect(installs.map((e) => e.path)).toContain(agent.replace(/\\/g, "/"))
    const e = installs.find((x) => x.path === agent.replace(/\\/g, "/"))!
    expect(e.id).toMatch(/^g-\d{4}$/)
    const undone = await tasksOk(repo, ["undo", e.id])
    expect(undone.text).toContain(e.id)
    expect(existsSync(agent)).toBe(false)
    expect(existsSync(join(home, ".config/opencode/agents/implement.md"))).toBe(true)
    const again = await tasks(repo, ["undo", e.id])
    expect(again.ok).toBe(false)
  })

  test("a missing jlock is installed by the installer (a fake one here), and the binary is recorded", async () => {
    const repo = makeRepo()
    const home = tempDir("user-home")
    const bin = tempDir("jlock-bin")
    const installer = join(tempDir("installer"), "install.ts")
    writeFileSync(installer, `import { writeFileSync } from "node:fs"\nwriteFileSync(process.env.JLOCK_INSTALL_DIR + "/${process.platform === "win32" ? "jlock.exe" : "jlock"}", "fake")\n`)
    const vars = { JTASKS_USER_HOME: home, JLOCK_BIN: "jlock-that-does-not-exist", JTASKS_JLOCK_INSTALLER: installer, JLOCK_INSTALL_DIR: bin }
    const r = await tasksOk(repo, ["doctor", "--fix", "--yes"], { host: withEnv(vars), packageRoot: REPO_ROOT })
    const exe = join(bin, process.platform === "win32" ? "jlock.exe" : "jlock").replace(/\\/g, "/")
    expect(readFileSync(exe, "utf8")).toBe("fake")
    expect((r.data as { fixed: string[] }).fixed.join("\n")).toContain(exe)
  })

  test("--fix runs only in the CLI: the mod and the plugin only diagnose", async () => {
    const repo = makeRepo()
    const r = await tasks(repo, ["doctor", "--fix", "--yes"], { tool: "claude", packageRoot: REPO_ROOT })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("jtasks doctor --fix --yes")
  })
})
