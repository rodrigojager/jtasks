// Text in the person's language (plan section 21): catalogs embedded from `locales/<tag>.json`, chosen by
// `--lang` > GOAL_TASKS_LANG > JLOCK_LANG > the system's language > English. English is the reference and the
// fallback for any missing key. Only human text goes through here: `--json`, the files of a run, ids, action and
// option names, and what the model reads (the protocol, the tool's description) stay the same in every language.

import en from "../locales/en.json"
import ptBR from "../locales/pt-BR.json"

type Catalog = Record<string, unknown>

/** Every catalog, by tag. English first: it is the reference. Other tags reach a catalog through `resolve`. */
export const CATALOGS: readonly (readonly [string, Catalog])[] = [
  ["en", en],
  ["pt-BR", ptBR],
]

let current = "en"

/** The language of this command (`en` until `select` ran). */
export function lang(): string {
  return current
}

export function tags(): string[] {
  return CATALOGS.map(([tag]) => tag)
}

/** `pt_BR.UTF-8`, `pt-br`, `PT` → the catalog tag that serves it: the exact tag first, then the primary language. */
export function resolve(input: string): string | undefined {
  const tag = (input.split(/[.@]/)[0] ?? "").trim().replace(/_/g, "-")
  if (!tag) return undefined
  const primary = (t: string) => (t.split("-")[0] ?? "").toLowerCase()
  const exact = CATALOGS.find(([t]) => t.toLowerCase() === tag.toLowerCase())
  return (exact ?? CATALOGS.find(([t]) => primary(t) === primary(tag)))?.[0]
}

/** The system's language as the runtime reports it (`Intl`), or undefined. */
export function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

export interface LanguageChoice {
  tag: string
  source: "--lang" | "GOAL_TASKS_LANG" | "JLOCK_LANG" | "system" | "default"
  /** Set when `--lang` named a language without a catalog (in English: the reader may not read the other). */
  warning?: string
}

export interface LanguageInputs {
  lang?: string
  env?: (name: string) => string | undefined
  system?: string
}

/** Which language a command speaks, and why. */
export function choose(inputs: LanguageInputs): LanguageChoice {
  let warning: string | undefined
  if (inputs.lang) {
    const tag = resolve(inputs.lang)
    if (tag) return { tag, source: "--lang" }
    warning = `unknown language "${inputs.lang}" (available: ${tags().join(", ")}); using English`
  }
  for (const name of ["GOAL_TASKS_LANG", "JLOCK_LANG"] as const) {
    const value = inputs.env?.(name)
    const tag = value ? resolve(value) : undefined
    if (tag && !warning) return { tag, source: name }
  }
  const tag = !warning && inputs.system ? resolve(inputs.system) : undefined
  if (tag) return { tag, source: "system" }
  return warning ? { tag: "en", source: "default", warning } : { tag: "en", source: "default" }
}

/** Chooses the language and makes it the current one. */
export function select(inputs: LanguageInputs): LanguageChoice {
  const choice = choose(inputs)
  current = choice.tag
  return choice
}

function catalog(tag: string): Catalog {
  return CATALOGS.find(([t]) => t === tag)?.[1] ?? en
}

function lookup(cat: Catalog, key: string, n: unknown): string | undefined {
  if (typeof n === "number") {
    const plural = cat[`${key}_${n === 1 ? "one" : "other"}`]
    if (typeof plural === "string") return plural
  }
  const text = cat[key]
  return typeof text === "string" ? text : undefined
}

/**
 * The text of `key` in the current language, `{name}` markers filled from `params`. With a numeric `n`, the
 * `key_one` / `key_other` forms are used when the catalog has them. A key no catalog has comes back as itself.
 */
export function tr(key: string, params: Record<string, string | number> = {}): string {
  const text = lookup(catalog(current), key, params.n) ?? lookup(en, key, params.n) ?? key
  return text.replace(/\{(\w+)\}/g, (marker, name: string) => (name in params ? String(params[name]) : marker))
}

/** Columns a text takes in a terminal: wide characters (CJK, fullwidth forms) count as two. */
export function width(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}
