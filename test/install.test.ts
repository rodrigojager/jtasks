import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Host } from "../src/host.ts"
import { cleanupTemp, host, makeRepo, REPO_ROOT, tasks, tasksOk, tempDir } from "./helpers.ts"
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

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
    // 3 agents + 3 hosts × (to-jtasks: 3 files, jtasks: 1 file).
    expect(planned).toHaveLength(3 + 3 * 4)
    expect(existsSync(join(home, ".config/opencode/agents/execute.md"))).toBe(false)
  })

  test("--fix --yes copies the agents and the skills, records each file in the global ledger, and undo removes one", async () => {
    const repo = makeRepo()
    const home = agentHome()
    // A skill file the user already has, with other content: kept.
    mkdirSync(join(home, ".codex/skills/jtasks"), { recursive: true })
    writeFileSync(join(home, ".codex/skills/jtasks/SKILL.md"), "mine\n")
    const ctx = { host: withEnv({ JTASKS_USER_HOME: home }), packageRoot: REPO_ROOT }
    const r = await tasksOk(repo, ["doctor", "--fix", "--yes"], ctx)
    const agent = join(home, ".config/opencode/agents/execute-deep.md")
    expect(readFileSync(agent, "utf8")).toBe(readFileSync(join(REPO_ROOT, "opencode/agents/execute-deep.md"), "utf8"))
    for (const h of [".claude/skills", ".config/opencode/skills", ".codex/skills"]) expect(existsSync(join(home, h, "to-jtasks/schema.json"))).toBe(true)
    expect(readFileSync(join(home, ".claude/skills/jtasks/SKILL.md"), "utf8")).toBe(readFileSync(join(REPO_ROOT, "skills/claude-code/jtasks/SKILL.md"), "utf8"))
    // The user's own file stays, and the next check still sees a skill there.
    expect(readFileSync(join(home, ".codex/skills/jtasks/SKILL.md"), "utf8")).toBe("mine\n")
    // Nothing for Codex goes to ~/.agents/skills, which OpenCode reads as well.
    expect(existsSync(join(home, ".agents/skills/jtasks"))).toBe(false)
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
    expect(existsSync(join(home, ".config/opencode/agents/execute.md"))).toBe(true)
    const again = await tasks(repo, ["undo", e.id])
    expect(again.ok).toBe(false)
  })

  test("an outdated copy is replaced, a current one left alone, and undo puts the old copy back", async () => {
    const repo = makeRepo()
    const home = agentHome()
    const jtasksHome = tempDir("jtasks-home")
    const ctx = { host: withEnv({ JTASKS_USER_HOME: home, JTASKS_HOME: jtasksHome }), packageRoot: REPO_ROOT }
    await tasksOk(repo, ["doctor", "--fix", "--yes"], ctx)
    // An older build of a recorded skill, and of a recorded agent.
    const skill = join(home, ".config/opencode/skills/jtasks/SKILL.md")
    const agent = join(home, ".config/opencode/agents/review.md")
    const oldSkill = "---\nname: jtasks\ndescription: an older build\n---\n\nold\n"
    writeFileSync(skill, oldSkill)
    writeFileSync(agent, "old agent\n")
    const current = join(home, ".codex/skills/to-jtasks/SKILL.md")
    const before = statSync(current).mtimeMs

    const check = await tasks(repo, ["doctor"], ctx)
    const checks = (check.data as { checks: { name: string; status: string; detail: string }[] }).checks
    expect(checks.find((c) => c.name === "skills")!.detail).toContain("opencode/jtasks")
    expect(checks.find((c) => c.name === "opencode")!.detail).toContain("review")
    // Without --yes: one line per file, nothing written.
    const planned = ((await tasksOk(repo, ["doctor", "--fix"], ctx)).data as { planned: string[] }).planned
    expect(planned).toHaveLength(2)
    expect(readFileSync(skill, "utf8")).toBe(oldSkill)

    const r = await tasksOk(repo, ["doctor", "--fix", "--yes"], ctx)
    expect((r.data as { fixed: string[] }).fixed).toHaveLength(2)
    expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(REPO_ROOT, "skills/opencode/jtasks/SKILL.md"), "utf8"))
    expect(readFileSync(agent, "utf8")).toBe(readFileSync(join(REPO_ROOT, "opencode/agents/review.md"), "utf8"))
    expect(statSync(current).mtimeMs).toBe(before)
    // No backup beside the skill.
    expect(readdirSync(join(home, ".config/opencode/skills/jtasks"))).toEqual(["SKILL.md"])
    const after = (r.data as { after: { name: string; status: string }[] }).after
    expect(after.find((c) => c.name === "skills")!.status).toBe("ok")
    expect(after.find((c) => c.name === "opencode")!.status).toBe("ok")

    const ledger = await tasksOk(repo, ["ledger", "--all-projects"], ctx)
    const effects = (ledger.data as { effects: { id: string; path: string; state: string; undo: { kind: string } }[] }).effects
    const replaced = effects.find((e) => e.path === skill.replace(/\\/g, "/") && e.undo.kind === "restore-file")!
    const undone = await tasksOk(repo, ["undo", replaced.id], ctx)
    expect(undone.text).toContain(replaced.id)
    expect(readFileSync(skill, "utf8")).toBe(oldSkill)
    expect(readdirSync(join(jtasksHome, "undo"))).toHaveLength(1)
  })

  test("an unrecorded copy whose SKILL.md names the skill is replaced; one that does not is kept", async () => {
    const repo = makeRepo()
    const home = agentHome()
    const ctx = { host: withEnv({ JTASKS_USER_HOME: home, JTASKS_HOME: tempDir("jtasks-home") }), packageRoot: REPO_ROOT }
    const ours = join(home, ".codex/skills/jtasks/SKILL.md")
    const theirs = join(home, ".codex/skills/to-jtasks/SKILL.md")
    mkdirSync(dirname(ours), { recursive: true })
    mkdirSync(dirname(theirs), { recursive: true })
    const old = "---\nname: \"jtasks\"\ndescription: copied by hand\n---\n\nold\n"
    writeFileSync(ours, old)
    writeFileSync(theirs, "---\nname: my-own-skill\n---\n")
    const r = await tasksOk(repo, ["doctor", "--fix", "--yes"], ctx)
    expect(readFileSync(ours, "utf8")).toBe(readFileSync(join(REPO_ROOT, "skills/codex/jtasks/SKILL.md"), "utf8"))
    expect(readFileSync(theirs, "utf8")).toBe("---\nname: my-own-skill\n---\n")
    const line = (r.data as { fixed: string[] }).fixed.find((f) => f.includes(ours.replace(/\\/g, "/")))!
    const id = /\((g-\d{4})/.exec(line)![1]!
    await tasksOk(repo, ["undo", id], ctx)
    expect(readFileSync(ours, "utf8")).toBe(old)
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
