// jlock keys and their conflict rule, applied locally exactly as jlock applies it: two path keys conflict when
// they are equal or one is a folder above the other; `*` conflicts with everything; `name:` only with the same
// name; `resource:` only with the same resource and argument (jlock 0.3). Path keys are absolute, use `/`, have no
// trailing `/`, and are lower case on Windows and macOS. Every hold has a mode (jlock 0.3): two shared holds of
// conflicting keys coexist, an exclusive one conflicts with any other. Owners are paths (`gt:<run>/<task>/exec-1`):
// an owner, its ancestors and its descendants never block each other.

import { caseInsensitive, isAbsolute, join, normalize } from "./paths.ts"

export const ALL = "*"

export type LockMode = "shared" | "exclusive"

/** A key with the mode it is (or is to be) held in. */
export interface LockSpec {
  key: string
  mode: LockMode
}

export function isNameKey(key: string): boolean {
  return key.startsWith("name:")
}

export function isResourceKey(key: string): boolean {
  return key.startsWith("resource:")
}

/** A path key: neither `*`, `name:` nor `resource:`. */
export function isPathKey(key: string): boolean {
  return key !== ALL && !isNameKey(key) && !isResourceKey(key)
}

/** `resource:Port:08080` → `resource:port:8080`, as jlock normalizes it (the name folded to lower case). */
export function normalizeResourceKey(raw: string): string {
  const rest = raw.slice("resource:".length)
  const colon = rest.indexOf(":")
  const name = (colon < 0 ? rest : rest.slice(0, colon)).toLowerCase()
  if (colon < 0) return `resource:${name}`
  let arg = rest.slice(colon + 1)
  if (name === "port" && /^\d+$/.test(arg)) arg = String(Number(arg))
  return `resource:${name}:${arg}`
}

/** Normalizes a key the way jlock does; a relative path is resolved against `base`. */
export function normalizeKey(raw: string, base: string, platform: string): string {
  if (raw === ALL || isNameKey(raw)) return raw
  if (isResourceKey(raw)) return normalizeResourceKey(raw)
  const abs = isAbsolute(raw) ? normalize(raw) : join(base, raw)
  let key = abs.replace(/\/+$/, "")
  if (/^[A-Za-z]:$/.test(key)) key += "/"
  return caseInsensitive(platform) ? key.toLowerCase() : key
}

/** True when `inner` is `outer` or lies inside the folder `outer`. Both already normalized. */
export function covers(outer: string, inner: string): boolean {
  if (outer === inner) return true
  if (!isPathKey(outer) || !isPathKey(inner)) return false
  const prefix = outer.endsWith("/") ? outer : `${outer}/`
  return inner.startsWith(prefix)
}

/** True when the two normalized keys conflict, whatever the modes. */
export function conflicts(a: string, b: string): boolean {
  if (a === ALL || b === ALL) return true
  if (!isPathKey(a) || !isPathKey(b)) return a === b
  return covers(a, b) || covers(b, a)
}

/** True when two holds exclude each other: conflicting keys and at least one of them exclusive. */
export function excludes(a: LockSpec, b: LockSpec): boolean {
  return (a.mode === "exclusive" || b.mode === "exclusive") && conflicts(a.key, b.key)
}

/** True when `a` and `b` are the same owner, or one is an ancestor of the other (`gt:r/T1` and `gt:r/T1/exec-2`). */
export function sameFamily(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** `key@shared` / `key@exclusive`: how a spec is passed to jlock. */
export function specArg(spec: LockSpec): string {
  return `${spec.key}@${spec.mode}`
}

/** One spec per key, in the stronger mode when a key comes twice, in canonical order. */
export function mergeSpecs(specs: Iterable<LockSpec>): LockSpec[] {
  const out = new Map<string, LockMode>()
  for (const s of specs) out.set(s.key, out.get(s.key) === "exclusive" || s.mode === "exclusive" ? "exclusive" : "shared")
  return [...out.keys()].sort().map((key) => ({ key, mode: out.get(key)! }))
}

export interface KeyConflict {
  /** The key we asked about. */
  key: string
  /** The key that blocks it: the same key, a folder above, a path inside, or `*`. */
  via: string
}

/** The first of `held` that conflicts with `key`, with the blocking key as `via`. */
export function firstConflict(key: string, held: Iterable<string>): KeyConflict | undefined {
  for (const other of held) if (conflicts(key, other)) return { key, via: other }
  return undefined
}

/** Sorted and without duplicates: the canonical order jlock also uses for several keys. */
export function canonical(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort()
}

/**
 * Relative ownership paths (`src`, `src/a.ts`) compared with the same hierarchy rule, for plan validation. Both
 * already normalized relative paths; case-insensitive on request.
 */
export function relConflicts(a: string, b: string, insensitive: boolean): boolean {
  const x = insensitive ? a.toLowerCase() : a
  const y = insensitive ? b.toLowerCase() : b
  if (x === "." || y === ".") return true
  return covers(x, y) || covers(y, x)
}
