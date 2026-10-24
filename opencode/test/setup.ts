// Preloaded before the plugin tests (bunfig.toml): a private GOAL_TASKS_HOME and JLOCK_HOME with short jlock
// timings, removed after the last test.

import { afterAll, setDefaultTimeout } from "bun:test"
import { mkdirSync, readdirSync, rmSync } from "node:fs"

const root = (process.platform === "win32" ? "D:/claude-cache/goal-tasks-tests" : "/tmp/goal-tasks-tests").replace(/\\/g, "/")
const home = `${root}/oc-process-${process.pid}-${Date.now().toString(36)}`
mkdirSync(`${home}/jlock`, { recursive: true })
process.env.GOAL_TASKS_HOME = `${home}/goal-tasks`
process.env.JLOCK_HOME = `${home}/jlock`
process.env.JLOCK_HEARTBEAT_MS = "200"
process.env.JLOCK_STALE_MS = "1500"
process.env.JLOCK_HINTS = "0"
// Tests start real git and jlock processes; on a busy machine 5 s (the default) is not enough.
setDefaultTimeout(60_000)

afterAll(() => {
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(home, { recursive: true, force: true })
      break
    } catch {
      Bun.sleepSync(100)
    }
  }
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
  } catch {}
})
