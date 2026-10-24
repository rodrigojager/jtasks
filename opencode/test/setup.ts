// Preloaded before the plugin tests (bunfig.toml): a private JTASKS_HOME and JLOCK_HOME with short jlock
// timings, removed after the last test.

import { afterAll, setDefaultTimeout } from "bun:test"
import { mkdirSync, readdirSync, rmSync } from "node:fs"

const root = (process.platform === "win32" ? "D:/claude-cache/jtasks-tests" : "/tmp/jtasks-tests").replace(/\\/g, "/")
const home = `${root}/oc-process-${process.pid}-${Date.now().toString(36)}`
mkdirSync(`${home}/jlock`, { recursive: true })
process.env.JTASKS_HOME = `${home}/jtasks`
process.env.JLOCK_HOME = `${home}/jlock`
process.env.JLOCK_HEARTBEAT_MS = "200"
process.env.JLOCK_STALE_MS = "1500"
process.env.JLOCK_HINTS = "0"
// The answers the tests read are the Portuguese ones, whatever the machine speaks.
process.env.JTASKS_LANG = "pt-BR"
delete process.env.JLOCK_LANG
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
