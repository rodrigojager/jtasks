// The run's state as the sum of events (ticket 60). Every change to a run's tasks or to its run.json is one line
// appended to `events.jsonl`: `{ v, id, at, actor, ops: [{ task, gen, set, unset }], run?: { gen, set, unset } }`.
// `set`/`unset` are the top-level fields that changed, computed from the copy an action edited; `gen` is the
// generation of the task (or the run) its author read. The fold is pure and deterministic: an event applies whole
// when every task it touches (and the run, when it touches it) is still at the generation it read, and then each of
// them moves to `gen + 1`; otherwise it is ignored. An op with no `set`/`unset` only guards: the decision read that
// task, which must not have moved, and nothing changes. Every reader, in any process, reaches the same state.
//
// Nothing here does I/O: store.ts reads the snapshots and the file, folds, appends and checks.

import type { RunFile, Task, TasksFile } from "./schema.ts"

export const EVENT_VERSION = 1
/** run.json's `format` once its state comes from events (a 0.3.x jtasks does not know it). */
export const RUN_FORMAT = 2

export interface FieldPatch {
  set?: Record<string, unknown>
  unset?: string[]
}

export interface TaskOp extends FieldPatch {
  task: string
  gen: number
}

export interface RunOp extends FieldPatch {
  gen: number
}

export interface RunEvent {
  v: 1
  id: string
  at: string
  actor: string
  ops: TaskOp[]
  run?: RunOp
  /** The action that wrote it, for whoever reads the file (the audit stays in log.jsonl). */
  log?: string
}

/** The generations of a run: the run's own and each task's (a task never written is at 0). */
export interface Gens {
  run: number
  tasks: Record<string, number>
}

/** What the snapshots add to run.json and tasks.json: how far into events.jsonl they are, and the generations there. */
export interface SnapshotFields {
  eventOffset?: number
  gens?: Gens
}

/** Fields of run.json that belong to the snapshot, not to the run: never part of an event. */
export const RUN_SNAPSHOT_KEYS = new Set(["format", "eventOffset", "gens"])

export function emptyGens(): Gens {
  return { run: 0, tasks: {} }
}

export function copyGens(g: Gens | undefined): Gens {
  return { run: g?.run ?? 0, tasks: { ...(g?.tasks ?? {}) } }
}

export function taskGen(g: Gens, id: string): number {
  return g.tasks[id] ?? 0
}

function hasChange(p: FieldPatch): boolean {
  return !!(p.set && Object.keys(p.set).length) || !!p.unset?.length
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function applyPatch(target: Record<string, unknown>, p: FieldPatch) {
  for (const [k, v] of Object.entries(p.set ?? {})) target[k] = copy(v)
  for (const k of p.unset ?? []) delete target[k]
}

/** One side of the state a fold carries: the run, the tasks, or both. The generations always. */
export interface FoldState {
  run?: RunFile
  tasks?: TasksFile
  gens: Gens
}

/** Whether `event` applies on `gens`: every task it names, and the run when it names it, at the generation it read. */
export function accepts(gens: Gens, event: RunEvent): boolean {
  if (!Array.isArray(event.ops)) return false
  for (const op of event.ops) if (typeof op?.task !== "string" || taskGen(gens, op.task) !== op.gen) return false
  if (event.run && gens.run !== event.run.gen) return false
  return event.ops.length > 0 || !!event.run
}

/**
 * Applies one event to `state` (in place) when the fold accepts it; answers whether it did. Only the generations
 * decide, so a fold of the run alone and one of the tasks alone accept the same events.
 */
export function applyEvent(state: FoldState, event: RunEvent): boolean {
  if (!accepts(state.gens, event)) return false
  let tasksChanged = false
  for (const op of event.ops) {
    if (!hasChange(op)) continue
    state.gens.tasks[op.task] = op.gen + 1
    tasksChanged = true
    const task = state.tasks?.tasks.find((t) => t.id === op.task)
    if (task) applyPatch(task as unknown as Record<string, unknown>, op)
  }
  if (event.run && hasChange(event.run)) {
    state.gens.run = event.run.gen + 1
    if (state.run) applyPatch(state.run as unknown as Record<string, unknown>, event.run)
  }
  if (tasksChanged && state.tasks) state.tasks.revision = (state.tasks.revision ?? 0) + 1
  return true
}

/** Bytes of `text` in UTF-8 (the hosts read and write UTF-8; offsets into events.jsonl are bytes). */
export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The index in `text` where byte `offset` starts (the end of the text when it is past it). */
export function charIndexAt(text: string, offset: number): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (n >= offset) return i
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return text.length
}

