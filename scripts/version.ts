// The version of jtasks, in every place that declares it: the package, the core's VERSION (what `jtasks version`,
// `jtasks doctor` and the tool's description say), the Claude Code plugin's manifest (what `/plugin` compares to
// decide whether an update exists), the marketplace's entry when it states one, and the OpenCode plugin's package.
//
//   bun scripts/version.ts            lists them; exits 1 when they differ
//   bun scripts/version.ts --check    the same, quiet when they agree (test/version.test.ts runs it too)
//   bun scripts/version.ts 0.3.0      writes 0.3.0 everywhere, then rebuild (bun scripts/build.ts) and commit
//
// A release bumps it once for everything; `claude plugin update` only sees a new version, never new commits.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..").replace(/\\/g, "/")

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export interface Place {
  /** The file, relative to the repository. */
  file: string
  /** The version it declares, or undefined when it declares none (allowed only where `optional`). */
  read(text: string): string | undefined
  write(text: string, version: string): string
  optional?: boolean
}

const jsonField = (file: string, path: (j: any) => { obj: any; key: string }[], optional = false): Place => ({
  file,
  optional,
  read: (text) => {
    const found = path(JSON.parse(text)).filter(({ obj, key }) => obj && typeof obj[key] === "string")
    const versions = [...new Set(found.map(({ obj, key }) => obj[key] as string))]
    return versions.length > 1 ? versions.join(" / ") : versions[0]
  },
  write: (text, version) => {
    const json = JSON.parse(text)
    for (const { obj, key } of path(json)) if (obj && typeof obj[key] === "string") obj[key] = version
    return `${JSON.stringify(json, null, 2)}\n`
  },
})

export const PLACES: Place[] = [
  jsonField("package.json", (j) => [{ obj: j, key: "version" }]),
  {
    file: "src/tool.ts",
    read: (text) => /export const VERSION = "([^"]+)"/.exec(text)?.[1],
    write: (text, version) => text.replace(/export const VERSION = "[^"]+"/, `export const VERSION = "${version}"`),
  },
  jsonField("claude/.claude-plugin/plugin.json", (j) => [{ obj: j, key: "version" }]),
  // The marketplace may leave the version to plugin.json; when an entry states one, it must be the same.
  jsonField(".claude-plugin/marketplace.json", (j) => [{ obj: j.metadata, key: "version" }, ...(j.plugins ?? []).map((p: unknown) => ({ obj: p, key: "version" }))], true),
  jsonField("opencode/package.json", (j) => [{ obj: j, key: "version" }]),
]

export function versions(): { file: string; version: string | undefined; optional: boolean }[] {
  return PLACES.map((p) => ({ file: p.file, version: p.read(readFileSync(join(root, p.file), "utf8")), optional: !!p.optional }))
}

/** What is wrong with the versions as they are: empty when every place agrees. */
export function problems(): string[] {
  const all = versions()
  const out: string[] = []
  for (const v of all) {
    if (v.version === undefined) {
      if (!v.optional) out.push(`${v.file}: no version`)
    } else if (!SEMVER.test(v.version)) out.push(`${v.file}: "${v.version}" is not a semantic version`)
  }
  const distinct = [...new Set(all.map((v) => v.version).filter((x): x is string => !!x))]
  if (distinct.length > 1) out.push(`the versions differ: ${all.filter((v) => v.version).map((v) => `${v.file}=${v.version}`).join(", ")}`)
  return out
}

export function bump(version: string): string[] {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a semantic version (x.y.z)`)
  const changed: string[] = []
  for (const p of PLACES) {
    const file = join(root, p.file)
    const text = readFileSync(file, "utf8")
    if (p.read(text) === undefined) continue
    const next = p.write(text, version)
    if (next !== text) {
      writeFileSync(file, next)
      changed.push(p.file)
    }
  }
  return changed
}

if (import.meta.main) {
  const arg = process.argv[2]
  if (arg && arg !== "--check") {
    const changed = bump(arg)
    console.log(changed.length ? `${arg}: ${changed.join(", ")}\nnow: bun scripts/build.ts, bun test, then commit` : `already ${arg} everywhere`)
  }
  const bad = problems()
  if (arg !== "--check" || bad.length) for (const v of versions()) console.log(`${v.file.padEnd(36)} ${v.version ?? "(none)"}`)
  for (const p of bad) console.error(p)
  process.exitCode = bad.length ? 1 : 0
}
