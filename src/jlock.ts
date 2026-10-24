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

export interface Identity {
  owner: string
  group: string
  intent: string
  meta: Record<string, string>
}

export function holdArgv(host: Host, keys: string[], id: Identity, wait: { noWait: true } | { timeoutSec: number }): string[] {
  const argv = [jlockBin(host), "hold", ...keys, "--owner", id.owner, "--group", id.group, "--intent", id.intent]
  for (const [k, v] of Object.entries(id.meta)) argv.push("--meta", `${k}=${v}`)
  if ("noWait" in wait) argv.push("--no-wait")
  else argv.push("--timeout", `${wait.timeoutSec}s`)
  argv.push("--json")
  return argv
}

export interface HoldOutcome {
  /** The first answer: `granted`, `queued`, `timeout`, `deadlock`. */
  answer: JlockAnswer
  /** Exit code once known (the hold keeps running when granted). */
  code?: number
  resident: Resident
}

/**
 * Starts a `jlock hold` and waits for its first line. Granted → the process stays alive renewing the lock. Any
 * other answer → the process has ended (or is ending) with jlock's code.
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
