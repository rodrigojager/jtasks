// `tasks doctor` (plan section 22): is this machine ready for goal-tasks? Eight checks, in the model of
// `jlock doctor`, each with what to do when it is not ok. It only reads (a temporary file in GOAL_TASKS_HOME, removed
// even on failure). `tasks doctor --fix` lists what it would install; `--fix --yes` installs it: jlock through its
// official installer, the OpenCode agents and the skills of the three agents, each file recorded in the global
// ledger so `tasks undo <g-id>` removes it. It never overwrites a file that differs, never touches PATH, and never
// installs the mod or the plugin.

import { choose, systemLocale, tr } from "./i18n.ts"
import type { Host } from "./host.ts"
import { EOF_JLOCK, jlockBin, jlockEnv, MIN_JLOCK, versionAtLeast } from "./jlock.ts"
import { globalLedger, readEffects, recordGlobalEffect } from "./ledger.ts"
import { dirname, join } from "./paths.ts"
import { goalTasksHome } from "./store.ts"
import { defineAction, ok, ToolError, VERSION, type ParsedArgs, type ToolContext, type ToolResult } from "./tool.ts"

export type CheckStatus = "ok" | "warn" | "fail"

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  fix?: string
  /** `doctor --fix --yes` can install what this check misses. */
  fixable?: boolean
}

export const OPENCODE_AGENTS = ["implement", "implement-deep", "review"]
export const SKILLS = ["to-tickets", "goal-tasks"]
export const SKILL_FILES: Record<string, string[]> = { "to-tickets": ["SKILL.md", "schema.json", "example-plan.json"], "goal-tasks": ["SKILL.md"] }

/** Where the doctor looks for and installs agents and skills: GOAL_TASKS_USER_HOME, else the user's home. */
export function userHome(host: Host): string {
  return (host.env("GOAL_TASKS_USER_HOME") || host.env("USERPROFILE") || host.env("HOME") || ".").replace(/\\/g, "/")
}

/** The three agents, where each keeps its skills, and the folder whose presence says the agent is installed. */
export function skillHosts(host: Host): { host: string; present: string; dir: string }[] {
  const home = userHome(host)
  return [
    { host: "claude-code", present: join(home, ".claude"), dir: join(home, ".claude/skills") },
    { host: "opencode", present: join(home, ".config/opencode"), dir: join(home, ".config/opencode/skills") },
    { host: "codex", present: join(home, ".codex"), dir: join(home, ".agents/skills") },
  ]
}

const isDir = async (host: Host, path: string) => (await host.stat(path))?.kind === "dir"
const isFile = async (host: Host, path: string) => (await host.stat(path))?.kind === "file"

async function checkVersion(host: Host): Promise<Check> {
  const runtime = host.runtime ? ` · ${host.runtime}` : ""
  return { name: "version", status: "ok", detail: `goal-tasks ${VERSION}${runtime}` }
}

async function checkGit(host: Host): Promise<Check> {
  const r = await host.run(["git", "--version"], { timeoutMs: 15_000 })
  if (r.code !== 0) return { name: "git", status: "fail", detail: tr("doctor.git_missing"), fix: tr("doctor.git_fix") }
  return { name: "git", status: "ok", detail: r.stdout.trim() }
}

interface JlockDoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  fix?: string | null
}

