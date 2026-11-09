// The `resource:` keys of jlock 0.3 a task declares in `uses` (desktop, clipboard, port:8080, …): the catalogue,
// read from `jlock resources --json` (the built-in names plus the user's own, described in the tool's language), with
// the built-in list as the fallback when jlock cannot answer (validate never needs jlock). Names are checked here
// with jlock's rules, so a typo is refused at plan time with the closest name instead of failing at `start`.

import type { Host } from "./host.ts"
import type { LockMode, LockSpec } from "./keys.ts"
import { jlockBin, jlockEnv } from "./jlock.ts"
import { tr } from "./i18n.ts"

export interface ResourceDef {
  name: string
  /** The argument's label (`n` for `port:<n>`), or null for a resource without one. */
  arg: string | null
  /** The mode a request that names none gets. */
  mode: LockMode
  description: string
  source: "builtin" | "user"
}

/** jlock 0.3's built-in catalogue, with its English descriptions: what is used when jlock cannot be asked. */
export const BUILTIN_RESOURCES: readonly ResourceDef[] = [
  { name: "audio", arg: null, mode: "exclusive", description: "the speakers and the microphone (playing or recording sound)", source: "builtin" },
  { name: "browser", arg: null, mode: "exclusive", description: "the user's own browser profile and its logged-in sessions", source: "builtin" },
  { name: "clipboard", arg: null, mode: "exclusive", description: "the system clipboard", source: "builtin" },
  { name: "desktop", arg: null, mode: "exclusive", description: "the real mouse, keyboard and windows of the desktop session", source: "builtin" },
  { name: "gpu", arg: null, mode: "exclusive", description: "the graphics card", source: "builtin" },
  {
    name: "machine",
    arg: null,
    mode: "exclusive",
    description: "the whole machine: exclusive asks for it quiet (benchmarks, timing tests); shared says a job loads it",
    source: "builtin",
  },
  { name: "network", arg: null, mode: "exclusive", description: "the network link (big transfers, network-sensitive tests)", source: "builtin" },
  { name: "port", arg: "n", mode: "exclusive", description: "a TCP or UDP port of this machine, by number (resource:port:8080)", source: "builtin" },
]

/** The resource every task holds shared, and an exclusive "machine" task holds exclusive. */
export const MACHINE = "resource:machine"

let last: readonly ResourceDef[] = BUILTIN_RESOURCES
const loaded = new Map<string, Promise<readonly ResourceDef[]>>()

/**
 * The catalogue, from `jlock resources --json` once per process (per executable and language); the built-in list
 * when jlock is missing or answers something else. Never throws.
 */
export function loadResources(host: Host): Promise<readonly ResourceDef[]> {
  const env = jlockEnv()
  const id = `${jlockBin(host)}|${env.JLOCK_LANG}`
  let pending = loaded.get(id)
  if (!pending) {
    pending = host
      .run([jlockBin(host), "resources", "--json"], { env })
      .then((r) => {
        if (r.code !== 0) return BUILTIN_RESOURCES
        const parsed = JSON.parse(r.stdout) as { resources?: Partial<ResourceDef>[] }
        const list = (parsed.resources ?? [])
          .filter((d) => typeof d.name === "string")
          .map((d) => ({
            name: d.name!,
            arg: typeof d.arg === "string" ? d.arg : null,
            mode: d.mode === "shared" ? ("shared" as const) : ("exclusive" as const),
            description: typeof d.description === "string" ? d.description : "",
            source: d.source === "user" ? ("user" as const) : ("builtin" as const),
          }))
        return list.length ? list : BUILTIN_RESOURCES
      })
      .catch(() => BUILTIN_RESOURCES)
      .then((list) => {
        last = list
        return list
      })
    loaded.set(id, pending)
  }
  // The catalogue of this language becomes the one the synchronous texts use, also when it came from the cache.
  return pending.then((list) => {
    last = list
    return list
  })
}

