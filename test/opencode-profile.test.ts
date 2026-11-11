import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupTemp, tempDir } from "./helpers.ts"

afterAll(cleanupTemp)
const windows = test.skipIf(process.platform !== "win32")
const shell = process.env.ProgramFiles + "/PowerShell/7/pwsh.exe"
const launcher = join(import.meta.dir, "../scripts/opencode-isolated.ps1")
function fixture() {
  const root = tempDir("original-profile"), configHome = join(root, "config"), config = join(configHome, "opencode")
  mkdirSync(config, { recursive: true })
  const settings = join(config, "opencode.json"), original = '{"providers":{"fixture":{"model":"existing-choice"}}}'
  writeFileSync(settings, original)
  const lock = join(root, "jlock.exe"), command = join(root, "opencode.ps1"), unused = join(root, "unused-private-profile")
  writeFileSync(lock, "fixture-only")
  writeFileSync(command, `param([Parameter(ValueFromRemainingArguments)][string[]]$Rest)
[ordered]@{ args=@($Rest); config=$env:XDG_CONFIG_HOME; data=$env:XDG_DATA_HOME; state=$env:XDG_STATE_HOME; override=$env:OPENCODE_CONFIG_CONTENT; jlock=$env:JLOCK_BIN } | ConvertTo-Json -Compress
exit 17
`)
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(root, "original-data"), XDG_STATE_HOME: join(root, "original-state"), OPENCODE_CONFIG_DIR: "", OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "", OPENCODE_CLI_CONFIG_CONTENT: "" }
  const args = [shell, "-NoProfile", "-File", launcher, "-OpenCodeCommand", command, "-SourceConfigDir", config, "-ProfileConfigDir", unused, "-JlockBin", lock]
  return { env, args, settings, original, unused, lock }
}
windows("launcher keeps the original provider settings, native roots, history and service", () => {
  const f = fixture()
  const result = Bun.spawnSync([...f.args, "--version"], { env: f.env })
  expect(result.exitCode).toBe(17)
  const child = JSON.parse(result.stdout.toString())
  expect(child.args).toEqual(["--version"])
  expect(child.config).toBe(f.env.XDG_CONFIG_HOME)
  expect(child.data).toBe(f.env.XDG_DATA_HOME)
  expect(child.state).toBe(f.env.XDG_STATE_HOME)
  expect(child.override).toBeFalsy()
  expect(child.jlock).toBe(f.lock)
  expect(readFileSync(f.settings, "utf8")).toBe(f.original)
  expect(existsSync(f.unused)).toBe(false)
})
windows("preflight is read-only and does not launch OpenCode or create a second profile", () => {
  const f = fixture()
  const result = Bun.spawnSync([...f.args, "-Check"], { env: f.env })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ profile: "original", privateServer: false, privateHistory: false, changesConfiguration: false })
  expect(readFileSync(f.settings, "utf8")).toBe(f.original)
  expect(existsSync(f.unused)).toBe(false)
})
windows("separate server and configuration overrides are refused before opening anything", () => {
  const f = fixture()
  for (const arg of ["--standalone", "--server=http://fixture.invalid"]) expect(Bun.spawnSync([...f.args, arg], { env: f.env }).exitCode).toBe(1)
  expect(Bun.spawnSync(f.args, { env: { ...f.env, OPENCODE_CONFIG_CONTENT: "{}" } }).exitCode).toBe(1)
  expect(readFileSync(f.settings, "utf8")).toBe(f.original)
  expect(existsSync(f.unused)).toBe(false)
})