/** The installed jlock: its version, and its own doctor (`jlock doctor --json`), summed up. */
export async function checkJlock(host: Host): Promise<Check> {
  const bin = jlockBin(host)
  const r = await host.run([bin, "--version"], { timeoutMs: 15_000, env: jlockEnv() })
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout)
  if (r.code !== 0 || !m) return { name: "jlock", status: "fail", detail: tr("doctor.jlock_missing", { bin }), fix: tr("doctor.jlock_install_fix"), fixable: true }
  const version = `${m[1]}.${m[2]}.${m[3]}`
  if (!versionAtLeast(version, MIN_JLOCK))
    return { name: "jlock", status: "fail", detail: tr("doctor.jlock_old", { version, minimum: MIN_JLOCK }), fix: "jlock update" }
  const d = await host.run([bin, "doctor", "--json"], { timeoutMs: 30_000, env: jlockEnv() })
  let checks: JlockDoctorCheck[] = []
  try {
    checks = (JSON.parse(d.stdout) as { checks?: JlockDoctorCheck[] }).checks ?? []
  } catch {
    return { name: "jlock", status: "warn", detail: tr("doctor.jlock_doctor_unreadable", { version }), fix: "jlock doctor" }
  }
  const bad = checks.filter((c) => c.status !== "ok")
  const failed = bad.some((c) => c.status === "fail")
  const oldForEof = !versionAtLeast(version, EOF_JLOCK)
  const parts = [tr("doctor.jlock_ok", { version, n: checks.length - bad.length, total: checks.length })]
  for (const c of bad) parts.push(`${c.status} ${c.name}: ${c.detail}`)
  if (oldForEof) parts.push(tr("doctor.jlock_no_eof", { minimum: EOF_JLOCK }))
  const fixes = bad.map((c) => c.fix).filter((f): f is string => !!f)
  if (oldForEof) fixes.push("jlock update")
  const status: CheckStatus = failed ? "fail" : bad.length || oldForEof ? "warn" : "ok"
  return status === "ok" ? { name: "jlock", status, detail: parts.join("; ") } : { name: "jlock", status, detail: parts.join("; "), fix: fixes.join("; ") || "jlock doctor" }
}

async function checkHome(host: Host): Promise<Check> {
  const home = goalTasksHome(host)
  const stat = await host.stat(home)
  if (!stat) return { name: "home", status: "ok", detail: tr("doctor.home_absent", { home }) }
  if (stat.kind !== "dir") return { name: "home", status: "fail", detail: tr("doctor.home_not_dir", { home }), fix: tr("doctor.home_fix") }
  const probe = join(home, `.doctor-${host.now().getTime().toString(36)}-${Math.floor(host.random() * 1e6).toString(36)}.tmp`)
  try {
    await host.writeText(probe, "doctor\n")
  } catch (error) {
    return { name: "home", status: "fail", detail: tr("doctor.home_not_writable", { home, message: (error as Error).message }), fix: tr("doctor.home_fix") }
  } finally {
    await host.remove(probe).catch(() => {})
  }
  const effects = await readEffects(host, globalLedger(host))
  return { name: "home", status: "ok", detail: tr("doctor.home_ok", { home, n: effects.length }) }
}

/** The OpenCode agents of the default profiles: in the user's agents folder, the project's, or opencode.json. */
async function checkOpenCode(host: Host, cwd: string): Promise<Check> {
  const config = join(userHome(host), ".config/opencode")
  if (!(await isDir(host, config))) return { name: "opencode", status: "ok", detail: tr("doctor.opencode_absent") }
  const configText = [
    (await host.readText(join(config, "opencode.json"))) ?? "",
    (await host.readText(join(config, "opencode.jsonc"))) ?? "",
  ].join("\n")
  const missing: string[] = []
  for (const agent of OPENCODE_AGENTS) {
    const found =
      (await isFile(host, join(config, "agents", `${agent}.md`))) ||
      (await isFile(host, join(cwd, ".opencode/agents", `${agent}.md`))) ||
      new RegExp(`"${agent}"\\s*:`).test(configText)
    if (!found) missing.push(agent)
  }
  const plugin = /goal-tasks/.test(configText) ? tr("doctor.opencode_plugin_listed") : tr("doctor.opencode_plugin_absent")
  if (missing.length)
    return { name: "opencode", status: "warn", detail: tr("doctor.opencode_agents_missing", { agents: missing.join(", "), plugin }), fix: "tasks doctor --fix --yes" }
  return { name: "opencode", status: "ok", detail: tr("doctor.opencode_ok", { plugin }) }
}

