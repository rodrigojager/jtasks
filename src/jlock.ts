// jlock, only through its installed CLI (`jlock` in PATH, or JLOCK_BIN), always with --json and absolute paths
// (plan section 20). The core never reads jlock's registry folder.

import type { Host, Resident } from "./host.ts"
import { relativeInside, caseInsensitive } from "./paths.ts"
import { ToolError } from "./tool.ts"

export const JLOCK = {
  OK: 0,
  BUSY: 10,
  TIMEOUT: 11,
  DEADLOCK: 12,
  NOT_OWNER: 13,
  LOST: 14,
  USAGE: 2,
  DISK: 20,
} as const

export interface JlockHolder {
  owner: string
  group?: string | null
  intent?: string | null
  meta?: Record<string, string> | null
  pid?: number
  since?: string
  key?: string
  stale?: boolean
  late?: boolean
}

export interface JlockQueueEntry {
  owner: string
  group?: string | null
  position: number
  since?: string
  stale?: boolean
}

export interface JlockLock {
  key: string
  holder: JlockHolder | null
  queue: JlockQueueEntry[]
}

/** One JSON answer of jlock (`hold`, `release`, `acquire`). */
export interface JlockAnswer {
  result: string
  key?: string
  keys?: string[]
  owner?: string
  holder?: JlockHolder | string | null
  position?: number
  via?: string
  chain?: string
  failed?: string
  reason?: string
  message?: string
  error?: string
}

export function jlockBin(host: Host): string {
  return host.env("JLOCK_BIN") || "jlock"
}

function parseAnswer(text: string): JlockAnswer | undefined {
  const line = text.split("\n").find((l) => l.trim().startsWith("{"))
  if (!line) return undefined
  try {
    return JSON.parse(line) as JlockAnswer
  } catch {
    return undefined
  }
}

/** Turns jlock's failures that are not lock outcomes into tool errors (20: disk; 2: our bug). */
function failure(code: number, stdout: string, stderr: string, what: string): ToolError {
  const answer = parseAnswer(stdout)
  const message = answer?.message ?? answer?.error ?? (stderr.trim() || stdout.trim())
  if (code === JLOCK.DISK) return new ToolError(`jlock (${what}): erro de disco: ${message}`)
  if (code === JLOCK.USAGE) return new ToolError(`jlock (${what}) recusou o uso: ${message} — é um bug do goal-tasks, registre-o`)
  if (code === 127) return new ToolError(`jlock não encontrado no PATH (${message}); instale o jlock ou defina JLOCK_BIN`)
  return new ToolError(`jlock (${what}) saiu com ${code}: ${message}`)
}

export async function jlockList(host: Host, filter: { group?: string; under?: string; owner?: string } = {}): Promise<JlockLock[]> {
  const argv = [jlockBin(host), "list", "--json"]
  if (filter.group) argv.push("--group", filter.group)
  if (filter.under) argv.push("--under", filter.under)
  if (filter.owner) argv.push("--owner", filter.owner)
  const r = await host.run(argv)
  if (r.code !== 0) throw failure(r.code, r.stdout, r.stderr, "list")
  try {
    const parsed = JSON.parse(r.stdout) as { locks?: JlockLock[] }
    return parsed.locks ?? []
  } catch {
    throw new ToolError(`jlock list devolveu algo que não é JSON: ${r.stdout.slice(0, 200)}`)
  }
}

export interface ReleaseOutcome {
  code: number
  keys: string[]
}

/** `jlock release --group <run> --owner <owner>`: tolerates "not the owner" (13), the lock was not ours any more. */
export async function jlockRelease(host: Host, group: string, owner: string): Promise<ReleaseOutcome> {
  const r = await host.run([jlockBin(host), "release", "--group", group, "--owner", owner, "--json"])
  if (r.code !== JLOCK.OK && r.code !== JLOCK.NOT_OWNER) throw failure(r.code, r.stdout, r.stderr, "release")
  return { code: r.code, keys: parseAnswer(r.stdout)?.keys ?? [] }
}

/** `jlock release <keys…> --owner <owner>`: gives back some keys only (a claim that could not be recorded). */
export async function jlockReleaseKeys(host: Host, keys: string[], owner: string): Promise<ReleaseOutcome> {
  const r = await host.run([jlockBin(host), "release", ...keys, "--owner", owner, "--json"])
  if (r.code !== JLOCK.OK && r.code !== JLOCK.NOT_OWNER) throw failure(r.code, r.stdout, r.stderr, "release")
  return { code: r.code, keys: parseAnswer(r.stdout)?.keys ?? [] }
}

export interface Identity {
  owner: string
  group: string
  intent: string
  meta: Record<string, string>
}

/**
 * How a host keeps a task's locks (plan section 4): `detach` is `jlock hold --detach`, one call that answers and
 * returns while jlock's own keeper holds the lock until `jlock release` or the ttl (the CLI, the mod); `eof` is
 * `jlock hold --release-on-eof` kept alive by the host with its standard input open, so the host dying frees the
 * lock at once (the plugin; needs jlock 0.1.1).
 */
export type HoldMode = "detach" | "eof"

