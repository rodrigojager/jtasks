// A "window" for the resume test: a long-lived host (like the OpenCode plugin) that starts a task, keeps its
// `jlock hold` attached, prints one JSON line and then stays alive until the test ends it (by PID, with its tree).
// Usage: bun test/window.ts <repo> <task>

import "../src/index.ts"
import type { Resident } from "../src/host.ts"
import { createNodeHost } from "../src/node-host.ts"
import { runTool } from "../src/tool.ts"

const [repo, task] = process.argv.slice(2)
const residents = new Map<string, Resident[]>()
const r = await runTool({ host: createNodeHost(), cwd: repo!, tool: "opencode", session: "window-1", residents }, ["start", task!])
const pids = [...residents.values()].flat().map((x) => x.pid)
process.stdout.write(`${JSON.stringify({ ok: r.ok, text: r.text, holds: pids })}\n`)
setInterval(() => {}, 1 << 30)
