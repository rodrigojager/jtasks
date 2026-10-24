// The ledger (section 7): every effect the tool leaves outside the task's own code, with how to undo it. One
// `ledger.jsonl` per run and a global index in `<GOAL_TASKS_HOME>/ledger.jsonl`.

import type { Host } from "./host.ts"
import { join, slash } from "./paths.ts"
import { atomicWrite, goalTasksHome } from "./store.ts"
import { tr } from "./i18n.ts"

export type EffectType = "exclude" | "branch" | "commit" | "worktree" | "junction" | "dir" | "archive" | "agent-config" | "install"
export type UndoKind =
  | "remove-line"
  | "git-branch-delete"
  | "git-revert"
  | "rmdir"
  | "unarchive"
  | "agent-config-remove"
  | "remove-file"
  | "none"
export type EffectState = "active" | "undone" | "gone"

export interface Effect {
  id: string
  at: string
  run: string
  task?: string
  type: EffectType
  repo: string
  path?: string
  ref?: string
  line?: string
  branch?: string
  from?: string
  /** For an archive: where the run went. */
  to?: string
  undo: { kind: UndoKind; ref?: string }
  state: EffectState
  /** Set when the effect is undone or found gone. */
  changedAt?: string
  /** For a revert commit: the effect it undid. */
  reverts?: string
}

export type NewEffect = Omit<Effect, "id" | "at" | "state">

export function globalLedger(host: Host): string {
  return join(goalTasksHome(host), "ledger.jsonl")
}

export async function readEffects(host: Host, file: string): Promise<Effect[]> {
  const text = await host.readText(file)
  if (!text) return []
  const out: Effect[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Effect)
    } catch {
      // A torn line from a crash: skipped, the rest is still the truth.
    }
  }
  return out
}

function serialize(effects: Effect[]): string {
  return effects.map((e) => `${JSON.stringify(e)}\n`).join("")
}

/** Appends an effect to the run's ledger and to the global index; returns it with its id. */
export async function recordEffect(host: Host, runDir: string, effect: NewEffect): Promise<Effect> {
  const file = join(runDir, "ledger.jsonl")
  const existing = await readEffects(host, file)
  const max = existing.reduce((m, e) => Math.max(m, Number(e.id.slice(2)) || 0), 0)
  const full: Effect = { id: `e-${String(max + 1).padStart(4, "0")}`, at: host.now().toISOString(), ...effect, state: "active" }
  await host.appendText(file, `${JSON.stringify(full)}\n`)
  await host.appendText(globalLedger(host), `${JSON.stringify(full)}\n`)
  return full
}

/** An effect that belongs to no run (`gc --remove`): written to the global index only, with a `g-` id. */
export async function recordGlobalEffect(host: Host, effect: NewEffect): Promise<Effect> {
  const file = globalLedger(host)
  const existing = (await readEffects(host, file)).filter((e) => e.id.startsWith("g-"))
  const max = existing.reduce((m, e) => Math.max(m, Number(e.id.slice(2)) || 0), 0)
  const full: Effect = { id: `g-${String(max + 1).padStart(4, "0")}`, at: host.now().toISOString(), ...effect, state: "active" }
  await host.appendText(file, `${JSON.stringify(full)}\n`)
  return full
}

/** Changes the state of one effect in both ledgers. */
export async function setEffectState(host: Host, runDir: string, run: string, id: string, state: EffectState): Promise<void> {
  const at = host.now().toISOString()
  for (const file of [join(runDir, "ledger.jsonl"), globalLedger(host)]) {
    const effects = await readEffects(host, file)
    let changed = false
    for (const e of effects)
      if (e.id === id && e.run === run && e.state !== state) {
        e.state = state
        e.changedAt = at
        changed = true
      }
    if (changed) await atomicWrite(host, file, serialize(effects))
  }
}

/** Every effect of the repository (from the global index), of one run, or of every project. */
export async function effectsOf(host: Host, scope: { repo?: string; run?: string }, insensitive: boolean): Promise<Effect[]> {
  const norm = (p: string) => slash(insensitive ? p.toLowerCase() : p).replace(/\/+$/, "")
  const all = await readEffects(host, globalLedger(host))
  return all.filter((e) => (!scope.repo || norm(e.repo) === norm(scope.repo)) && (!scope.run || e.run === scope.run))
}

export function effectLine(e: Effect): string {
  const what =
    e.type === "commit"
      ? `${e.ref}${e.reverts ? ` ${tr("ledger.reverts", { id: e.reverts })}` : ""}`
      : e.type === "branch"
        ? `${e.ref}${e.from ? ` ${tr("ledger.from", { from: e.from })}` : ""}`
        : e.type === "exclude"
          ? `${e.path}: ${e.line}`
          : e.type === "archive"
            ? `${e.path} → ${e.to}`
            : (e.path ?? e.ref ?? "")
  const when = e.at.replace("T", " ").slice(0, 16)
  return `${e.id} · ${e.type} · ${what} · ${e.run}${e.task ? `/${e.task}` : ""} · ${when} · ${e.state}`
}