async function checkClaude(host: Host): Promise<Check> {
  const r = await host.run(["claude", "--version"], { timeoutMs: 20_000 })
  if (r.code !== 0) return { name: "claude", status: "ok", detail: tr("doctor.claude_absent") }
  const plugins = (await host.readText(join(userHome(host), ".claude/plugins/installed_plugins.json"))) ?? ""
  const mod = /goal-tasks/.test(plugins) ? tr("doctor.claude_mod_installed") : tr("doctor.claude_mod_absent")
  return { name: "claude", status: "ok", detail: `${r.stdout.trim().split("\n")[0]}; ${mod}` }
}

async function missingSkills(host: Host): Promise<{ host: string; skill: string; dir: string }[]> {
  const out: { host: string; skill: string; dir: string }[] = []
  for (const h of skillHosts(host)) {
    if (!(await isDir(host, h.present))) continue
    for (const skill of SKILLS) if (!(await isFile(host, join(h.dir, skill, "SKILL.md")))) out.push({ host: h.host, skill, dir: join(h.dir, skill) })
  }
  return out
}

async function checkSkills(host: Host): Promise<Check> {
  const present = []
  for (const h of skillHosts(host)) if (await isDir(host, h.present)) present.push(h.host)
  if (!present.length) return { name: "skills", status: "ok", detail: tr("doctor.skills_no_agents") }
  const missing = await missingSkills(host)
  if (missing.length)
    return { name: "skills", status: "warn", detail: tr("doctor.skills_missing", { list: missing.map((m) => `${m.host}/${m.skill}`).join(", ") }), fix: "tasks doctor --fix --yes" }
  return { name: "skills", status: "ok", detail: tr("doctor.skills_ok", { agents: present.join(", ") }) }
}

function checkLanguage(host: Host, lang: string | undefined): Check {
  const choice = choose({ lang, env: (name) => host.env(name), system: systemLocale() })
  return { name: "language", status: "ok", detail: `${choice.tag} (${choice.source})` }
}

export async function runChecks(ctx: ToolContext, lang: string | undefined): Promise<Check[]> {
  const { host } = ctx
  return [
    await checkVersion(host),
    await checkGit(host),
    await checkJlock(host),
    await checkHome(host),
    await checkOpenCode(host, ctx.cwd),
    await checkClaude(host),
    await checkSkills(host),
    checkLanguage(host, lang),
  ]
}

