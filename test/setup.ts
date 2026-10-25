// Preloaded before every test file (bunfig.toml): a private JTASKS_HOME and JLOCK_HOME with short jlock timings
// for the whole test process, so no test touches the real ledger or the real lock registry; both are removed after
// the last test, together with the test root when it is left empty.

import { afterAll, setDefaultTimeout } from "bun:test"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { select } from "../src/i18n.ts"

const root = (
  process.env.JTASKS_TEST_TMP ?? (process.platform === "win32" ? "D:/claude-cache/jtasks-tests" : join(tmpdir(), "jtasks-tests"))
).replace(/\\/g, "/")
const home = `${root}/process-${process.pid}-${Date.now().toString(36)}`

mkdirSync(`${home}/jlock`, { recursive: true })
process.env.JTASKS_HOME = `${home}/jtasks`
process.env.JLOCK_HOME = `${home}/jlock`
process.env.JLOCK_HEARTBEAT_MS = "200"
process.env.JLOCK_STALE_MS = "1500"
process.env.JLOCK_HINTS = "0"
// Tests start real git and jlock processes; on a busy machine 5 s (the default) is not enough.
setDefaultTimeout(60_000)
delete process.env.JTASKS_RUN
// The answers the tests read are the Portuguese ones, whatever the machine speaks (test/i18n.test.ts tries others).
process.env.JTASKS_LANG = "pt-BR"
// Also for the tests that call the core's functions directly, with no command to choose it.
select({ env: (name) => process.env[name] })
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
