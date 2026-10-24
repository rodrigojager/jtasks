// The frontier (section 4): a task is ready when it is pending, its dependencies are done or skipped, the run is
// not paused and its ownership is free in jlock (by the hierarchy rule, applied locally to `jlock list`).

import { canonical, conflicts, normalizeKey, ALL } from "./keys.ts"
import { describeKey, describeOwner, type JlockLock } from "./jlock.ts"
import type { RunFile, Task, TasksFile } from "./schema.ts"

export interface RunState {
  root: string
  dir: string
  run: RunFile
  tasks: TasksFile
}

export function ownerOf(run: string, task: string): string {
  return `gt:${run}/${task}`
}

/** The jlock keys of a task's ownership: its files and claims as absolute keys, or `*` when exclusive. */
export function taskKeys(root: string, task: Task, platform: string): string[] {
  if (task.exclusive) return [ALL]
  return canonical([...task.files, ...(task.claimed ?? [])].map((f) => normalizeKey(f, root, platform)))
}

export type Blocker =
  | { kind: "dependency"; ids: string[] }
  | { kind: "failed"; ids: string[] }
  | { kind: "paused" }
  | { kind: "ownership"; key: string; via: string; owner: string }

export interface Assessment {
  task: Task
  ready: boolean
  blockers: Blocker[]
}

/** Why each pending task is (not) ready. `locks` is what jlock holds now (at least under the repository). */
export function assess(state: RunState, locks: JlockLock[], platform: string): Assessment[] {
  const byId = new Map(state.tasks.tasks.map((t) => [t.id, t]))
  // A stale holder is a dead process (no heartbeat, no OS lock): jlock breaks it on the next request.
  const held = locks.filter((l) => l.holder && l.holder.stale !== true)
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
    const own = ownerOf(state.run.id, task.id)
    for (const key of taskKeys(state.root, task, platform)) {
      const lock = held.find((l) => l.holder!.owner !== own && conflicts(key, l.key))
      if (lock) {
        blockers.push({ kind: "ownership", key, via: lock.key, owner: lock.holder!.owner })
        break
      }
    }
    out.push({ task, ready: blockers.length === 0, blockers })
  }
  return out
}

/** The ready tasks that can start together: never two with conflicting ownership; an exclusive one goes alone. */
export function selectReady(state: RunState, assessments: Assessment[], platform: string, limit = Infinity): Task[] {
  const chosen: Task[] = []
  const taken: string[] = []
  for (const a of assessments) {
    if (!a.ready || chosen.length >= limit) continue
    const keys = taskKeys(state.root, a.task, platform)
    if (keys.some((k) => taken.some((t) => conflicts(k, t)))) continue
    if (a.task.exclusive && chosen.length > 0) continue
    chosen.push(a.task)
    taken.push(...keys)
    if (a.task.exclusive) break
  }
  return chosen
}

/** ⛔ T04 · 🔒 T02: src/types.ts (via src) · pausada */
export function blockerText(b: Blocker, state: RunState, platform: string): string {
  switch (b.kind) {
    case "failed":
      return `⛔ ${b.ids.join(", ")} (falha)`
    case "dependency":
      return `⛔ ${b.ids.join(", ")}`
    case "paused":
      return "pausada"
    case "ownership": {
      const key = describeKey(b.key, state.root, platform)
      const via = b.via !== b.key ? ` (via ${describeKey(b.via, state.root, platform)})` : ""
      return `🔒 ${describeOwner(b.owner, state.run.id)}: ${key}${via}`
    }
  }
}
