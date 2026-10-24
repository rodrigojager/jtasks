import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../src/host.ts"
import { resetJlockSetup } from "../src/setup.ts"
import { cleanupTemp, host, makeRepo, tasks, tasksOk, tempDir } from "./helpers.ts"

afterAll(cleanupTemp)
beforeEach(resetJlockSetup)
afterEach(resetJlockSetup)

const EXE = process.platform === "win32" ? "jlock.exe" : "jlock"
const REAL = Bun.which("jlock")!
const PLAN = { objective: "x", tasks: [{ id: "T01", title: "A", files: ["a.txt"] }] }

/** A machine where `jlock` is not in PATH: the bare name answers 127, as a shell would. */
function withoutJlock(vars: Record<string, string>): Host {
  return {
    ...host,
    env: (name) => (name in vars ? vars[name] : name === "JLOCK_BIN" ? undefined : host.env(name)),
    run: (argv, init) => (argv[0] === "jlock" ? Promise.resolve({ code: 127, stdout: "", stderr: "jlock: not found" }) : host.run(argv, init)),
  }
}

/** An installer that does what the real one does here: puts a jlock in JLOCK_INSTALL_DIR (a copy of the real one). */
function installer(exitCode = 0): string {
  const file = join(tempDir("installer"), "install.ts")
  writeFileSync(
    file,
    exitCode
      ? `console.error("no network"); process.exit(${exitCode})\n`
      : `import { copyFileSync } from "node:fs"\ncopyFileSync(${JSON.stringify(REAL)}, process.env.JLOCK_INSTALL_DIR + "/${EXE}")\n`,
  )
  return file
}

describe("jlock comes with jtasks", () => {
  test("a missing jlock is installed by the first command that needs it, used at once, recorded, and told once", async () => {
    const repo = makeRepo()
    const bin = tempDir("jlock-bin")
    const h = withoutJlock({ JTASKS_JLOCK_INSTALLER: installer(), JLOCK_INSTALL_DIR: bin })
    const exe = join(bin, EXE).replace(/\\/g, "/")
    const plan = await tasksOk(repo, ["plan"], { host: h, json: PLAN })
    expect(plan.text.split("\n")[0]).toBe(`o jlock não estava instalado e agora está em ${exe} (jtasks undo ${/g-[\w-]+/.exec(plan.text)![0]} o remove)`)
    expect(existsSync(exe)).toBe(true)
    // The installed jlock answers at once, though PATH never had it; the notice is not repeated.
    const status = await tasksOk(repo, ["status"], { host: h, boundRun: plan.bind! })
    expect(status.text).not.toContain("jlock")
    const ledger = await tasksOk(repo, ["ledger", "--all-projects"], { host: h })
    const installs = (ledger.data as { effects: { type: string; path: string }[] }).effects.filter((e) => e.type === "install")
    expect(installs.map((e) => e.path)).toContain(exe)
  })

  test("a jlock already where the installer puts it, but not in PATH, is used without installing again", async () => {
    const repo = makeRepo()
    const bin = tempDir("jlock-bin")
    copyFileSync(REAL, join(bin, EXE))
    const h = withoutJlock({ JTASKS_JLOCK_INSTALLER: installer(3), JLOCK_INSTALL_DIR: bin })
    const plan = await tasksOk(repo, ["plan"], { host: h, json: PLAN })
    expect(plan.text).not.toContain("jlock")
    expect((await tasksOk(repo, ["status"], { host: h, boundRun: plan.bind! })).ok).toBe(true)
  })

  test("an install that fails says why and how to install by hand; the command still runs", async () => {
    const repo = makeRepo()
    const h = withoutJlock({ JTASKS_JLOCK_INSTALLER: installer(3), JLOCK_INSTALL_DIR: tempDir("jlock-bin") })
    const plan = await tasksOk(repo, ["plan"], { host: h, json: PLAN })
    const first = plan.text.split("\n")[0]!
    expect(first).toStartWith("o jlock não está instalado e a instalação automática falhou (o instalador do jlock saiu com 3: no network); instale com: ")
    expect(first).toEndWith(process.platform === "win32" ? "install.ps1 | iex" : "install.sh | sh")
    const status = await tasks(repo, ["status"], { host: h, boundRun: plan.bind! })
    expect(status.ok).toBe(false)
    expect(status.text).not.toContain("instalação automática")
  })

  test("JLOCK_BIN or JTASKS_NO_JLOCK_INSTALL=1 leaves jlock to the user; help, doctor and validate never install", async () => {
    const repo = makeRepo()
    const bin = tempDir("jlock-bin")
    for (const vars of [{ JTASKS_NO_JLOCK_INSTALL: "1" }, { JLOCK_BIN: "jlock-of-my-own" }] as Record<string, string>[]) {
      resetJlockSetup()
      const h = withoutJlock({ JTASKS_JLOCK_INSTALLER: installer(), JLOCK_INSTALL_DIR: bin, ...vars })
      const r = await tasks(repo, ["status"], { host: h })
      expect(r.text).not.toContain("o jlock não estava instalado")
    }
    resetJlockSetup()
    const h = withoutJlock({ JTASKS_JLOCK_INSTALLER: installer(), JLOCK_INSTALL_DIR: bin })
    for (const argv of [["help"], ["validate"], ["doctor"]]) await tasks(repo, argv, { host: h, json: PLAN })
    expect(existsSync(join(bin, EXE))).toBe(false)
  })
})