export interface EventLine {
  /** Undefined for a line that is not an event (torn by a writer that died, or two writes glued together). */
  event?: RunEvent
  /** The byte offset right after the line. */
  end: number
}

/**
 * The complete lines of events.jsonl from byte `offset` on (a last line without its newline is still being written:
 * left for the next read). `end` is where the next read starts.
 */
export function parseLines(text: string, offset: number): { lines: EventLine[]; end: number } {
  const lines: EventLine[] = []
  let at = charIndexAt(text, offset)
  let end = offset
  for (;;) {
    const nl = text.indexOf("\n", at)
    if (nl < 0) break
    const raw = text.slice(at, nl)
    end += utf8Length(raw) + 1
    at = nl + 1
    const line = raw.trim()
    if (!line) continue
    let event: RunEvent | undefined
    try {
      const parsed = JSON.parse(line) as RunEvent
      if (parsed && typeof parsed === "object" && parsed.v === EVENT_VERSION && typeof parsed.id === "string") event = parsed
    } catch {
      // Not an event: skipped by every reader alike.
    }
    lines.push(event ? { event, end } : { end })
  }
  return { lines, end }
}

/** Folds the lines into `state` (in place); answers the ids of the events it applied and of those it ignored. */
export function foldLines(state: FoldState, lines: EventLine[]): { accepted: string[]; refused: string[] } {
  const accepted: string[] = []
  const refused: string[] = []
  for (const l of lines) {
    if (!l.event) continue
    if (applyEvent(state, l.event)) accepted.push(l.event.id)
    else refused.push(l.event.id)
  }
  return { accepted, refused }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The top-level fields that differ between `before` and `after`, as a patch; undefined when nothing does. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, skip?: Set<string>): FieldPatch | undefined {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [k, v] of Object.entries(after)) {
    if (skip?.has(k) || v === undefined) continue
    if (!(k in before) || before[k] === undefined || !sameJson(before[k], v)) set[k] = copy(v)
  }
  for (const k of Object.keys(before)) {
    if (skip?.has(k) || before[k] === undefined) continue
    if (!(k in after) || after[k] === undefined) unset.push(k)
  }
  if (!Object.keys(set).length && !unset.length) return undefined
  const p: FieldPatch = {}
  if (Object.keys(set).length) p.set = set
  if (unset.length) p.unset = unset
  return p
}

export interface Guards {
  tasks: Set<string>
  run: boolean
}

/**
 * The ops an edit of the state makes: one per changed task (its diff), one guard per task the decision read
 * (`guards`), and the run's when it changed (or was guarded). Throws when the edit adds, removes or reorders tasks or
 * touches tasks.json outside its tasks: no action does, and the fold could not express it.
 */
export function diffState(
  before: { run: RunFile; tasks: TasksFile },
  after: { run: RunFile; tasks: TasksFile },
  gens: Gens,
  guards: Guards = { tasks: new Set(), run: false },
): { ops: TaskOp[]; run?: RunOp } | undefined {
  const ids = (t: TasksFile) => t.tasks.map((x) => x.id).join("\n")
  if (ids(before.tasks) !== ids(after.tasks)) throw new Error("jtasks: an event cannot add, remove or reorder tasks")
  const meta = (t: TasksFile) => {
    const { tasks: _t, revision: _r, eventOffset: _o, gens: _g, ...rest } = t as TasksFile & SnapshotFields
    return rest
  }
  if (!sameJson(meta(before.tasks), meta(after.tasks))) throw new Error("jtasks: an event changes only tasks and run.json")
  const ops: TaskOp[] = []
  before.tasks.tasks.forEach((b: Task, i) => {
    const a = after.tasks.tasks[i]!
    const p = diffFields(b as unknown as Record<string, unknown>, a as unknown as Record<string, unknown>)
    if (p) ops.push({ task: b.id, gen: taskGen(gens, b.id), ...p })
    else if (guards.tasks.has(b.id)) ops.push({ task: b.id, gen: taskGen(gens, b.id) })
  })
  const rp = diffFields(before.run as unknown as Record<string, unknown>, after.run as unknown as Record<string, unknown>, RUN_SNAPSHOT_KEYS)
  const run: RunOp | undefined = rp ? { gen: gens.run, ...rp } : guards.run ? { gen: gens.run } : undefined
  // Only guards: nothing to write (a decision that changes nothing holds on the state it read).
  if (!rp && !ops.some(hasChange)) return undefined
  return run ? { ops, run } : { ops }
}
