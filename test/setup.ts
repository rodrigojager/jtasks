// Preloaded before every test file (bunfig.toml): a private GOAL_TASKS_HOME and JLOCK_HOME with short jlock timings
// for the whole test process, so no test touches the real ledger or the real lock registry; both are removed after
// the last test, together with the test root when it is left empty.

import { afterAll, setDefaultTimeout } from "bun:test"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = (
  process.env.GOAL_TASKS_TEST_TMP ?? (process.platform === "win32" ? "D:/claude-cache/goal-tasks-tests" : join(tmpdir(), "goal-tasks-tests"))
).replace(/\\/g, "/")
const home = `${root}/process-${process.pid}-${Date.now().toString(36)}`

mkdirSync(`${home}/jlock`, { recursive: true })
process.env.GOAL_TASKS_HOME = `${home}/goal-tasks`
process.env.JLOCK_HOME = `${home}/jlock`
process.env.JLOCK_HEARTBEAT_MS = "200"
process.env.JLOCK_STALE_MS = "1500"
process.env.JLOCK_HINTS = "0"
// Tests start real git and jlock processes; on a busy machine 5 s (the default) is not enough.
setDefaultTimeout(60_000)
delete process.env.GOAL_TASKS_RUN
// The answers the tests read are the Portuguese ones, whatever the machine speaks (test/i18n.test.ts tries others).
process.env.GOAL_TASKS_LANG = "pt-BR"
delete process.env.JLOCK_LANG

function remove(dir: string) {
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      Bun.sleepSync(100)
    }
  }
}

afterAll(() => {
  remove(home)
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
  } catch {}
})
