// The frontier (section 4): a task is ready when it is pending, its dependencies are done or skipped, the run is
// not paused and what it holds is free in jlock (by the hierarchy rule and the modes, applied locally to `jlock list`).
//
// What a task holds (0.7.0, jlock 0.3): its files and claims exclusively (an exclusive task: the repository root),
// the resources of its `uses`, and `resource:machine` — shared for every task, exclusive for an exclusive "machine"
// one, which so waits for every jtasks task on the machine and keeps new ones out while it runs. Never `*`.

import { canonical, conflicts, covers, excludes, isPathKey, isResourceKey, mergeSpecs, normalizeKey, normalizeResourceKey, sameFamily, type LockMode, type LockSpec } from "./keys.ts"
import { describeKey, describeOwner, liveHolders, type JlockLock } from "./jlock.ts"
import type { RunFile, Task, TasksFile, WaitingFor } from "./schema.ts"
import { tr } from "./i18n.ts"
import { caseInsensitive } from "./paths.ts"
import { sharedTouched } from "./validate.ts"
import { describeResource, MACHINE } from "./resources.ts"

export interface RunState {
  /** The repository root. */
  root: string
  /** The data folder that holds `runs/` (see workspace.ts). */
  data: string
  dir: string
  run: RunFile
  tasks: TasksFile
  /** The generations the state was read at (ticket 60), when the reader kept them: a decision can insist on them. */
  gens?: { run: number; tasks: Record<string, number> }
}

/** A task's own jlock owner. Everything done on its behalf runs under a child of it (`childOwner`). */
export function ownerOf(run: string, task: string): string {
  return `gt:${run}/${task}`
}

/**
 * The owner of something done on behalf of a task (jlock 0.3 families): `gt:<run>/<task>/<role>-<id>` (`exec`, `tree`).
 * The task's holds never block it, it never blocks the task, and its siblings (two execs of the task) exclude each
 * other as strangers do. Without a task: `gt:<run>/~<role>-<id>`, a sibling of the run's tasks.
 */
export function childOwner(run: string, task: string | undefined, role: string, id: string): string {
  return task ? `${ownerOf(run, task)}/${role}-${id}` : `gt:${run}/~${role}-${id}`
}

/** The scope of an exclusive task, `undefined` when it is not one (`true` from a hand-written file is `project`). */
export function exclusiveScope(task: Pick<Task, "exclusive">): "project" | "machine" | undefined {
  const e = task.exclusive as unknown
  if (!e) return undefined
  return e === "machine" ? "machine" : "project"
}

/** The task's ownership as path keys: its files and claims, or the repository root when exclusive. */
export function pathKeys(root: string, task: Task, platform: string): string[] {
  if (exclusiveScope(task)) return [normalizeKey(root, root, platform)]
  return canonical([...task.files, ...(task.claimed ?? [])].map((f) => normalizeKey(f, root, platform)))
}

/** Everything a task holds while in progress, with modes, in canonical order (see the top of this file). */
export function taskLocks(root: string, task: Task, platform: string): LockSpec[] {
  const specs: LockSpec[] = pathKeys(root, task, platform).map((key) => ({ key, mode: "exclusive" as LockMode }))
  for (const u of task.uses ?? []) specs.push({ key: normalizeResourceKey(`resource:${u.resource}`), mode: u.mode })
  specs.push({ key: MACHINE, mode: exclusiveScope(task) === "machine" ? "exclusive" : "shared" })
  return mergeSpecs(specs)
}

/** The jlock keys of a task (`taskLocks` without the modes). */
export function taskKeys(root: string, task: Task, platform: string): string[] {
  return taskLocks(root, task, platform).map((s) => s.key)
}

/** The specs of some of a task's keys, in the mode the task holds them (a key it does not list: exclusive). */
export function specsOf(root: string, task: Task, platform: string, keys: string[]): LockSpec[] {
  const all = taskLocks(root, task, platform)
  return keys.map((key) => all.find((s) => s.key === key) ?? { key, mode: "exclusive" as LockMode })
}

export type Blocker =
  | { kind: "dependency"; ids: string[] }
  | { kind: "failed"; ids: string[] }
  | { kind: "paused" }
  | { kind: "ownership"; key: string; via: string; owner: string; mode?: LockMode }
  | { kind: "shared"; path: string; task: string }

