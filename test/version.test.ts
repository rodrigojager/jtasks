// One version everywhere (rev. 5.7): Claude Code's `/plugin` compares plugin.json's version to decide whether an update
// exists, so a release that bumps one manifest and not the others is invisible or wrong. `bun scripts/version.ts <x.y.z>`
// writes them all.

import { describe, expect, test } from "bun:test"
import { problems, versions } from "../scripts/version.ts"
import { VERSION } from "../src/tool.ts"

describe("version", () => {
  test("package.json, the core's VERSION, plugin.json, the marketplace (when it says one) and the OpenCode package agree", () => {
    expect(problems()).toEqual([])
    for (const v of versions()) if (v.version !== undefined) expect(`${v.file}=${v.version}`).toBe(`${v.file}=${VERSION}`)
  })
})
