// Where a run's data lives and which repository it belongs to: the one place that answers it, for the core, the
// CLI, the Claude Code mod and the OpenCode plugin. The agent may be opened in the repository itself or in a
// "jproject container": a folder that is not a git repository, with `<work_dir>/WORKSPACE.md` whose YAML front
// matter says `jproject: 1`, and the repository in `<container>/<product_dir>`. There the run data goes to the
// container's `jtasks_data` folder and nothing is written inside the repository.
//
// The data folder, first that applies:
//   1. JTASKS_SCRATCH: absolute, or relative to the container (the repository when there is none);
//   2. `dataDir` in JTASKS_HOME/config.json (`jtasks config data-dir`, asked by `jtasks doctor`): absolute, or
//      relative to the container (a relative value is ignored outside a container);
//   3. `jtasks_data` from the container's front matter (relative to the container, or absolute);
//   4. the legacy `<repo>/.scratch/jtasks`.

import { git } from "./git.ts"
import type { Host } from "./host.ts"
import { caseInsensitive, dirname, isAbsolute, join, normalize, relativeInside, slash } from "./paths.ts"
import { jtasksHome } from "./store.ts"
import { ToolError } from "./tool.ts"
import { tr } from "./i18n.ts"

/** The legacy data folder, relative to the repository root. */
export const LEGACY_DATA = ".scratch/jtasks"
/** The data folder of a jproject container when its front matter does not name one, relative to the container. */
export const DEFAULT_CONTAINER_DATA = "_work/30-plan/jtasks"
const DEFAULT_WORK_DIR = "_work"
const DEFAULT_PRODUCT_DIR = "product"

export interface Container {
  /** The container folder (not a git repository). */
  root: string
  /** `<root>/<product_dir>`: where the repository is. */
  product: string
  /** `<root>/<work_dir>`. */
  work: string
  secrets?: string
  /** `jtasks_data` resolved against the container, when the front matter has it. */
  jtasksData?: string
  /** The `WORKSPACE.md` that made it a container. */
  workspace: string
}

export type DataSource = "env" | "config" | "workspace" | "legacy"

export interface RepoPaths {
  /** The git repository's root. */
  repoRoot: string
  /** The folder that holds `runs/<run>/` (run.json, tasks.json, tickets, ledger, log). */
  dataDir: string
  /** Which rule chose `dataDir`. */
  source: DataSource
  /** The jproject container around the repository, when there is one. */
  container?: Container
  /** `dataDir` relative to the repository when it lies inside it (the legacy mode), else undefined. */
  inRepo?: string
  /**
   * `dataDir` is an absolute folder that does not depend on the project (JTASKS_SCRATCH or the config): several
   * repositories may share it, so the runs listed are only the repository's own.
   */
  shared: boolean
}

export interface JtasksConfig {
  /** Where run data goes: absolute, or relative to the project container. */
  dataDir?: string
}

/** `JTASKS_HOME/config.json`, the settings `jtasks config` and `jtasks doctor` save. */
export function configFile(host: Host): string {
  return join(jtasksHome(host), "config.json")
}

export async function readConfig(host: Host): Promise<JtasksConfig> {
  const text = await host.readText(configFile(host)).catch(() => undefined)
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === "object" ? (value as JtasksConfig) : {}
  } catch {
    return {}
  }
}

/** Writes the config with `change` applied (an `undefined` value removes the key). */
export async function writeConfig(host: Host, change: Partial<JtasksConfig>): Promise<JtasksConfig> {
  const next: Record<string, unknown> = { ...(await readConfig(host)) }
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined || value === "") delete next[key]
    else next[key] = value
  }
  await host.writeText(configFile(host), `${JSON.stringify(next, null, 2)}\n`)
  return next as JtasksConfig
}