/** The oldest jlock the tool works with, and the first one with `hold --release-on-eof`. */
export const MIN_JLOCK = "0.1.0"
export const EOF_JLOCK = "0.1.1"

const versions = new Map<string, Promise<string>>()

/** `jlock --version` once per process (per executable), as `X.Y.Z`. */
export function jlockVersion(host: Host): Promise<string> {
  const bin = jlockBin(host)
  let pending = versions.get(bin)
  if (!pending) {
    pending = host.run([bin, "--version"]).then((r) => {
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}\n${r.stderr}`)
      if (r.code === 127 || !m) {
        versions.delete(bin)
        throw failure(r.code === 0 ? 1 : r.code, r.stdout, r.stderr || "jlock --version não respondeu a versão", "--version")
      }
      return `${m[1]}.${m[2]}.${m[3]}`
    })
    versions.set(bin, pending)
  }
  return pending
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number)
  const b = minimum.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** The mode a long-lived host should use: `eof` when the installed jlock has `--release-on-eof`. */
export async function holdModeFor(host: Host): Promise<HoldMode> {
  return versionAtLeast(await jlockVersion(host), EOF_JLOCK) ? "eof" : "detach"
}

export function holdArgv(
  host: Host,
  keys: string[],
  id: Identity,
  wait: { noWait: true } | { timeoutSec: number },
  hold: { mode: HoldMode; ttl: string },
): string[] {
  const argv = [jlockBin(host), "hold", ...keys, "--owner", id.owner, "--group", id.group, "--intent", id.intent]
  for (const [k, v] of Object.entries(id.meta)) argv.push("--meta", `${k}=${v}`)
  if ("noWait" in wait) argv.push("--no-wait")
  else argv.push("--timeout", `${wait.timeoutSec}s`)
  argv.push("--ttl", hold.ttl, hold.mode === "detach" ? "--detach" : "--release-on-eof", "--json")
  return argv
}

export interface HoldOutcome {
  /** The first answer: `granted`, `queued`, `timeout`, `deadlock`. */
  answer: JlockAnswer
  /** Exit code once known (an `eof` hold keeps running when granted). */
  code?: number
  /** The hold process this host keeps (`eof` mode); absent with `--detach`, where jlock's keeper holds the lock. */
  resident?: Resident
}

/**
 * `jlock hold --detach`: one call that answers like `hold` and returns, jlock's own keeper holding the lock until
 * `jlock release`, the ttl or `unlock --force`. `timeoutMs` bounds the call (a `claim` waits up to its timeout).
 */
export async function detachedHold(host: Host, argv: string[], cwd: string, timeoutMs: number): Promise<HoldOutcome> {
  const r = await host.run(argv, { cwd, timeoutMs })
  const answer = parseAnswer(r.stdout)
  if (!answer) {
    if (r.code === 127) throw failure(127, r.stdout, r.stderr, "hold")
    throw new ToolError(`jlock hold respondeu algo que não é JSON (saída ${r.code}): ${(r.stdout || r.stderr).slice(0, 200)}`)
  }
  if (answer.result === "error") throw failure(r.code, r.stdout, r.stderr, "hold")
  return { answer, code: r.code }
}

/**
 * A `jlock hold --release-on-eof` this host keeps: waits for its first line. Granted → the process stays alive
 * renewing the lock while the host holds its standard input. Any other answer → the process has ended (or is
 * ending) with jlock's code.
 */
export async function startHold(host: Host, resident: Resident, firstLineTimeoutMs: number): Promise<HoldOutcome> {
  const line = await resident.firstLine(firstLineTimeoutMs)
  if (line === undefined) {
    const code = await Promise.race([resident.exited, host.sleep(2000).then(() => undefined)])
    if (code === undefined) {
      await resident.stop()
      throw new ToolError(`jlock hold não respondeu em ${Math.round(firstLineTimeoutMs / 1000)} s`)
    }
    throw failure(code, resident.lines().join("\n"), "", "hold")
  }
  const answer = parseAnswer(line)
  if (!answer) {
    await resident.stop()
    throw new ToolError(`jlock hold respondeu algo que não é JSON: ${line.slice(0, 200)}`)
  }
  if (answer.result === "granted") return { answer, resident }
  const code = await Promise.race([resident.exited, host.sleep(5000).then(() => undefined)])
  if (answer.result === "error") throw failure(code ?? 1, line, "", "hold")
  return { answer, code, resident }
}

/** How the panel and the answers name a lock's owner (section 4): `T05`, `auth-261024-p0q9/T03`, or another program. */
export function describeOwner(owner: string, run: string): string {
  if (!owner.startsWith("gt:")) return `outro programa: ${owner}`
  const rest = owner.slice(3)
  const slash = rest.lastIndexOf("/")
  if (slash < 0) return rest
  const ownerRun = rest.slice(0, slash)
  const task = rest.slice(slash + 1)
  return ownerRun === run ? task : `${ownerRun}/${task}`
}

/** A key as people read it: relative to the repository when inside it. */
export function describeKey(key: string, root: string, platform: string): string {
  if (key === "*" || key.startsWith("name:")) return key
  const rel = relativeInside(root, key, caseInsensitive(platform))
  if (rel === undefined) return key
  return rel === "" ? "." : rel
}
