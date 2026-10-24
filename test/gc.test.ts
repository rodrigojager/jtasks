import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { readEffects } from "../src/ledger.ts"
import { cleanupTemp, host, makeRepo, sh, tasks, tasksOk, tempDir } from "./helpers.ts"

afterAll(cleanupTemp)

/**
 * A folder with: a repository with a run, a worktree its repository still knows, and an orphan worktree (moved by
 * hand: its repository still lists the old path and does not know this one).
 */
async function playground() {
  const root = tempDir("gc")
  const repo = makeRepo("gc-repo")
  // makeRepo makes its own folder; move the scene under `root` by creating the worktrees there.
  sh(repo, "git", "worktree", "add", "-q", join(root, "wt-known"), "-b", "known-branch")
  sh(repo, "git", "worktree", "add", "-q", join(root, "wt-before"), "-b", "orphan-branch")
  renameSync(join(root, "wt-before"), join(root, "wt-orphan"))
  await tasksOk(repo, ["plan", "--name", "gc-run"], { json: { tasks: [{ id: "T01", title: "a" }], branch: "current" } })
  return { root: root.replace(/\\/g, "/"), repo }
}

describe("gc --scan", () => {
  test("lists the orphan worktree with owner and branch, and touches nothing", async () => {
    const { root, repo } = await playground()
    const r = await tasksOk(repo, ["gc", "--scan", root])
    const findings = (r.data as { findings: { type: string; path: string; owner?: string; branch?: string; known?: boolean; merged?: boolean }[] }).findings
    const orphan = findings.find((f) => f.path.endsWith("/wt-orphan"))!
    expect(orphan).toMatchObject({ type: "worktree", branch: "orphan-branch", known: false, merged: true })
    expect(orphan.owner!.toLowerCase()).toBe(repo.toLowerCase())
    const known = findings.find((f) => f.path.endsWith("/wt-known"))!
    expect(known).toMatchObject({ type: "worktree", branch: "known-branch", known: true })
    expect(r.text).toContain("(o repositório não a conhece: órfã) · branch orphan-branch · integrado em main: sim")
    expect(r.text).toContain("nada foi tocado")
    expect(existsSync(join(root, "wt-orphan"))).toBe(true)
    expect(existsSync(join(root, "wt-known"))).toBe(true)

    // The repository's own run shows up when the scan reaches it.
    const runs = await tasksOk(repo, ["gc", "--scan", repo])
    expect((runs.data as { findings: { type: string; path: string }[] }).findings.map((f) => f.type)).toEqual(["run"])
  })

  test("--remove needs --yes and a path the report lists; then removes and records it", async () => {
    const { root, repo } = await playground()
    const orphan = `${root}/wt-orphan`
    const noYes = await tasks(repo, ["gc", "--remove", orphan])
    expect(noYes.ok).toBe(false)
    expect(noYes.text).toBe(`nada foi removido: confirme com tasks gc --remove ${orphan} --yes`)
    expect(existsSync(orphan)).toBe(true)
    const outside = await tasks(repo, ["gc", "--remove", root, "--yes"])
    expect(outside.text).toContain("não é algo que o relatório do gc lista")
    expect(existsSync(root)).toBe(true)

    const r = await tasksOk(repo, ["gc", "--remove", orphan, "--yes"])
    expect(r.text).toBe(`worktree removida: ${orphan} (pasta removida); registrado no ledger global`)
    expect(existsSync(orphan)).toBe(false)
    const known = `${root}/wt-known`
    await tasksOk(repo, ["gc", "--remove", known, "--yes"])
    expect(existsSync(known)).toBe(false)
    expect(sh(repo, "git", "worktree", "list")).not.toContain("wt-known")
    const global = await readEffects(host, join(process.env.GOAL_TASKS_HOME!, "ledger.jsonl"))
    expect(global.filter((e) => e.run === "gc").map((e) => [e.type, e.path, e.undo.kind])).toEqual([
      ["dir", orphan, "none"],
      ["dir", known, "none"],
    ])
  })

  test("depth limits the walk", async () => {
    const { root, repo } = await playground()
    const r = await tasksOk(repo, ["gc", "--scan", root, "--depth", "0"])
    expect((r.data as { findings: unknown[] }).findings).toEqual([])
  })
})