export interface Assessment {
  task: Task
  ready: boolean
  blockers: Blocker[]
}

/** The first live hold of someone outside `owner`'s family that excludes `spec`: its key, owner and mode. */
export function blockingHold(spec: LockSpec, locks: JlockLock[], owner: string): { key: string; owner: string; mode: LockMode } | undefined {
  for (const l of locks) {
    if (!conflicts(spec.key, l.key)) continue
    for (const h of liveHolders(l)) {
      const mode = h.mode ?? "exclusive"
      if (!sameFamily(h.owner, owner) && excludes(spec, { key: l.key, mode })) return { key: l.key, owner: h.owner, mode }
    }
  }
  return undefined
}

/** Why each pending task is (not) ready. `locks` is what jlock holds now (the whole machine: resources are global). */
export function assess(state: RunState, locks: JlockLock[], platform: string): Assessment[] {
  const byId = new Map(state.tasks.tasks.map((t) => [t.id, t]))
  const out: Assessment[] = []
  for (const task of state.tasks.tasks) {
    if (task.status !== "pending") continue
    const blockers: Blocker[] = []
    const failed = task.dependsOn.filter((d) => byId.get(d)?.status === "failed")
    const open = task.dependsOn.filter((d) => {
      const s = byId.get(d)?.status
      return s !== "done" && s !== "skipped" && s !== "failed"
    })
    if (failed.length) blockers.push({ kind: "failed", ids: failed })
    if (open.length) blockers.push({ kind: "dependency", ids: open })
    if (state.run.status === "paused") blockers.push({ kind: "paused" })
    const mutex = sharedBlocker(state, task, platform)
    if (mutex) blockers.push(mutex)
    const own = ownerOf(state.run.id, task.id)
    for (const spec of taskLocks(state.root, task, platform)) {
      const hit = blockingHold(spec, locks, own)
      if (hit) {
        blockers.push({ kind: "ownership", key: spec.key, via: hit.key, owner: hit.owner, mode: hit.mode })
        break
      }
      // A key a task in progress yielded is still that task's to take back: no new task starts on it meanwhile.
      const reserved = isPathKey(spec.key) ? yieldedKeys(state).find((y) => conflicts(spec.key, y.key)) : undefined
      if (reserved) {
        blockers.push({ kind: "ownership", key: spec.key, via: reserved.key, owner: ownerOf(state.run.id, reserved.task) })
        break
      }
    }
    out.push({ task, ready: blockers.length === 0, blockers })
  }
  return out
}

/** The run's `shared` files a task touches (rev. 5.6): in its `touchesShared`, or overlapping its files and claims. */
export function sharedOf(state: RunState, task: Task, platform: string): string[] {
  return exclusiveScope(task) ? [] : sharedTouched(state.run.shared ?? [], task, caseInsensitive(platform))
}

/**
 * With `sharedPolicy: "serialize"`, the mutex per shared file: a task waits while another task in progress touches a
 * shared file it touches too. The only implementation, used by the frontier (`next`, `status`, the views) and `start`.
 */
export function sharedBlocker(state: RunState, task: Task, platform: string): Blocker | undefined {
  if (state.run.sharedPolicy !== "serialize") return undefined
  const mine = sharedOf(state, task, platform)
  if (!mine.length) return undefined
  for (const other of state.tasks.tasks) {
    if (other.id === task.id || other.status !== "in_progress") continue
    const hit = sharedOf(state, other, platform).find((s) => mine.includes(s))
    if (hit) return { kind: "shared", path: hit, task: other.id }
  }
  return undefined
}

/** The keys the run's tasks in progress gave back with `yield` and wait to take back. */
export function yieldedKeys(state: RunState): { task: string; key: string; path: string }[] {
  return state.tasks.tasks.flatMap((t) => (t.status === "in_progress" ? (t.yielded ?? []).map((y) => ({ task: t.id, key: y.key, path: y.path })) : []))
}

/**
 * The ready tasks that can start together: never two whose holds exclude each other (files, or an exclusive
 * resource both use); an exclusive one goes alone.
 */
