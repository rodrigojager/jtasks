// jlock comes with jtasks: the first command that may need it, in any form (CLI, mod, plugin), installs it through
// its official installer when it is missing, records the binary in the global ledger (`jtasks undo <g-id>` removes
// it) and uses it at once, since a running process does not see the PATH the installer changed. Once per process.
// JLOCK_BIN (a jlock of the user's choice) or JTASKS_NO_JLOCK_INSTALL=1 turns it off. `jtasks doctor --fix` uses the
// same installer.

import type { Host } from "./host.ts"
import { lang, tr } from "./i18n.ts"
import { recordGlobalEffect } from "./ledger.ts"
import { dirname, join } from "./paths.ts"

const INSTALLERS = "https://raw.githubusercontent.com/rodrigojager/jlock/main"

/** Where the doctor looks for and installs agents and skills: JTASKS_USER_HOME, else the user's home. */
export function userHome(host: Host): string {
  return (host.env("JTASKS_USER_HOME") || host.env("USERPROFILE") || host.env("HOME") || ".").replace(/\\/g, "/")
}

/** Where jlock's installer puts the binary by default (JLOCK_INSTALL_DIR wins, as in the installer). */
export function jlockInstallPath(host: Host): string | undefined {
  const dir = host.env("JLOCK_INSTALL_DIR")
  const exe = host.platform === "win32" ? "jlock.exe" : "jlock"
  if (dir) return join(dir.replace(/\\/g, "/"), exe)
  if (host.platform === "win32") {
    const local = host.env("LOCALAPPDATA")
    return local ? join(local.replace(/\\/g, "/"), "Programs/jlock", exe) : undefined
  }
  return join(userHome(host), ".local/bin", exe)
}

/** The one line that installs jlock by hand on this platform. */
export function jlockInstallCommand(host: Host): string {
  return host.platform === "win32" ? `irm ${INSTALLERS}/install.ps1 | iex` : `curl -fsSL ${INSTALLERS}/install.sh | sh`
}

/**
 * Runs jlock's official installer (or JTASKS_JLOCK_INSTALLER, a script run with bun, for the tests) and records the
 * binary in the global ledger. Throws with the installer's own message when it fails.
 */
export async function installJlock(host: Host, by: string): Promise<{ path?: string; effect?: string }> {
  const own = host.env("JTASKS_JLOCK_INSTALLER")
  const argv = own
    ? ["bun", own]
    : host.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", jlockInstallCommand(host)]
      : ["sh", "-c", jlockInstallCommand(host)]
  const dir = host.env("JLOCK_INSTALL_DIR")
  const r = await host.run(argv, dir ? { timeoutMs: 5 * 60_000, env: { JLOCK_INSTALL_DIR: dir } } : { timeoutMs: 5 * 60_000 })
  if (r.code !== 0) throw new Error(tr("doctor.jlock_install_failed", { code: r.code, message: (r.stderr || r.stdout).trim().slice(0, 400) }))
  const path = jlockInstallPath(host)
  if (!path || (await host.stat(path))?.kind !== "file") return {}
  const e = await recordGlobalEffect(host, { run: by, type: "install", repo: dirname(path), path, undo: { kind: "remove-file" } })
  return { path, effect: e.id }
}

export interface JlockSetup {
  /** `present`: in PATH; `found`: where the installer puts it; `installed` now; `failed`; `off`: not ours to do. */
  status: "present" | "found" | "installed" | "failed" | "off"
  path?: string
  /** What the user should read once: the install, or why it failed and how to do it by hand. */
  notice?: string
}

let setup: Promise<JlockSetup> | undefined
let resolved: string | undefined
let shown = false

/** The jlock this process found or installed outside PATH, if any (jlockBin uses it). */
export function installedJlock(): string | undefined {
  return resolved
}

async function answers(host: Host, bin: string): Promise<boolean> {
  const r = await host.run([bin, "--version"], { timeoutMs: 15_000, env: { JLOCK_LANG: lang() } }).catch(() => undefined)
  return !!r && r.code === 0 && /\d+\.\d+\.\d+/.test(`${r.stdout}\n${r.stderr}`)
}

/** Makes sure this process has a jlock to call, installing it when it is missing (once per process). */
export function ensureJlock(host: Host): Promise<JlockSetup> {
  setup ??= (async (): Promise<JlockSetup> => {
    if (host.env("JLOCK_BIN") || host.env("JTASKS_NO_JLOCK_INSTALL") === "1") return { status: "off" }
    if (await answers(host, "jlock")) return { status: "present" }
    const path = jlockInstallPath(host)
    if (path && (await answers(host, path))) {
      resolved = path
      return { status: "found", path }
    }
    try {
      const done = await installJlock(host, "setup")
      if (!done.path || !(await answers(host, done.path))) throw new Error(tr("setup.jlock_not_found_after"))
      resolved = done.path
      return { status: "installed", path: done.path, notice: tr("setup.jlock_installed", { file: done.path, id: done.effect ?? "-" }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: "failed", notice: tr("setup.jlock_failed", { message, command: jlockInstallCommand(host) }) }
    }
  })()
  return setup
}

/** The setup's notice, the first time it is asked for; nothing after that. */
export async function jlockNotice(host: Host): Promise<string | undefined> {
  const s = await ensureJlock(host)
  if (!s.notice || shown) return undefined
  shown = true
  return s.notice
}

/** Forgets what this process found (the tests, between scenes). */
export function resetJlockSetup(): void {
  setup = undefined
  resolved = undefined
  shown = false
}