/** The catalogue last loaded in this process (the built-in one before any load): for the synchronous texts. */
export function knownResources(): readonly ResourceDef[] {
  return last
}

/** What a `resource:` key stands for, in the catalogue's words (`resource:port:8080` → the port's description). */
export function describeResource(key: string, catalog: readonly ResourceDef[] = last): string | undefined {
  if (!key.startsWith("resource:")) return undefined
  const name = key.slice("resource:".length).split(":")[0]
  return catalog.find((d) => d.name === name)?.description || undefined
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = here
    }
  }
  return row[b.length]!
}

/** The closest name of the catalogue, when it is close enough to be a typo (or a prefix of it). */
export function suggestResource(name: string, catalog: readonly ResourceDef[] = last): string | undefined {
  let best: { name: string; d: number } | undefined
  for (const def of catalog) {
    const d = def.name.startsWith(name) || name.startsWith(def.name) ? 1 : distance(name, def.name)
    if (!best || d < best.d) best = { name: def.name, d }
  }
  if (!best) return undefined
  return best.d <= Math.max(2, Math.floor(best.name.length / 3)) ? best.name : undefined
}

/** One entry of a task's `uses` as the planner wrote it: `"desktop"`, `"port:8080"`, `{ resource, mode }`. */
export type UseInput = string | { resource: string; mode?: LockMode }

/**
 * Checks one `uses` entry against the catalogue: the normalized spec (`resource:port:8080`, mode from the entry or
 * the resource's default), or the error for the model that wrote it (`id` names the task).
 */
export function checkUse(id: string, entry: UseInput, catalog: readonly ResourceDef[] = last): { spec?: LockSpec; error?: string } {
  const raw = (typeof entry === "string" ? entry : entry.resource).trim().replace(/^resource:/i, "")
  const colon = raw.indexOf(":")
  const name = (colon < 0 ? raw : raw.slice(0, colon)).toLowerCase()
  const arg = colon < 0 ? undefined : raw.slice(colon + 1)
  const def = catalog.find((d) => d.name === name)
  if (!def) {
    const near = suggestResource(name, catalog)
    const hint = near ? tr("plan.resource_suggest", { name: near }) : tr("plan.resource_list")
    return { error: tr("plan.unknown_resource", { id, name: raw, hint }) }
  }
  if (def.arg && (arg === undefined || arg === "")) return { error: tr("plan.resource_arg_missing", { id, name, arg: def.arg }) }
  if (!def.arg && arg !== undefined) return { error: tr("plan.resource_arg_extra", { id, name }) }
  let value = arg
  if (name === "port" && arg !== undefined) {
    const n = /^\d+$/.test(arg) ? Number(arg) : NaN
    if (!(n >= 1 && n <= 65535)) return { error: tr("plan.resource_port", { id, value: arg }) }
    value = String(n)
  }
  const mode = typeof entry === "object" && entry.mode ? entry.mode : def.mode
  return { spec: { key: value === undefined ? `resource:${name}` : `resource:${name}:${value}`, mode } }
}

/** A task's `uses` as people read it: `desktop, machine (shared)`; a non-validated entry as written. */
export function usesText(uses: readonly (string | { resource: string; mode?: LockMode })[] | undefined): string {
  return (uses ?? []).map((u) => (typeof u === "string" ? u : `${u.resource}${u.mode === "shared" ? " (shared)" : ""}`)).join(", ")
}

/** ` + uses: desktop` after a task's ownership in one-line listings; empty without `uses`. */
export function usesSuffix(uses: readonly (string | { resource: string; mode?: LockMode })[] | undefined): string {
  return uses?.length ? ` + uses: ${usesText(uses)}` : ""
}

/** `resource:port:8080` → `port:8080`: how a resource is written in a plan and shown in a ticket. */
export function resourceName(key: string): string {
  return key.replace(/^resource:/, "")
}
