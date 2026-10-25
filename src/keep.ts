// A task's edits kept aside (plan rev. 5.6). When a task gives files back, by `yield` (some keys, the task goes on)
// or by a release (the whole ownership: release, agent-ended, resume, lost, fail, skip), the uncommitted edit of each
// of its files is saved as a patch of the run and the file goes back to HEAD, so no other task's commit takes it and
// nothing blocks another task's `done`. The patch comes back when the file is the task's again (a claim, the yielded
// key retaken, or the next start). Everything goes through the ledger, with undo.

import { ownerOf, taskKeys, type RunState } from "./frontier.ts"
import { status as gitStatus } from "./git.ts"
import type { Host } from "./host.ts"
import { jlockList } from "./jlock.ts"
import { ALL, conflicts, covers, normalizeKey } from "./keys.ts"
import { recordEffect } from "./ledger.ts"
import { appliedPath, applyPatch, nextPatchNumber, patchRel, restoreFile, writePatch } from "./patches.ts"
import { caseInsensitive, join } from "./paths.ts"
import type { SavedPatch, Task } from "./schema.ts"
import { SCRATCH } from "./store.ts"

const HOLDING = new Set(["start", "claim", "renew", "retake", "reclaim"])

interface LogLine {
  at?: string
  action?: string
  task?: string
  keys?: unknown
  uncommitted?: unknown
  chain?: unknown
  files?: unknown
}

export async function readLog(host: Host, dir: string): Promise<LogLine[]> {
  const text = (await host.readText(join(dir, "log.jsonl")).catch(() => undefined)) ?? ""
  const out: LogLine[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogLine)
    } catch {
      // A torn line: skipped.
    }
  }
  return out
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/**
 * The keys another task of the run took since this task last held them (its start, claim, renew, retake or reclaim),
 * read off the run's log: taking them back, or touching their files, would mix that task's edits with this one's.
 */
export async function takenSince(host: Host, dir: string, task: string, keys: string[]): Promise<string[]> {
  let since = ""
  const others: { at: string; keys: string[] }[] = []
  for (const e of await readLog(host, dir)) {
    if (!e.at || !e.action || !HOLDING.has(e.action)) continue
    if (e.task === task) since = e.at > since ? e.at : since
    else others.push({ at: e.at, keys: strings(e.keys) })
  }
  return keys.filter((k) => others.some((o) => o.at >= since && o.keys.some((x) => conflicts(x, k))))
}

/** The task's keys as paths: `*` (an exclusive task) is the repository root. */
export function ownKeys(state: RunState, task: Task, platform: string): string[] {
  return task.exclusive ? [normalizeKey(state.root, state.root, platform)] : taskKeys(state.root, task, platform)
}

/** The task's changed files (relative), from `git status`, inside the given keys; the run's own folder never counts. */
export async function changedUnder(host: Host, state: RunState, keys: string[]): Promise<string[]> {
  const out: string[] = []
  for (const e of await gitStatus(host, state.root)) {
    if (e.path.startsWith(`${SCRATCH}/`) || e.path === SCRATCH) continue
    const key = normalizeKey(e.path, state.root, host.platform)
    if (keys.some((k) => covers(k, key)) && !out.includes(e.path)) out.push(e.path)
  }
  return out
}

/**
 * Which of the task's changed files are still its own to put back to HEAD: the key that covers the file is held by
 * the task in jlock, or free and taken by no other task since. A file whose key someone else holds now (it expired
 * and another owner took it) is `untouched`: never put back, never saved.
 */
export async function ownFiles(host: Host, state: RunState, task: Task, files: string[]): Promise<{ mine: string[]; untouched: string[] }> {
  const keys = ownKeys(state, task, host.platform)
  const owner = ownerOf(state.run.id, task.id)
  const locks = files.length ? await jlockList(host, task.exclusive ? {} : { under: state.root }) : []
  const live = locks.filter((l) => l.holder && l.holder.stale !== true)
  const held = (key: string, l: { key: string }) => l.key === key || (l.key === ALL && task.exclusive)
  const out = { mine: [] as string[], untouched: [] as string[] }
  for (const file of files) {
    const fileKey = normalizeKey(file, state.root, host.platform)
    const key = keys.find((k) => covers(k, fileKey))
    const foreign = live.some((l) => l.holder!.owner !== owner && conflicts(l.key, fileKey))
    const ours = key && live.some((l) => held(key, l) && l.holder!.owner === owner)
    if (!key || foreign || (!ours && (await takenSince(host, state.dir, task.id, [key])).length)) out.untouched.push(file)
    else out.mine.push(file)
  }
  return out
}

export interface KeepReport {
  /** Edits saved now, as patches. */
  saved: SavedPatch[]
  /** Files that could not be saved: left on disk as they were. */
  kept: string[]
}

/**
 * Saves the edit of each file as a patch of the run and puts the file back to HEAD, with a `patch` and a `restore`
 * effect each. Adds the patches to `task.patches` (the caller writes tasks.json). A file whose patch cannot be made is
 * left as it is (`kept`).
 */
