#!/usr/bin/env bun
// The `tasks` CLI: the core's tool on the terminal, with the Node host.

import { runTool } from "../src/index.ts"
import { createNodeHost } from "../src/node-host.ts"

const argv = process.argv.slice(2)
const asJson = argv.includes("--json")
const host = createNodeHost()

const result = await runTool(
  {
    host,
    cwd: process.cwd(),
    tool: "cli",
    boundRun: process.env.GOAL_TASKS_RUN || undefined,
    stdin: async () => await new Response(Bun.stdin.stream()).text(),
  },
  argv,
)

if (asJson) process.stdout.write(`${JSON.stringify({ ok: result.ok, code: result.code, text: result.text, data: result.data ?? null }, null, 2)}\n`)
else if (result.text) (result.ok ? process.stdout : process.stderr).write(`${result.text}\n`)
process.exitCode = result.code
