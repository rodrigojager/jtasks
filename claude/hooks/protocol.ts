// What the model reads about goal-tasks in Claude Code: the tool's description and the protocol section of the
// system prompt while a run is bound (the protocol text itself is the core's, shared with OpenCode).

import { progressLine, protocolText, readRun, readTasks, runDir, tr, VERSION, type Host } from '../core/core.js'
import type { BoundRun } from '../types'

export const TOOL_NAME = 'tasks'
export const SECTION_ID = 'goal-tasks:protocol'

// What the model reads is English in every language (plan section 21); the answers are in the person's language.
export const TOOL_DESCRIPTION =
  `goal-tasks ${VERSION}: a deterministic task list with dependencies and file ownership (jlock). ` +
  '"command" is the tasks CLI command line without the "tasks" (e.g. "next", "start T04", "claim T04 src/x.ts", ' +
  '"done T04 --evidence \\"bun test: 12 passed\\"", "status", "plan --add"); "json" carries the plan, the batch or ' +
  'the task in JSON (plan, plan --add, plan --fix <id>). "help" lists the actions. Never edit tasks.json, the tickets ' +
  'or git by hand: only through this tool.'

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The tasks command line, without the "tasks": "next", "start T04", "status"…' },
    json: { description: 'A plan, batch or task in JSON, for plan, plan --add and plan --fix.' },
  },
  required: ['command'],
  additionalProperties: false,
}

const SPAWN = "the Agent tool; the prompt starts with --run and --task, and the model comes from the task's profile"

/** The protocol section for a bound run, or undefined when its files are gone. */
export async function protocolSection(host: Host, bound: BoundRun): Promise<string | undefined> {
  const dir = runDir(bound.root, bound.run)
  const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  if (!run || !tasks) return undefined
  const summary = run.status === 'paused' ? `${tr('status.paused')} · ${progressLine(tasks.tasks)}` : progressLine(tasks.tasks)
  return protocolText(run.id, summary, SPAWN)
}