export async function keepEdits(host: Host, state: RunState, task: Task, files: string[], by: SavedPatch["by"]): Promise<KeepReport> {
  const report: KeepReport = { saved: [], kept: [] }
  for (const file of files) {
    const n = await nextPatchNumber(host, state.dir, task.id, task.patches)
    const rel = patchRel(task.id, n, file)
    const abs = join(state.dir, rel)
    try {
      if (!(await writePatch(host, state.root, file, abs))) continue
    } catch {
      await host.remove(abs).catch(() => {})
      report.kept.push(file)
      continue
    }
    const base = { run: state.run.id, task: task.id, repo: state.root, path: file, patch: abs }
    await recordEffect(host, state.dir, { ...base, type: "patch", undo: { kind: "remove-file" } })
    try {
      await restoreFile(host, state.root, file)
    } catch {
      report.kept.push(file)
      continue
    }
    await recordEffect(host, state.dir, { ...base, type: "restore", undo: { kind: "apply-patch" } })
    const saved: SavedPatch = { file, patch: rel, at: host.now().toISOString(), by }
    task.patches = [...(task.patches ?? []), saved]
    report.saved.push(saved)
  }
  return report
}

export interface ReapplyReport {
  /** Files whose edit came back cleanly (or was in the tree already). */
  applied: string[]
  /** Files left with conflict markers; their patch stays in `patches/`. */
  conflicts: { file: string; patch: string }[]
  /** Patches that did not apply at all (nothing changed); they stay saved for the next try. */
  failed: { file: string; patch: string; message: string }[]
}

export function emptyReapply(): ReapplyReport {
  return { applied: [], conflicts: [], failed: [] }
}

/**
 * Reapplies the task's saved patches that `which` picks, over the current HEAD (`git apply --3way`), with a `reapply`
 * effect each; a clean one moves to `patches/<task>/applied/`. Takes the reapplied (or conflicted) ones out of
 * `task.patches`; the caller writes tasks.json.
 */
export async function reapplyPatches(host: Host, state: RunState, task: Task, which: (p: SavedPatch) => boolean): Promise<ReapplyReport> {
  const report = emptyReapply()
  const left: SavedPatch[] = []
  for (const p of task.patches ?? []) {
    if (!which(p)) {
      left.push(p)
      continue
    }
    const abs = join(state.dir, p.patch)
    if (!(await host.stat(abs))) continue
    const { result, message } = await applyPatch(host, state.root, abs, [p.file])
    if (result === "failed") {
      report.failed.push({ file: p.file, patch: abs, message })
      left.push(p)
      continue
    }
    let at = abs
    if (result !== "conflict") {
      at = appliedPath(abs)
      await host.mkdir(join(at, ".."))
      await host.rename(abs, at)
      report.applied.push(p.file)
    } else report.conflicts.push({ file: p.file, patch: abs })
    if (result !== "already")
      await recordEffect(host, state.dir, { run: state.run.id, task: task.id, type: "reapply", repo: state.root, path: p.file, patch: at, undo: { kind: "reverse-patch" } })
  }
  if (left.length) task.patches = left
  else delete task.patches
  return report
}

/** The patches of `task` whose file is covered by one of `keys` (absolute jlock keys). */
export function patchesUnder(state: RunState, platform: string, keys: string[]): (p: SavedPatch) => boolean {
  return (p) => keys.some((k) => covers(k, normalizeKey(p.file, state.root, platform)))
}

/**
 * The keys of `owner` that close a deadlock cycle, read off jlock's chain
 * (`gt:r/T05 → /p/a (held by gt:r/T04) → gt:r/T04 → /p/c (held by gt:r/T05) → gt:r/T05`): the ones held by it.
 */
export function chainKeys(chain: string, owner: string): string[] {
  const out: string[] = []
  for (const part of chain.split(" → ")) {
    const m = /^(.*) \(held by (.+)\)$/.exec(part.trim())
    if (m && m[2] === owner && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

/** The chain of the task's last claim refused for a deadlock, from the run's log. */
export async function lastDeadlock(host: Host, dir: string, task: string): Promise<string | undefined> {
  let chain: string | undefined
  for (const e of await readLog(host, dir)) if (e.action === "claim-deadlock" && e.task === task && typeof e.chain === "string") chain = e.chain
  return chain
}

/** The release-like actions whose log line lists the edits a task left on disk (`uncommitted`). */
const RELEASING = new Set(["release", "agent-ended", "resume-release", "lost", "fail", "skip"])

/**
 * Edits a released task left on disk (the fallback when they could not be kept as patches, or a run from before
 * rev. 5.6): file → task, from the `uncommitted` of each task's last release in the log, unless some task took the
 * file afterwards. Only tasks that are not in progress count.
 */
export async function releasedEdits(host: Host, state: RunState): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const running = new Set(state.tasks.tasks.filter((t) => t.status === "in_progress").map((t) => t.id))
  const insensitive = caseInsensitive(host.platform)
  const keyOf = (f: string) => normalizeKey(f, state.root, host.platform)
  for (const e of await readLog(host, state.dir)) {
    if (!e.action) continue
    if (RELEASING.has(e.action) && e.task && !running.has(e.task)) {
      for (const [f, t] of out) if (t === e.task) out.delete(f)
      for (const f of strings(e.uncommitted)) out.set(insensitive ? f.toLowerCase() : f, e.task)
    } else if (HOLDING.has(e.action)) {
      const keys = strings(e.keys)
      for (const f of [...out.keys()]) if (keys.some((k) => covers(k, keyOf(f)))) out.delete(f)
    }
  }
  return out
}
