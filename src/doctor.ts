// `jtasks doctor` (plan section 22): is this machine ready for jtasks? Eight checks, in the model of
// `jlock doctor`, each with what to do when it is not ok. It only reads (a temporary file in JTASKS_HOME, removed
// even on failure). `jtasks doctor --fix` lists what it would install; `--fix --yes` installs it: jlock through its
// official installer, the OpenCode agents and the skills of the three agents, each file recorded in the global
// ledger so `jtasks undo <g-id>` removes it (every command also installs a missing jlock by itself: setup.ts). It never overwrites a file that differs, never touches PATH, and never
// installs the mod or the plugin. The `data` check says where run data goes for the current folder, and `--fix` asks
// for the data folder (`--data-dir <path>`, or a question on a terminal) and saves it in JTASKS_HOME/config.json.

import { choose, systemLocale, tr } from "./i18n.ts"
import type { Host } from "./host.ts"
import { EOF_JLOCK, jlockBin, jlockEnv, MIN_JLOCK, RENEW_JLOCK, versionAtLeast } from "./jlock.ts"
import { git } from "./git.ts"
import { globalLedger, readEffects, recordGlobalEffect } from "./ledger.ts"
import { dirname, join } from "./paths.ts"
import { installJlock as installJlockWith, jlockInstallPath, userHome } from "./setup.ts"
import { jtasksHome } from "./store.ts"
import { defineAction, ok, ToolError, VERSION, type ParsedArgs, type ToolContext, type ToolResult } from "./tool.ts"
import { configFile, containerWithoutGit, readConfig, resolvePaths, writeConfig, type DataSource } from "./workspace.ts"

export type CheckStatus = "ok" | "warn" | "fail"

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  fix?: string
  /** `doctor --fix --yes` can install what this check misses. */
  fixable?: boolean
}

export const OPENCODE_AGENTS = ["execute", "execute-deep", "review"]
export const SKILLS = ["to-jtasks", "jtasks"]
export const SKILL_FILES: Record<string, string[]> = { "to-jtasks": ["SKILL.md", "schema.json", "example-plan.json"], "jtasks": ["SKILL.md"] }

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
  return { name: "version", status: "ok", detail: `jtasks ${VERSION}${runtime}` }
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
  const oldForRenew = !versionAtLeast(version, RENEW_JLOCK)
  const parts = [tr("doctor.jlock_ok", { version, n: checks.length - bad.length, total: checks.length })]
  for (const c of bad) parts.push(`${c.status} ${c.name}: ${c.detail}`)
  if (oldForEof) parts.push(tr("doctor.jlock_no_eof", { minimum: EOF_JLOCK }))
  if (oldForRenew) parts.push(tr("doctor.jlock_no_renew", { minimum: RENEW_JLOCK }))
  const fixes = bad.map((c) => c.fix).filter((f): f is string => !!f)
  if (oldForRenew) fixes.push("jlock update")
  const status: CheckStatus = failed ? "fail" : bad.length || oldForRenew ? "warn" : "ok"
  return status === "ok" ? { name: "jlock", status, detail: parts.join("; ") } : { name: "jlock", status, detail: parts.join("; "), fix: fixes.join("; ") || "jlock doctor" }
}

