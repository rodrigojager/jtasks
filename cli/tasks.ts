#!/usr/bin/env bun
// The `tasks` CLI: the core's tool on the terminal, with the Node host.

import { join } from "node:path"
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
    holdMode: "detach",
    // Where `doctor --fix` copies the OpenCode agents and the skills from.
    packageRoot: join(import.meta.dir, "..").replace(/\\/g, "/"),
    boundRun: process.env.GOAL_TASKS_RUN || undefined,
    stdin: async () => await new Response(Bun.stdin.stream()).text(),
  },
  argv,
)

if (asJson) process.stdout.write(`${JSON.stringify({ ok: result.ok, code: result.code, text: result.text, data: result.data ?? null }, null, 2)}\n`)
else if (result.text) (result.ok ? process.stdout : process.stderr).write(`${result.text}\n`)
process.exitCode = result.code
