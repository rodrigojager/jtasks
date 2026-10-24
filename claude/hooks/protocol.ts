// What the model reads about goal-tasks in Claude Code: the tool's description and the protocol section of the
// system prompt while a run is bound (the protocol text itself is the core's, shared with OpenCode).

import { progressLine, protocolText, readRun, readTasks, runDir, VERSION, type Host } from '../core/core.js'
import type { BoundRun } from '../types'

export const TOOL_NAME = 'tasks'
export const SECTION_ID = 'goal-tasks:protocol'

export const TOOL_DESCRIPTION =
  `goal-tasks ${VERSION}: lista de tarefas determinística com dependências e posse de arquivos (jlock). ` +
  '"command" é a linha de comando do CLI tasks sem o "tasks" (ex.: "next", "start T04", "claim T04 src/x.ts", ' +
  '"done T04 --evidence \\"bun test: 12 passed\\"", "status", "plan --add"); "json" leva o plano, o lote ou a ' +
  'tarefa em JSON (plan, plan --add, plan --fix <id>). "help" lista as ações. Nunca edite tasks.json, tickets ou ' +
  'o git à mão: só por esta ferramenta.'

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'A linha de comando do tasks, sem o "tasks": "next", "start T04", "status"…' },
    json: { description: 'Plano, lote ou tarefa em JSON, para plan, plan --add e plan --fix.' },
  },
  required: ['command'],
  additionalProperties: false,
}

const SPAWN = 'ferramenta Agent; o prompt começa com --run e --task, e o modelo vem do perfil da tarefa'

/** The protocol section for a bound run, or undefined when its files are gone. */
export async function protocolSection(host: Host, bound: BoundRun): Promise<string | undefined> {
  const dir = runDir(bound.root, bound.run)
  const [run, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  if (!run || !tasks) return undefined
  const summary = run.status === 'paused' ? `pausada: não inicie tarefas · ${progressLine(tasks.tasks)}` : progressLine(tasks.tasks)
  return protocolText(run.id, summary, SPAWN)
}