export function checksText(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length))
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${c.status.padEnd(5)} ${c.name.padEnd(width)}  ${c.detail}`)
    if (c.fix) lines.push(`${" ".repeat(width + 8)}${tr("doctor.fix", { fix: c.fix })}`)
  }
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length
  lines.push("", tr("doctor.summary", { ok: n("ok"), warn: n("warn"), fail: n("fail") }))
  return lines.join("\n")
}

// ── --fix ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface FixStep {
  /** One line for the list. */
  what: string
  run: () => Promise<string>
}

/** Copies one file of the package to `to`, recording it in the global ledger; an existing file is never replaced. */
async function installFile(host: Host, from: string, to: string): Promise<string> {
  const text = await host.readText(from)
  if (text === undefined) throw new ToolError(tr("doctor.package_missing", { file: from }))
  const current = await host.readText(to)
  if (current !== undefined) return current === text ? tr("doctor.file_same", { file: to }) : tr("doctor.file_differs", { file: to })
  await host.writeText(to, text)
  const e = await recordGlobalEffect(host, { run: "doctor", type: "install", repo: dirname(to), path: to, undo: { kind: "remove-file" } })
  return tr("doctor.file_installed", { file: to, id: e.id })
}

async function fixSteps(ctx: ToolContext, checks: Check[]): Promise<FixStep[]> {
  const { host } = ctx
  const pkg = ctx.packageRoot!
  const steps: FixStep[] = []
  const jlock = checks.find((c) => c.name === "jlock")
  if (jlock?.fixable)
    steps.push({ what: tr("doctor.step_jlock"), run: () => installJlock(ctx) })
  const opencode = join(userHome(host), ".config/opencode")
  if (checks.find((c) => c.name === "opencode")?.status === "warn")
    for (const agent of OPENCODE_AGENTS) {
      const to = join(opencode, "agents", `${agent}.md`)
      if (!(await isFile(host, to))) steps.push({ what: tr("doctor.step_copy", { file: to }), run: () => installFile(host, join(pkg, "opencode/agents", `${agent}.md`), to) })
    }
  for (const m of await missingSkills(host))
    for (const name of SKILL_FILES[m.skill] ?? ["SKILL.md"]) {
      const to = join(m.dir, name)
      steps.push({ what: tr("doctor.step_copy", { file: to }), run: () => installFile(host, join(pkg, "skills", m.host, m.skill, name), to) })
    }
  return steps
}

/** jlock through its official installer (or GOAL_TASKS_JLOCK_INSTALLER, a script run with bun, for the tests). */
async function installJlock(ctx: ToolContext): Promise<string> {
  const { host } = ctx
  const own = host.env("GOAL_TASKS_JLOCK_INSTALLER")
  const base = "https://raw.githubusercontent.com/rodrigojager/jlock/main"
  const argv = own
    ? ["bun", own]
    : host.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${base}/install.ps1 | iex`]
      : ["sh", "-c", `curl -fsSL ${base}/install.sh | sh`]
  const dir = host.env("JLOCK_INSTALL_DIR")
  const r = await host.run(argv, dir ? { timeoutMs: 5 * 60_000, env: { JLOCK_INSTALL_DIR: dir } } : { timeoutMs: 5 * 60_000 })
  if (r.code !== 0) throw new ToolError(tr("doctor.jlock_install_failed", { code: r.code, message: (r.stderr || r.stdout).trim().slice(0, 400) }))
  const installed = jlockInstallPath(host)
  if (installed && (await isFile(host, installed))) {
    const e = await recordGlobalEffect(host, { run: "doctor", type: "install", repo: dirname(installed), path: installed, undo: { kind: "remove-file" } })
    return tr("doctor.jlock_installed", { file: installed, id: e.id })
  }
  return tr("doctor.jlock_installed_somewhere")
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

async function doctor(ctx: ToolContext, args: ParsedArgs): Promise<ToolResult> {
  const lang = typeof args.options.lang === "string" ? args.options.lang : ctx.lang
  const checks = await runChecks(ctx, lang)
  const summary = { ok: 0, warn: 0, fail: 0 }
  for (const c of checks) summary[c.status]++
  const data = { result: summary.fail ? "error" : "ok", checks, summary }
  const text = checksText(checks)
  if (!args.options.fix) return { ok: summary.fail === 0, code: summary.fail ? 20 : 0, text, data }
  if (ctx.tool !== "cli" || !ctx.packageRoot) throw new ToolError(tr("doctor.fix_cli_only"))
  const steps = await fixSteps(ctx, checks)
  if (!steps.length) return ok(`${text}\n\n${tr("doctor.nothing_to_fix")}`, { ...data, fixed: [] })
  if (!args.options.yes) return ok([text, "", tr("doctor.would"), ...steps.map((s) => `  ${s.what}`), tr("doctor.confirm")].join("\n"), { ...data, planned: steps.map((s) => s.what) })
  const done: string[] = []
  for (const s of steps) done.push(await s.run())
  const after = await runChecks(ctx, lang)
  return ok([tr("doctor.fixed"), ...done.map((d) => `  ${d}`), "", checksText(after)].join("\n"), { ...data, fixed: done, after })
}

defineAction("doctor", doctor, "help.doctor")
