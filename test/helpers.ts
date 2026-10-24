// Test helpers: temporary folders under D:\claude-cache (removed at the end), temporary git repositories, and the
// tool run like the CLI runs it. The private GOAL_TASKS_HOME / JLOCK_HOME come from test/setup.ts.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNodeHost } from "../src/node-host.ts"
import { runTool, type ToolContext, type ToolResult } from "../src/tool.ts"
import "../src/index.ts"

export const TEST_ROOT = (
  process.env.GOAL_TASKS_TEST_TMP ?? (process.platform === "win32" ? "D:/claude-cache/goal-tasks-tests" : join(tmpdir(), "goal-tasks-tests"))
).replace(/\\/g, "/")

const made: string[] = []

/** A fresh empty folder; every one is removed by `cleanupTemp`. */
export function tempDir(prefix: string): string {
  const dir = join(TEST_ROOT, `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).replace(/\\/g, "/")
  mkdirSync(dir, { recursive: true })
  made.push(dir)
  return dir
}

export function removeDir(dir: string) {
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      Bun.sleepSync(100)
    }
  }
}

export function cleanupTemp() {
  for (const dir of made.splice(0)) removeDir(dir)
}

export const REPO_ROOT = join(import.meta.dir, "..").replace(/\\/g, "/")
export const CLI = join(REPO_ROOT, "cli", "tasks.ts").replace(/\\/g, "/")

export function sh(cwd: string, ...argv: string[]): string {
  const p = Bun.spawnSync(argv, { cwd, env: process.env })
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${p.stderr.toString()}${p.stdout.toString()}`)
  return p.stdout.toString()
}

/** A temporary git repository on `main` with one commit. */
export function makeRepo(prefix = "repo", files: Record<string, string> = { "README.md": "# test\n" }): string {
  const dir = tempDir(prefix)
  sh(dir, "git", "init", "-q", "-b", "main")
  sh(dir, "git", "config", "user.email", "test@example.test")
  sh(dir, "git", "config", "user.name", "Test")
  sh(dir, "git", "config", "commit.gpgsign", "false")
  sh(dir, "git", "config", "core.autocrlf", "false")
  writeFiles(dir, files)
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-q", "-m", "init")
  return dir
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, text)
  }
}

export const host = createNodeHost()

export function context(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { host, cwd, tool: "cli", ...extra }
}

/** Runs the tool in `cwd` with a command line, like the CLI does. */
export async function tasks(cwd: string, argv: string[], extra: Partial<ToolContext> = {}): Promise<ToolResult> {
  return runTool(context(cwd, extra), argv)
}

/** Like `tasks`, but fails the test with the tool's text when the result is not ok. */
export async function tasksOk(cwd: string, argv: string[], extra: Partial<ToolContext> = {}): Promise<ToolResult> {
  const r = await tasks(cwd, argv, extra)
  if (!r.ok) throw new Error(`tasks ${argv.join(" ")} failed (${r.code}): ${r.text}`)
  return r
}
