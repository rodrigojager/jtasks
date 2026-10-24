import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { choose, resolve, select, tags, tr, width } from "../src/i18n.ts"
import type { Host } from "../src/host.ts"
import { cleanupTemp, host, makeRepo, REPO_ROOT, tasks, tasksOk } from "./helpers.ts"

afterAll(cleanupTemp)

const LOCALES = join(REPO_ROOT, "locales")

function catalogs(): [string, Record<string, string>][] {
  return readdirSync(LOCALES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(LOCALES, f), "utf8"))])
}

const markers = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("catalogs", () => {
  test("every catalog has exactly the keys of en.json, with the same {markers}", () => {
    const all = catalogs()
    const en = all.find(([tag]) => tag === "en")![1]
    const keys = Object.keys(en).filter((k) => k !== "_glossary").sort()
    expect(keys.length).toBeGreaterThan(200)
    for (const [tag, cat] of all) {
      expect(Object.keys(cat).filter((k) => k !== "_glossary").sort(), tag).toEqual(keys)
      for (const k of keys) expect(markers(cat[k]!), `${tag} ${k}`).toEqual(markers(en[k]!))
      expect(cat._glossary, tag).toBeObject()
    }
    expect(all.map(([tag]) => tag).sort()).toEqual([...tags()].sort())
  })

  test("no human text is left in the code: no accented letter outside comments in src/, cli/, the mod and the plugin", () => {
    const offenders: string[] = []
    for (const dir of ["src", "cli", "claude/hooks", "opencode", "opencode/src"])
      for (const name of readdirSync(join(REPO_ROOT, dir)).filter((n) => /\.tsx?$/.test(n))) {
        readFileSync(join(REPO_ROOT, dir, name), "utf8")
          .split("\n")
          .forEach((line, i) => {
            const s = line.trim()
            if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return
            if (/[À-ÖØ-öø-ÿ]/.test(line.replace(/\/\/.*$/, ""))) offenders.push(`${dir}/${name}:${i + 1}`)
          })
      }
    expect(offenders).toEqual([])
  })
})

describe("choosing the language", () => {
  test("--lang > JTASKS_LANG > JLOCK_LANG > the system > English; tags resolve like jlock's", () => {
    const env = (vars: Record<string, string>) => (name: string) => vars[name]
    expect(choose({ lang: "en", env: env({ JTASKS_LANG: "pt-BR" }) })).toEqual({ tag: "en", source: "--lang" })
    expect(choose({ env: env({ JTASKS_LANG: "pt", JLOCK_LANG: "en" }) })).toEqual({ tag: "pt-BR", source: "JTASKS_LANG" })
    expect(choose({ env: env({ JLOCK_LANG: "pt_BR.UTF-8" }) })).toEqual({ tag: "pt-BR", source: "JLOCK_LANG" })
    expect(choose({ env: env({}), system: "pt-PT" })).toEqual({ tag: "pt-BR", source: "system" })
    expect(choose({ env: env({}), system: "xx-YY" })).toEqual({ tag: "en", source: "default" })
    expect(resolve("EN_us")).toBe("en")
    expect(resolve("klingon")).toBeUndefined()
  })

  test("an unknown --lang falls back to English with a warning in English", () => {
    const c = choose({ lang: "klingon", env: () => "pt-BR" })
    expect(c.tag).toBe("en")
    expect(c.warning).toBe(`unknown language "klingon" (available: ${tags().join(", ")}); using English`)
  })

  test("plural forms and markers", () => {
    select({ lang: "pt-BR" })
    expect(tr("progress.skipped", { n: 1 })).toBe("1 pulada")
    expect(tr("progress.skipped", { n: 2 })).toBe("2 puladas")
    select({ lang: "en" })
    expect(tr("progress.remaining", { n: 0 })).toBe("0 left")
    expect(tr("no.such.key")).toBe("no.such.key")
    select({ lang: "pt-BR" })
  })
})

describe("the same command in two languages", () => {
  test("next with --lang en and with pt-BR: different text, the same --json data", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan"], { json: [{ id: "T01", title: "Base", files: ["src/a.ts"] }] })
    const en = await tasksOk(repo, ["next", "--lang", "en"])
    const pt = await tasksOk(repo, ["next"])
    expect(en.text).toContain("ready (1) in ")
    expect(en.text).toContain("T01 · Base · profile implement · ownership: src/a.ts")
    expect(pt.text).toContain("prontas (1) em ")
    expect(en.data).toEqual(pt.data)
    const unknown = await tasks(repo, ["status", "--lang", "klingon"])
    expect(unknown.text.split("\n")[0]).toMatch(/^unknown language "klingon"/)
    expect(unknown.text).toContain("done 0/1 (0%) · 1 left")
  })

  test("every jlock the tool starts gets JLOCK_LANG in the tool's language", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan"], { json: [{ id: "T01", title: "Base", files: ["src/a.ts"] }] })
    const seen: string[] = []
    const recording: Host = {
      ...host,
      run: (argv, options) => {
        if (argv[0] === "jlock") seen.push(`${argv[1]} ${options?.env?.JLOCK_LANG}`)
        return host.run(argv, options)
      },
    }
    await tasksOk(repo, ["status", "--lang", "en"], { host: recording })
    await tasksOk(repo, ["status"], { host: recording })
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen)).toEqual(new Set(["list en", "list pt-BR"]))
  })

  test("help next in each of the eleven languages: exit 0, no raw key, within 100 columns (wide characters count two)", async () => {
    const repo = makeRepo()
    expect(tags()).toEqual(["en", "pt-BR", "es", "fr", "de", "it", "zh-CN", "ja", "ru", "ar", "hi"])
    const seen = new Set<string>()
    for (const lang of tags()) {
      const r = await tasksOk(repo, ["help", "next", "--lang", lang])
      expect(r.code).toBe(0)
      expect(r.text, lang).not.toMatch(/\bhelp\.[a-z]/)
      for (const line of r.text.split("\n")) expect(width(line), `${lang}: ${line}`).toBeLessThanOrEqual(100)
      seen.add(r.text)
    }
    expect(seen.size).toBe(tags().length)
  })

  test("help and help <action> in every language, every line within 100 columns", async () => {
    const repo = makeRepo()
    for (const lang of tags()) {
      const all = await tasksOk(repo, ["help", "--lang", lang])
      for (const line of all.text.split("\n")) expect(width(line), `${lang}: ${line}`).toBeLessThanOrEqual(100)
      const one = await tasksOk(repo, ["help", "claim", "--lang", lang])
      expect(one.text.split("\n").filter((l) => l.trim().startsWith("claim"))).toHaveLength(1)
      expect(one.text).not.toContain("start <id>")
    }
    expect((await tasksOk(repo, ["help", "--lang", "en"])).text).toContain("--lang <tag>: the language of the answers")
    expect((await tasksOk(repo, ["plan", "--help", "--lang", "en"])).text).toContain("plan --draft")
    expect((await tasks(repo, ["help", "nope"])).code).toBe(2)
  })
})
