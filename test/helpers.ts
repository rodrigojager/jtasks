// Test helpers: temporary folders under D:\claude-cache (removed at the end), and running the CLI.

import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const TEST_ROOT =
  process.env.GOAL_TASKS_TEST_TMP ?? (process.platform === "win32" ? "D:/claude-cache/goal-tasks-tests" : join(tmpdir(), "goal-tasks-tests"))

const made: string[] = []

/** A fresh empty folder; every one is removed by `cleanupTemp`. */
export function tempDir(prefix: string): string {
  const dir = join(TEST_ROOT, `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).replace(/\\/g, "/")
  mkdirSync(dir, { recursive: true })
  made.push(dir)
  return dir
}

export function cleanupTemp() {
  for (const dir of made.splice(0)) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Bun.sleepSync(100)
      }
    }
  }
}

export const REPO_ROOT = join(import.meta.dir, "..").replace(/\\/g, "/")
