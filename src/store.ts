// Where a run lives and how its files are written: atomically (`.tmp` + `rename`), re-reading before writing, with
// an incremental `revision` that refuses a write based on a stale read.

import type { Host } from "./host.ts"
import { join } from "./paths.ts"
import type { RunFile, TasksFile } from "./schema.ts"
import { tr } from "./i18n.ts"

export const SCRATCH = ".scratch/jtasks"

export function runsDir(root: string): string {
  return join(root, SCRATCH, "runs")
}

export function runDir(root: string, run: string): string {
  return join(runsDir(root), run)
}

/** `%USERPROFILE%\.jtasks`, or `JTASKS_HOME`. */
export function jtasksHome(host: Host): string {
  const own = host.env("JTASKS_HOME")
  if (own) return own.replace(/\\/g, "/")
  const home = host.env("USERPROFILE") ?? host.env("HOME") ?? "."
  return join(home, ".jtasks")
}

export class StaleRevisionError extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(tr("store.stale", { expected, found }))
  }
}

export async function atomicWrite(host: Host, file: string, text: string): Promise<void> {
  const tmp = `${file}.${Math.floor(host.random() * 1e9).toString(36)}.tmp`
  await host.writeText(tmp, text)
  try {
    await host.rename(tmp, file)
  } catch (error) {
    await host.remove(tmp).catch(() => {})
    throw error
  }
}

export async function readJson<T>(host: Host, file: string): Promise<T | undefined> {
  const text = await host.readText(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(tr("store.invalid_json", { file, message: (error as Error).message }))
  }
}

/** A deep copy of plain JSON data (structuredClone is not in every host the core runs in). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function readRun(host: Host, dir: string): Promise<RunFile | undefined> {
  return readJson<RunFile>(host, join(dir, "run.json"))
}

export async function readTasks(host: Host, dir: string): Promise<TasksFile | undefined> {
  return readJson<TasksFile>(host, join(dir, "tasks.json"))
}

export async function writeRun(host: Host, dir: string, run: RunFile): Promise<void> {
  await atomicWrite(host, join(dir, "run.json"), stringify(run))
}

/**
 * Writes `tasks` as revision `expected + 1`, after re-reading the file: if someone else wrote meanwhile, the write
 * is refused with `StaleRevisionError` and nothing changes.
 */
export async function writeTasks(host: Host, dir: string, tasks: TasksFile, expected: number): Promise<TasksFile> {
  const current = await readTasks(host, dir)
  const found = current?.revision ?? 0
  if (found !== expected) throw new StaleRevisionError(expected, found)
  const next = { ...tasks, revision: expected + 1 }
  await atomicWrite(host, join(dir, "tasks.json"), stringify(next))
  return next
}

export interface Mutation<R> {
  tasks: TasksFile
  result: R
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 20_000

/**
 * A short lock around one read-change-write of a run's files: a folder created exclusively (atomic on every file
 * system, and reachable from every host). A lock older than 10 s belongs to a writer that died and is broken.
 */
export async function withLock<R>(host: Host, dir: string, fn: () => Promise<R>): Promise<R> {
  const lock = join(dir, ".write.lock")
  const deadline = host.now().getTime() + LOCK_WAIT_MS
  for (;;) {
    if (await host.mkdirExclusive(lock)) break
    const stat = await host.stat(lock)
    if (stat && host.now().getTime() - stat.mtimeMs > LOCK_STALE_MS) {
      await host.remove(lock, { recursive: true }).catch(() => {})
      continue
    }
    if (host.now().getTime() > deadline) throw new Error(tr("store.locked", { seconds: LOCK_WAIT_MS / 1000, lock }))
    await host.sleep(15 + Math.floor(host.random() * 35))
  }
  try {
    return await fn()
  } finally {
    await host.remove(lock, { recursive: true }).catch(() => {})
  }
}

/**
 * Read → change → write under the run's write lock. `change` must not have side effects outside the object it
 * gets: do those before or after.
 */
export async function mutateTasks<R>(host: Host, dir: string, change: (tasks: TasksFile) => Promise<R> | R): Promise<Mutation<R>> {
  return withLock(host, dir, async () => {
    const tasks = await readTasks(host, dir)
    if (!tasks) throw new Error(tr("store.no_tasks", { dir }))
    const copy = clone(tasks)
    const result = await change(copy)
    return { tasks: await writeTasks(host, dir, copy, tasks.revision), result }
  })
}

export interface RunEntry {
  dir: string
  run: RunFile
  tasks?: TasksFile
}

/** The runs of the repository: folders with a `run.json` (a draft alone is not a run yet). */
export async function listRuns(host: Host, root: string): Promise<RunEntry[]> {
  const out: RunEntry[] = []
  for (const entry of await host.list(runsDir(root))) {
    if (entry.kind !== "dir") continue
    const dir = join(runsDir(root), entry.name)
    const run = await readRun(host, dir).catch(() => undefined)
    if (!run) continue
    out.push({ dir, run, tasks: await readTasks(host, dir).catch(() => undefined) })
  }
  return out.sort((a, b) => a.run.created.localeCompare(b.run.created) || a.run.id.localeCompare(b.run.id))
}

export interface LogEntry {
  at: string
  actor: string
  action: string
  task?: string
  from?: string
  to?: string
  [key: string]: unknown
}

export async function appendLog(host: Host, dir: string, entry: LogEntry): Promise<void> {
  await host.appendText(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`)
}
