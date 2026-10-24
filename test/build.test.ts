import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildAll, stale } from "../scripts/build.ts"
import { REPO_ROOT } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

describe("versioned bundles", () => {
  test("every generated file matches a fresh build (run bun scripts/build.ts)", async () => {
    expect(await stale()).toEqual([])
  })

  test("core.js has no Node imports and no require", async () => {
    const core = (await buildAll()).find((b) => b.out === "dist/core.js")!.text
    expect(core).not.toMatch(/from\s+["']node:/)
    expect(core).not.toContain("require(")
  })

  test("the core sources import nothing from node: or packages (only each other and the catalogs in locales/)", () => {
    const dir = join(REPO_ROOT, "src")
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "node-host.ts") continue
      const text = readFileSync(join(dir, name), "utf8")
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!)
      for (const spec of imports) expect(`${name}: ${spec}`).toMatch(/: (\.\/|\.\.\/locales\/[\w-]+\.json$)/)
    }
  })
})
