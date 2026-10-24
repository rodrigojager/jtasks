import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { join } from "node:path"
import { REPO_ROOT } from "./helpers.ts"

// The demonstration runs the CLI some 30 times with real git and jlock.
setDefaultTimeout(240_000)

describe("demonstration", () => {
  test("scripts/demo.ts goes from plan in batches to restam 0, one commit per task, and undo reverting one", () => {
    const p = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts/demo.ts")], { env: process.env })
    const out = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect(out).toContain("- T01 e T03 tocam src/core.ts e podem rodar juntas: adicione uma dependência ou separe o arquivo")
    expect(out).toContain("T03 corrigida; o rascunho tem 3 tarefa(s)")
    expect(out).toContain("prontas (2) em ")
    expect(out).toMatch(/"owner":"gt:demo-\d{6}-[a-z0-9]{4}\/T01"/)
    expect(out).toMatch(/T02 esperou [\d.]+ s por src\/core\.ts: continua em uso por T01, posição 1 na fila\./)
    expect(out).toMatch(/T02 recebeu src\/core\.ts \(esperou [\d.]+ s\)/)
    expect(out).toContain("feitas 3/3 (100%) · restam 0")
    expect(out).toMatch(/[0-9a-f]{7} T03: Entrada\n[0-9a-f]{7} T02: Tela\n[0-9a-f]{7} T01: Núcleo\n[0-9a-f]{7} init/)
    expect(out).toMatch(/e-0006 · commit · [0-9a-f]{7} · demo-\d{6}-[a-z0-9]{4}\/T03/)
    expect(out).toMatch(/e-0005: revert de [0-9a-f]{7} → commit [0-9a-f]{7}\nT02 → pending/)
    expect(out).toContain('Revert "T02: Tela"')
    expect(out).toMatch(/# removido: .*jtasks-demo-/)
  })
})