async function checkHome(host: Host): Promise<Check> {
  const home = jtasksHome(host)
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

/** Where run data goes for the current folder, and the saved setting (`jtasks config data-dir`). */
async function checkData(ctx: ToolContext): Promise<Check> {
  const { host } = ctx
  const saved = (await readConfig(host)).dataDir
  const setting = saved ? tr("doctor.data_saved", { value: saved }) : tr("doctor.data_unset")
  const paths = await resolvePaths(host, ctx.cwd).catch(() => undefined)
  // A jproject container without its own git repository: no run data until product/ is one (a condition, not a warning).
  const bare = paths ? undefined : await containerWithoutGit(host, ctx.cwd).catch(() => undefined)
  if (bare) return { name: "data", status: "fail", detail: tr("doctor.container_no_git", { product: bare.product }), fix: tr("doctor.container_git_fix", { product: bare.product }) }
  const where = paths ? tr("doctor.data_here", { dir: paths.dataDir, source: sourceText(paths.source) }) : tr("doctor.data_no_repo")
  const fix = saved ? undefined : tr("doctor.data_fix")
  // A jproject container whose run data would land inside product/: what the container is meant to avoid.
  if (paths?.container && paths.inRepo !== undefined)
    return { name: "data", status: "warn", detail: `${where}; ${tr("doctor.data_in_repo")}; ${setting}`, fix: tr("doctor.data_fix") }
  return fix ? { name: "data", status: "ok", detail: `${where}; ${setting}`, fix } : { name: "data", status: "ok", detail: `${where}; ${setting}` }
}

/** Which rule chose the data folder, in words. */
export function sourceText(source: DataSource): string {
  return tr(`data.source.${source}`)
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
  const plugin = /jtasks/.test(configText) ? tr("doctor.opencode_plugin_listed") : tr("doctor.opencode_plugin_absent")
  if (missing.length)
    return { name: "opencode", status: "warn", detail: tr("doctor.opencode_agents_missing", { agents: missing.join(", "), plugin }), fix: "jtasks doctor --fix --yes" }
  return { name: "opencode", status: "ok", detail: tr("doctor.opencode_ok", { plugin }) }
}

async function checkClaude(host: Host): Promise<Check> {
  const r = await host.run(["claude", "--version"], { timeoutMs: 20_000 })
  if (r.code !== 0) return { name: "claude", status: "ok", detail: tr("doctor.claude_absent") }
  const mod = (await claudeModInstalled(host)) ? tr("doctor.claude_mod_installed") : tr("doctor.claude_mod_absent")
  return { name: "claude", status: "ok", detail: `${r.stdout.trim().split("\n")[0]}; ${mod}` }
}

/** Whether the Claude Code mod is installed (the plugin brings the skills as jtasks:jtasks and jtasks:to-jtasks). */
async function claudeModInstalled(host: Host): Promise<boolean> {
  return /jtasks/.test((await host.readText(join(userHome(host), ".claude/plugins/installed_plugins.json"))) ?? "")
}

async function missingSkills(host: Host): Promise<{ host: string; skill: string; dir: string }[]> {
  const out: { host: string; skill: string; dir: string }[] = []
  // With the mod, Claude Code has the skills already; a copy in ~/.claude/skills would also take /jtasks from the mod.
  const mod = await claudeModInstalled(host)
  for (const h of skillHosts(host)) {
    if (!(await isDir(host, h.present)) || (mod && h.host === "claude-code")) continue
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
    return { name: "skills", status: "warn", detail: tr("doctor.skills_missing", { list: missing.map((m) => `${m.host}/${m.skill}`).join(", ") }), fix: "jtasks doctor --fix --yes" }
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
    await checkData(ctx),
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
  /** The step that saves the data folder. */
  data?: boolean
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

/**
 * `git init` in a container's product folder, only after a yes on the terminal: it is never done silently. Recorded
 * in the global ledger, so `jtasks undo` removes the `.git` folder it created.
 */
async function gitInitProduct(ctx: ToolContext, product: string): Promise<string> {
  const { host } = ctx
  const answer = ctx.ask ? (await ctx.ask(`${tr("doctor.container_git_question", { product })}\n> `).catch(() => undefined))?.trim().toLowerCase() : undefined
  if (answer !== "y" && answer !== "yes") return tr("doctor.git_init_skipped", { product })
  const r = await git(host, product, ["init", "-q"]).catch((error: Error) => ({ code: 1, stdout: "", stderr: error.message }))
  if (r.code !== 0) throw new ToolError(tr("doctor.git_init_failed", { product, message: r.stderr.trim() }))
  const e = await recordGlobalEffect(host, { run: "doctor", type: "dir", repo: product, path: join(product, ".git"), undo: { kind: "rmdir" } })
  return tr("doctor.git_init_done", { product, id: e.id })
}

async function fixSteps(ctx: ToolContext, checks: Check[], args: ParsedArgs): Promise<FixStep[]> {
  const { host } = ctx
  const pkg = ctx.packageRoot!
  const steps: FixStep[] = []
  const jlock = checks.find((c) => c.name === "jlock")
  if (jlock?.fixable)
    steps.push({ what: tr("doctor.step_jlock"), run: () => installJlock(ctx) })
  const bare = await containerWithoutGit(host, ctx.cwd).catch(() => undefined)
  if (bare) steps.push({ what: tr("doctor.step_git_init", { product: bare.product }), run: () => gitInitProduct(ctx, bare.product) })
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
  const value = await dataDirAnswer(ctx, args)
  if (value)
    steps.push({
      what: tr("doctor.step_data", { value, file: configFile(host) }),
      data: true,
      run: async () => {
        await writeConfig(host, { dataDir: value })
        return tr("config.saved", { value, file: configFile(host) })
      },
    })
  return steps
}

/**
 * The data folder `--fix` saves: `--data-dir <path>`, or, with `--yes`, none saved yet and the CLI on a terminal, the
 * answer to the question (empty: nothing saved). Never asks without a terminal: the doctor stays scriptable.
 */
async function dataDirAnswer(ctx: ToolContext, args: ParsedArgs): Promise<string | undefined> {
  const given = typeof args.options["data-dir"] === "string" ? args.options["data-dir"].trim() : undefined
  if (given) return given
  if (!args.options.yes || !ctx.ask || (await readConfig(ctx.host)).dataDir) return undefined
  const answer = (await ctx.ask(`${tr("config.question")}\n> `).catch(() => undefined))?.trim()
  return answer || undefined
}

/** jlock through its official installer (setup.ts), recorded in the global ledger. */
async function installJlock(ctx: ToolContext): Promise<string> {
  const done = await installJlockWith(ctx.host, "doctor").catch((error: Error) => {
    throw new ToolError(error.message)
  })
  return done.path ? tr("doctor.jlock_installed", { file: done.path, id: done.effect ?? "-" }) : tr("doctor.jlock_installed_somewhere")
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
  const steps = await fixSteps(ctx, checks, args)
  // No answer about the data folder and none saved: the question, so the person knows it can be set.
  const question = !(await readConfig(ctx.host)).dataDir && !steps.some((s) => s.data) ? `\n\n${tr("config.question")}\n${tr("doctor.data_fix")}` : ""
  if (!steps.length) return ok(`${text}\n\n${tr("doctor.nothing_to_fix")}${question}`, { ...data, fixed: [] })
  if (!args.options.yes) return ok(`${[text, "", tr("doctor.would"), ...steps.map((s) => `  ${s.what}`), tr("doctor.confirm")].join("\n")}${question}`, { ...data, planned: steps.map((s) => s.what) })
  const done: string[] = []
  for (const s of steps) done.push(await s.run())
  const after = await runChecks(ctx, lang)
  return ok([tr("doctor.fixed"), ...done.map((d) => `  ${d}`), "", checksText(after)].join("\n"), { ...data, fixed: done, after })
}

defineAction("doctor", doctor, "help.doctor")

// `jtasks config`: the settings in JTASKS_HOME/config.json. Today one: where run data goes (`data-dir`).
defineAction(
  "config",
  async (ctx, args) => {
    const { host } = ctx
    const [key, value] = args.positionals
    const file = configFile(host)
    if (key === undefined) {
      const saved = (await readConfig(host)).dataDir
      const paths = await resolvePaths(host, ctx.cwd).catch(() => undefined)
      const bare = paths ? undefined : await containerWithoutGit(host, ctx.cwd).catch(() => undefined)
      const lines = [
        saved ? tr("config.show", { value: saved, file }) : tr("config.none", { file }),
        paths ? tr("doctor.data_here", { dir: paths.dataDir, source: sourceText(paths.source) }) : bare ? tr("doctor.container_no_git", { product: bare.product }) : tr("doctor.data_no_repo"),
      ]
      if (bare) lines.push(tr("doctor.container_git_fix", { product: bare.product }))
      if (!saved) lines.push("", tr("config.question"), tr("doctor.data_fix"))
      return ok(lines.join("\n"), { file, dataDir: saved ?? null, resolved: paths ?? null })
    }
    if (key !== "data-dir") throw new ToolError(tr("config.usage"), 2)
    if (args.options.unset) {
      await writeConfig(host, { dataDir: undefined })
      return ok(tr("config.removed", { file }), { file, dataDir: null })
    }
    if (!value?.trim()) throw new ToolError(tr("config.usage"), 2)
    await writeConfig(host, { dataDir: value.trim() })
    const paths = await resolvePaths(host, ctx.cwd).catch(() => undefined)
    const here = paths ? `\n${tr("doctor.data_here", { dir: paths.dataDir, source: sourceText(paths.source) })}` : ""
    return ok(`${tr("config.saved", { value: value.trim(), file })}${here}`, { file, dataDir: value.trim(), resolved: paths ?? null })
  },
  "help.config",
)