export function selectReady(state: RunState, assessments: Assessment[], platform: string, limit = Infinity): Task[] {
  const chosen: Task[] = []
  const taken: LockSpec[] = []
  const serialize = state.run.sharedPolicy === "serialize"
  const sharedTaken: string[] = []
  for (const a of assessments) {
    if (!a.ready || chosen.length >= limit) continue
    const specs = taskLocks(state.root, a.task, platform)
    if (specs.some((s) => taken.some((t) => excludes(s, t)))) continue
    const exclusive = !!exclusiveScope(a.task)
    if (exclusive && chosen.length > 0) continue
    // Two tasks touching the same shared file never start together under `serialize`.
    const shared = serialize ? sharedOf(state, a.task, platform) : []
    if (shared.some((s) => sharedTaken.includes(s))) continue
    chosen.push(a.task)
    taken.push(...specs)
    sharedTaken.push(...shared)
    if (exclusive) break
  }
  return chosen
}

/**
 * In-progress tasks waiting in a jlock queue (a `claim` that was not granted yet), read off `jlock list`: the
 * queued key, who holds what blocks it (the key itself, a folder above or a path inside), and the position.
 */
export function waitingOf(state: RunState, locks: JlockLock[]): Map<string, WaitingFor> {
  const out = new Map<string, WaitingFor>()
  for (const task of state.tasks.tasks) {
    if (task.status !== "in_progress") continue
    const owner = ownerOf(state.run.id, task.id)
    for (const lock of locks) {
      const entry = lock.queue.find((q) => q.owner === owner)
      if (!entry) continue
      const blocking = blockingHold({ key: lock.key, mode: entry.mode ?? "exclusive" }, locks, owner)
      out.set(task.id, {
        key: lock.key,
        holder: blocking?.owner ?? "?",
        position: entry.position,
        via: blocking?.key ?? lock.key,
      })
      break
    }
    // Not in a jlock queue but waiting for what it yielded: who holds it now, if anyone.
    if (!out.has(task.id) && task.yielded?.length) {
      const y = task.yielded[0]!
      const blocking = blockingHold({ key: y.key, mode: "exclusive" }, locks, owner)
      out.set(task.id, { key: y.key, holder: blocking?.owner ?? "", position: 0, via: blocking?.key ?? y.key, yielded: task.yielded.map((x) => x.path) })
    }
  }
  return out
}

/** `⏳ T01: types.ts · posição 1`; `⏳ T01: src/` when a folder above blocks; the file inside otherwise. */
export function waitingText(w: WaitingFor, state: RunState, platform: string): string {
  if (w.yielded) {
    const files = w.yielded.join(", ")
    return w.holder ? tr("frontier.yielded_held", { files, owner: describeOwner(w.holder, state.run.id) }) : tr("frontier.yielded", { files })
  }
  const asked = describeKey(w.key, state.root, platform)
  const via = describeKey(w.via, state.root, platform)
  const shown = w.via === w.key ? asked : covers(w.via, w.key) ? `${via}/` : tr("frontier.inside", { via, asked })
  return tr("frontier.waiting", { owner: describeOwner(w.holder, state.run.id), shown, position: w.position })
}

/** ⛔ T04 · 🔒 T02: src/types.ts (via src) · 🔒 run-b/T01: resource:desktop (exclusive: the real mouse…) · pausada */
export function blockerText(b: Blocker, state: RunState, platform: string): string {
  switch (b.kind) {
    case "failed":
      return tr("frontier.failed_dependency", { ids: b.ids.join(", ") })
    case "dependency":
      return `⛔ ${b.ids.join(", ")}`
    case "paused":
      return tr("view.paused")
    case "shared":
      return tr("frontier.shared", { id: b.task, path: b.path })
    case "ownership": {
      const key = describeKey(b.key, state.root, platform)
      const owner = describeOwner(b.owner, state.run.id)
      if (isResourceKey(b.key)) {
        const description = describeResource(b.key)
        const mode = b.mode ?? "exclusive"
        return description ? tr("frontier.resource", { owner, key, mode, description }) : tr("frontier.resource_bare", { owner, key, mode })
      }
      const via = b.via !== b.key ? ` (via ${describeKey(b.via, state.root, platform)})` : ""
      return `🔒 ${owner}: ${key}${via}`
    }
  }
}
