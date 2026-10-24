// jlock keys and their conflict rule, applied locally exactly as jlock applies it: two path keys conflict when
// they are equal or one is a folder above the other; `*` conflicts with everything; `name:` only with the same
// name. Path keys are absolute, use `/`, have no trailing `/`, and are lower case on Windows and macOS.

import { caseInsensitive, isAbsolute, join, normalize } from "./paths.ts"

export const ALL = "*"

export function isNameKey(key: string): boolean {
  return key.startsWith("name:")
}

/** Normalizes a key the way jlock does; a relative path is resolved against `base`. */
export function normalizeKey(raw: string, base: string, platform: string): string {
  if (raw === ALL || isNameKey(raw)) return raw
  const abs = isAbsolute(raw) ? normalize(raw) : join(base, raw)
  let key = abs.replace(/\/+$/, "")
  if (/^[A-Za-z]:$/.test(key)) key += "/"
  return caseInsensitive(platform) ? key.toLowerCase() : key
}

/** True when `inner` is `outer` or lies inside the folder `outer`. Both already normalized. */
export function covers(outer: string, inner: string): boolean {
  if (outer === inner) return true
  const prefix = outer.endsWith("/") ? outer : `${outer}/`
  return inner.startsWith(prefix)
}

/** True when the two normalized keys conflict. */
export function conflicts(a: string, b: string): boolean {
  if (a === ALL || b === ALL) return true
  if (isNameKey(a) || isNameKey(b)) return a === b
  return covers(a, b) || covers(b, a)
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
