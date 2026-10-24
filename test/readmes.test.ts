import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { blocks, LANGS, normalize, planOf, runBlock } from "../scripts/readme-example.ts"
import { REPO_ROOT } from "./helpers.ts"

const read = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8").replace(/\r\n/g, "\n")
const BAR = read("README.md").split("\n").slice(0, 2).join("\n")
const AUTHOR = "Rodrigo Jäger — GitHub <https://github.com/rodrigojager> · LinkedIn <https://www.linkedin.com/in/rodrigojager>"
const headings = (text: string) => text.split("\n").filter((l) => /^## /.test(l)).length
const commands = (text: string) => blocks(text).flatMap((b) => b.steps.map((s) => s.command))

describe("the eleven READMEs", () => {
  test("they all exist, start with the same language bar, and have the same sections, commands and author", () => {
    const en = read("README.md")
    for (const [tag, file] of LANGS) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true)
      const text = read(file)
      expect(text.split("\n").slice(0, 2).join("\n"), `${tag}: language bar`).toBe(BAR)
      expect(headings(text), `${tag}: sections`).toBe(headings(en))
      expect(commands(text), `${tag}: example commands`).toEqual(commands(en))
      expect(planOf(text), `${tag}: the plan of the examples`).toBe(planOf(en))
      expect(text, `${tag}: author`).toContain(AUTHOR)
    }
  })

  test("no relative link is broken", () => {
    for (const [tag, file] of LANGS) {
      const text = read(file)
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1]!
        if (/^[a-z]+:/.test(target)) continue
        expect(existsSync(join(REPO_ROOT, dirname(file), target)), `${tag}: ${target}`).toBe(true)
      }
    }
  })

  test("the five translations without a native reviewer say so, and the Arabic one reads right to left", () => {
    for (const tag of ["zh-CN", "ja", "ru", "ar", "hi"]) expect(read(`README.${tag}.md`), tag).toContain("](CONTRIBUTING.md)")
    const ar = read("README.ar.md")
    expect(ar).toContain('<div dir="rtl">')
    expect(ar).toContain('<div dir="ltr">')
  })

  // Runs the examples for real (git and jlock in temporary folders): the slowest test of the suite.
  test(
    "every example shows what the tool really prints, in the README's language (run ids, hashes and paths aside)",
    () => {
      for (const [tag, file] of LANGS) {
        const text = read(file)
        const plan = planOf(text)
        for (const block of blocks(text)) {
          const real = runBlock(block, plan, tag)
          block.steps.forEach((s, i) => expect(normalize(real[i]!), `${tag}: ${s.command}`).toBe(normalize(s.output)))
        }
      }
    },
    600_000,
  )
})
