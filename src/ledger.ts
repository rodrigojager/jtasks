// The ledger (section 7): every effect the tool leaves outside the task's own code, with how to undo it. One
// `ledger.jsonl` per run and a global index in `<GOAL_TASKS_HOME>/ledger.jsonl`.

import type { Host } from "./host.ts"
import { join } from "./paths.ts"
import { atomicWrite, goalTasksHome } from "./store.ts"

export type EffectType = "exclude" | "branch" | "commit" | "worktree" | "junction" | "dir" | "archive" | "agent-config"
export type UndoKind =
  | "remove-line"
  | "git-branch-delete"
  | "git-revert"
  | "rmdir"
  | "unarchive"
  | "agent-config-remove"
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