/** The `key: value` lines of a YAML front matter (`---` … `---` at the top), or undefined without one. */
export function parseFrontMatter(text: string): Record<string, string> | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return undefined
  const out: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "---" || line.trim() === "...") return out
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    if (/^["']/.test(value)) {
      const q = value[0]!
      const end = value.indexOf(q, 1)
      value = end > 0 ? value.slice(1, end) : value.slice(1)
    } else value = value.replace(/\s+#.*$/, "").trim()
    out[m[1]!] = value
  }
  return undefined
}

function within(base: string, value: string): string {
  const v = slash(value)
  return isAbsolute(v) ? normalize(v) : join(base, v)
}

/** The container a `WORKSPACE.md` describes, if its front matter says `jproject: 1` and names this work folder. */
async function containerAt(host: Host, root: string, workName: string): Promise<Container | undefined> {
  const workspace = join(root, workName, "WORKSPACE.md")
  const text = await host.readText(workspace).catch(() => undefined)
  if (text === undefined) return undefined
  const fm = parseFrontMatter(text)
  if (!fm || fm.jproject?.trim() !== "1") return undefined
  const work = fm.work_dir || DEFAULT_WORK_DIR
  const insensitive = caseInsensitive(host.platform)
  const same = (a: string, b: string) => (insensitive ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b))
  if (!same(join(root, work), join(root, workName))) return undefined
  const c: Container = { root, product: within(root, fm.product_dir || DEFAULT_PRODUCT_DIR), work: join(root, work), workspace }
  if (fm.secrets_dir) c.secrets = within(root, fm.secrets_dir)
  if (fm.jtasks_data) c.jtasksData = within(root, fm.jtasks_data)
  return c
}

const NOT_WORK = new Set([".git", "node_modules"])

/**
 * The jproject container of `cwd`: walking up from it, the first folder with `<work_dir>/WORKSPACE.md` whose front
 * matter says `jproject: 1` (and names that same folder as `work_dir`). `_work` is tried first, then the other
 * subfolders. From inside `product/`, the container is found one level up like any other.
 */
export async function findContainer(host: Host, cwd: string): Promise<Container | undefined> {
  let dir = normalize(isAbsolute(cwd) ? cwd : join(host.cwd(), cwd))
  for (;;) {
    const found = await containerAt(host, dir, DEFAULT_WORK_DIR)
    if (found) return found
    for (const e of await host.list(dir).catch(() => [])) {
      if (e.kind !== "dir" || e.name === DEFAULT_WORK_DIR || NOT_WORK.has(e.name)) continue
      if (!(await host.stat(join(dir, e.name, "WORKSPACE.md")))) continue
      const other = await containerAt(host, dir, e.name)
      if (other) return other
    }
    const up = dirname(dir)
    if (up === dir || normalize(up) === normalize(dir)) return undefined
    dir = up
  }
}

async function gitTop(host: Host, cwd: string): Promise<string | undefined> {
  const r = await git(host, cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined)
  if (!r || r.code !== 0) return undefined
  return slash(r.stdout.trim())
}

/** The data folder for a repository (and its container), by the rules at the top of this file. */
export async function resolveDataDir(host: Host, repoRoot: string, container?: Container): Promise<{ dataDir: string; source: DataSource; shared: boolean }> {
  const env = host.env("JTASKS_SCRATCH")?.trim()
  if (env) return { dataDir: within(container?.root ?? repoRoot, env), source: "env", shared: isAbsolute(slash(env)) }
  const saved = (await readConfig(host)).dataDir?.trim()
  if (saved && isAbsolute(slash(saved))) return { dataDir: normalize(slash(saved)), source: "config", shared: true }
  if (saved && container) return { dataDir: within(container.root, saved), source: "config", shared: false }
  if (container) return { dataDir: container.jtasksData ?? join(container.root, DEFAULT_CONTAINER_DATA), source: "workspace", shared: false }
  return { dataDir: join(repoRoot, LEGACY_DATA), source: "legacy", shared: false }
}

