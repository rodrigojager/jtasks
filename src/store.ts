// Where a run lives and how its state is read and changed (ticket 60): the state is run.json and tasks.json (the
// snapshots) plus the events of `events.jsonl` after them (events.ts). Reading folds the events the snapshots have
// not seen; changing appends one event and folds up to it to see whether it was accepted (an optimistic commit, with
// no write lock). The snapshots are rewritten atomically (`.tmp` + `rename`) by whoever folded something new.

import { copyGens, diffState, foldLines, parseLines, RUN_FORMAT, type FoldState, type Gens, type Guards, type RunEvent } from "./events.ts"
import type { Host } from "./host.ts"
import { join, normalize } from "./paths.ts"
import type { RunFile, TasksFile } from "./schema.ts"
import { tr } from "./i18n.ts"

/** The runs of a data folder (`resolvePaths(...).dataDir`, see workspace.ts). */
export function runsDir(data: string): string {
  return join(data, "runs")
}

export function runDir(data: string, run: string): string {
  return join(runsDir(data), run)
}

/** `%USERPROFILE%\.jtasks`, or `JTASKS_HOME`. */
export function jtasksHome(host: Host): string {
  const own = host.env("JTASKS_HOME")
  if (own) return own.replace(/\\/g, "/")
  const home = host.env("USERPROFILE") ?? host.env("HOME") ?? "."
  return join(home, ".jtasks")
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

export const EVENTS_FILE = "events.jsonl"

/** A run's state as every reader sees it: the snapshots with the events after them folded in. */
export interface RunSnapshot {
  run?: RunFile
  tasks?: TasksFile
  /** The generations at `offset` (events.ts). */
  gens: Gens
  /** Bytes of events.jsonl folded in. */
  offset: number
}

/** How many events a reader folds past a snapshot before it rewrites the snapshots itself. */
const REWRITE_AFTER = 64

function snapshotOf(value: { eventOffset?: number; gens?: Gens } | undefined): { offset: number; gens: Gens } {
  return { offset: typeof value?.eventOffset === "number" ? value.eventOffset : 0, gens: copyGens(value?.gens) }
}

/**
 * Reads a run's state: run.json and tasks.json, then events.jsonl (always after the snapshots, so the file is never
 * shorter than what they say they folded), each snapshot folded from its own offset. A run from before ticket 60 has
 * neither offset nor generations: its snapshot is the base at offset 0, every generation 0.
 */
export async function readState(host: Host, dir: string, opts: { rewrite?: boolean } = {}): Promise<RunSnapshot | undefined> {
  const run = await readJson<RunFile>(host, join(dir, "run.json"))
  const tasks = await readJson<TasksFile>(host, join(dir, "tasks.json"))
  if (!run && !tasks) return undefined
  const text = (await host.readText(join(dir, EVENTS_FILE))) ?? ""
  const r = snapshotOf(run)
  const t = snapshotOf(tasks)
  const runSide: FoldState = run ? { run, gens: r.gens } : { gens: r.gens }
  const taskSide: FoldState = tasks ? { tasks, gens: t.gens } : { gens: t.gens }
  let end = Math.max(r.offset, t.offset)
  let folded = 0
  const sides: [FoldState, number][] = []
  if (run) sides.push([runSide, r.offset])
  if (tasks) sides.push([taskSide, t.offset])
  for (const [side, from] of sides) {
    const read = parseLines(text, from)
    foldLines(side, read.lines)
    end = Math.max(from, read.end)
    folded = Math.max(folded, read.lines.length)
  }
  const state: RunSnapshot = { gens: tasks ? taskSide.gens : runSide.gens, offset: end }
  if (run) state.run = run
  if (tasks) state.tasks = tasks
  if ((opts.rewrite ?? true) && run && tasks && folded >= REWRITE_AFTER) await writeSnapshots(host, dir, state).catch(() => {})
  return state
}

/** Writes run.json and tasks.json as the materialized view of `state` (each atomically; an older one is still right). */
export async function writeSnapshots(host: Host, dir: string, state: RunSnapshot): Promise<void> {
  const stamp = { eventOffset: state.offset, gens: state.gens }
  if (state.tasks) await atomicWrite(host, join(dir, "tasks.json"), stringify({ ...strip(state.tasks), ...stamp }))
  if (state.run) await atomicWrite(host, join(dir, "run.json"), stringify({ ...strip(state.run), format: RUN_FORMAT, ...stamp }))
}

/** A run or tasks file without its snapshot fields: what an action sees and edits. */
export function strip<T>(value: T): T {
  const { eventOffset: _o, gens: _g, format: _f, ...rest } = value as T & { eventOffset?: unknown; gens?: unknown; format?: unknown }
  return rest as T
}

export async function readRun(host: Host, dir: string): Promise<RunFile | undefined> {
  const s = await readState(host, dir)
  return s?.run && strip(s.run)
}

export async function readTasks(host: Host, dir: string): Promise<TasksFile | undefined> {
  const s = await readState(host, dir)
  return s?.tasks && strip(s.tasks)
}

/** The copy of the state a decision edits, and the tasks (or the run) it read without changing them. */
export interface StateDraft {
  run: RunFile
  tasks: TasksFile
  /** The state as read, to look at (never edited). */
  readonly read: { run: RunFile; tasks: TasksFile }
  /** The decision depends on these tasks as they are: the event is refused if one of them moved meanwhile. */
  guard(...ids: string[]): void
  /** The decision depends on run.json as it is. */
  guardRun(): void
  /** A task's generation in the state the decision reads. */
  gen(id: string): number
}

export interface Committed<R> {
  run: RunFile
  tasks: TasksFile
  result: R
  /** False when the decision changed nothing (no event written). */
  changed: boolean
  /** The attempt that landed (1 unless others changed the same tasks meanwhile). */
  attempts: number
  /** The generations after the event (or as read). */
  gens: Gens
}

/** How many times a decision is made again when the fold refuses its event. */
export const COMMIT_ATTEMPTS = 20

export class CommitConflictError extends Error {
  constructor(readonly attempts: number) {
    super(tr("store.contended", { n: attempts }))
  }
}

let sequence = 0

function eventId(host: Host): string {
  sequence = (sequence + 1) % 46656
  return `${host.now().getTime().toString(36)}-${Math.floor(host.random() * 2 ** 31).toString(36)}-${sequence.toString(36)}`
}

/**
 * The optimistic commit: read the state, let `decide` edit a copy (throwing refuses, nothing written), append the
 * diff as one event, fold up to it and see whether it was accepted. Refused (someone changed the same tasks, or a task
 * the decision guarded, meanwhile): read again and decide again, up to COMMIT_ATTEMPTS times after a short random
 * wait. A decision made on an old read never lands.
 *
 * `decide` may run more than once: what it does outside the copy must be idempotent (the callers that touch the
 * working tree hold the run's tree key, see serial.ts).
 */
export async function commit<R>(
  host: Host,
  dir: string,
  decide: (draft: StateDraft, attempt: number) => Promise<R> | R,
  opts: { actor?: string; action?: string } = {},
): Promise<Committed<R>> {
  for (let attempt = 1; ; attempt++) {
    const base = await readState(host, dir)
    if (!base?.run || !base.tasks) throw new Error(tr("store.no_tasks", { dir }))
    const before = { run: strip(base.run), tasks: strip(base.tasks) }
    const guards: Guards = { tasks: new Set(), run: false }
    const draft: StateDraft = {
      run: clone(before.run),
      tasks: clone(before.tasks),
      read: before,
      guard: (...ids) => ids.forEach((id) => guards.tasks.add(id)),
      guardRun: () => void (guards.run = true),
      gen: (id) => base.gens.tasks[id] ?? 0,
    }
    const result = await decide(draft, attempt)
    const diff = diffState(before, { run: draft.run, tasks: draft.tasks }, base.gens, guards)
    if (!diff) return { run: before.run, tasks: before.tasks, result, changed: false, attempts: attempt, gens: base.gens }
    const event: RunEvent = { v: 1, id: eventId(host), at: host.now().toISOString(), actor: opts.actor ?? "jtasks", ...diff }
    if (opts.action) event.log = opts.action
    // A leading newline: a line a dead writer left torn ends there instead of swallowing this one.
    await host.appendText(join(dir, EVENTS_FILE), `\n${JSON.stringify(event)}\n`)
    const after = await foldFrom(host, dir, base, event.id)
    if (after.accepted) {
      await writeSnapshots(host, dir, after.state).catch(() => {})
      return { run: strip(after.state.run!), tasks: strip(after.state.tasks!), result, changed: true, attempts: attempt, gens: after.state.gens }
    }
    if (attempt >= COMMIT_ATTEMPTS) throw new CommitConflictError(attempt)
    await host.sleep(5 + Math.floor(host.random() * 20 * Math.min(attempt, 8)))
  }
}

/** Folds events.jsonl from the state a commit read, up to the end: whether `id` was accepted, and the state there. */
async function foldFrom(host: Host, dir: string, base: RunSnapshot, id: string): Promise<{ accepted: boolean; state: RunSnapshot }> {
  const text = (await host.readText(join(dir, EVENTS_FILE))) ?? ""
  const side: FoldState = { run: clone(base.run!), tasks: clone(base.tasks!), gens: copyGens(base.gens) }
  const read = parseLines(text, base.offset)
  const folded = foldLines(side, read.lines)
  return { accepted: folded.accepted.includes(id), state: { run: side.run!, tasks: side.tasks!, gens: side.gens, offset: Math.max(base.offset, read.end) } }
}

export interface Mutation<R> {
  tasks: TasksFile
  result: R
}

/**
 * Read → change → commit of the tasks alone. `change` must not have side effects outside the object it gets (it
 * may run again when the commit is refused): do those before or after.
 */
export async function mutateTasks<R>(host: Host, dir: string, change: (tasks: TasksFile) => Promise<R> | R): Promise<Mutation<R>> {
  const c = await commit(host, dir, (d) => change(d.tasks))
  return { tasks: c.tasks, result: c.result }
}

/** A new run's first snapshots (plan, import, draft commit): no events yet, every generation 0, `format: 2`. */
export async function createSnapshots(host: Host, dir: string, run: RunFile, tasks: TasksFile): Promise<void> {
  await writeSnapshots(host, dir, { run, tasks, gens: { run: 0, tasks: {} }, offset: 0 })
}

export interface RunEntry {
  dir: string
  run: RunFile
  tasks?: TasksFile
}

/**
 * The runs of a data folder: folders with a `run.json` (a draft alone is not a run yet). With `repo`, only that
 * repository's runs (a data folder several repositories share).
 */
export async function listRuns(host: Host, data: string, repo?: { root: string; caseInsensitive: boolean }): Promise<RunEntry[]> {
  const out: RunEntry[] = []
  const norm = (p: string) => (repo?.caseInsensitive ? normalize(p).toLowerCase() : normalize(p))
  for (const entry of await host.list(runsDir(data))) {
    if (entry.kind !== "dir") continue
    const dir = join(runsDir(data), entry.name)
    const state = await readState(host, dir).catch(() => undefined)
    if (!state?.run) continue
    const run = strip(state.run)
    if (repo && run.repo?.root && norm(run.repo.root) !== norm(repo.root)) continue
    out.push(state.tasks ? { dir, run, tasks: strip(state.tasks) } : { dir, run })
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