/** `dataDir` relative to the repository when it lies inside it (`.scratch/jtasks` in the legacy mode). */
export function dataInRepo(repoRoot: string, dataDir: string, platform: string): string | undefined {
  const rel = relativeInside(repoRoot, dataDir, caseInsensitive(platform))
  return rel === undefined ? undefined : rel || "."
}

/** The legacy data folder of a repository: `<repo>/.scratch/jtasks`. */
export function legacyDataDir(repoRoot: string): string {
  return join(repoRoot, LEGACY_DATA)
}

/**
 * The data folder of a run bound to a session (the mod's and the plugin's state keep `root` and `data` as the tool
 * answered them); a binding an older version stored without `data` is a legacy run.
 */
export function boundData(binding: { root: string; data?: string }): string {
  return binding.data ?? legacyDataDir(binding.root)
}

/**
 * The repository and the data folder for a command run in `cwd`, or undefined when there is no repository: `cwd`'s
 * own git repository, or, outside one (the agent opened in a jproject container), `<container>/<product_dir>`.
 */
export async function resolvePaths(host: Host, cwd: string): Promise<RepoPaths | undefined> {
  const container = await findContainer(host, cwd)
  const insensitive = caseInsensitive(host.platform)
  let repoRoot = await gitTop(host, cwd)
  // A repository that holds the container (or none at all): the container's product is the one meant.
  if (container && (!repoRoot || relativeInside(container.root, repoRoot, insensitive) === undefined)) repoRoot = await gitTop(host, container.product)
  if (!repoRoot) return undefined
  const mine = container && relativeInside(container.root, repoRoot, insensitive) !== undefined ? container : undefined
  const data = await resolveDataDir(host, repoRoot, mine)
  const out: RepoPaths = { repoRoot, ...data }
  if (mine) out.container = mine
  const rel = dataInRepo(repoRoot, data.dataDir, host.platform)
  if (rel !== undefined) out.inRepo = rel
  return out
}

/**
 * The jproject container around `cwd` whose product folder is not a git repository of its own. Run data needs that
 * repository, so this is a condition: `jtasks doctor --fix` offers to create it (`git init`).
 */
export async function containerWithoutGit(host: Host, cwd: string): Promise<Container | undefined> {
  const container = await findContainer(host, cwd)
  if (!container) return undefined
  return (await host.stat(join(container.product, ".git"))) ? undefined : container
}

export async function requirePaths(host: Host, cwd: string): Promise<RepoPaths> {
  const paths = await resolvePaths(host, cwd)
  if (paths) return paths
  const bare = await containerWithoutGit(host, cwd)
  if (bare) throw new ToolError(tr("container.needs_git", { product: bare.product }))
  throw new ToolError(tr("git.not_a_repo", { cwd }))
}

/** The repository's root for a command run in `cwd` (the container's product outside a repository). */
export async function requireRepo(host: Host, cwd: string): Promise<string> {
  return (await requirePaths(host, cwd)).repoRoot
}

/** The line `.git/info/exclude` gets in the legacy mode (`.scratch/`), or undefined when the data is outside the repository. */
export function excludeLineOf(paths: Pick<RepoPaths, "inRepo">): string | undefined {
  if (paths.inRepo === undefined) return undefined
  if (paths.inRepo === LEGACY_DATA) return ".scratch/"
  return paths.inRepo === "." ? undefined : `${paths.inRepo}/`
}

/** Whether a repository-relative path (git status) is the tool's own data, which never counts as a change. */
export function isDataPath(paths: Pick<RepoPaths, "inRepo">, rel: string, platform: string): boolean {
  if (paths.inRepo === undefined || paths.inRepo === ".") return false
  const insensitive = caseInsensitive(platform)
  const p = insensitive ? rel.toLowerCase() : rel
  const d = insensitive ? paths.inRepo.toLowerCase() : paths.inRepo
  // `.scratch/` is what the legacy exclude line hides: anything under it was never code.
  if (d === LEGACY_DATA && (p === ".scratch" || p.startsWith(".scratch/"))) return true
  return p === d || p.startsWith(`${d}/`)
}
