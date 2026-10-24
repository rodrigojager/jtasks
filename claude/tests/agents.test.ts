import { expect, test } from 'claude-code/testing'
import { installMachine, installSession } from './machine.ts'

const ROOT = 'D:/work/repo'
const TOOL = 'mcp__jtasks__jtasks'
const PLAN = {
  serialize: ['bun test'],
  profiles: {
    execute: { claude: { model: 'sonnet', effort: 'medium', role: 'backend-developer' } },
    'execute-deep': { claude: { model: 'opus', effort: 'high' } },
  },
  tasks: [
    { id: 'T01', title: 'Base', files: ['src/a.ts'] },
    { id: 'T02', title: 'Profunda', files: ['src/b.ts'], profile: 'execute-deep' },
  ],
}

async function scene($: any, on: any) {
  const machine = installMachine(on, ROOT)
  installSession(on, ROOT)
  const spawned: { model?: string; prompt: string }[] = []
  const bash: string[] = []
  on('agent.spawn', (_$: unknown, e: { model?: string; prompt: string }) => {
    spawned.push({ model: e.model, prompt: e.prompt })
    return { model: e.model ?? 'inherit', agentId: `agent-${spawned.length}` }
  })
  on('tool.call', (_$: unknown, e: { tool: string; command?: string }) => {
    if (e.tool === 'Bash') bash.push(e.command!)
    return { result: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: TOOL, command: 'plan', json: PLAN })
  const run = /execução (\S+) criada/.exec(String(r.result))![1]!
  const file = `${ROOT}/.scratch/jtasks/runs/${run}/tasks.json`
  return { machine, run, file, spawned, bash }
}

test("a task's subagent runs on its profile's model, with the role and effort in its prompt", async ($, on) => {
  const { run, spawned } = await scene($, on)
  const a = await $.agent.spawn({ prompt: `--run ${run} --task T01 Faça a base.`, description: 'T01', subagentType: 'general-purpose' } as never)
  expect(a.model).toBe('sonnet')
  expect(spawned[0]!.prompt).toBe(`--role backend-developer --run ${run} --task T01 Faça a base.\n\n(Profile execute: effort medium.)`)
  const b = await $.agent.spawn({ prompt: `--run ${run} --task T02 Funda.`, description: 'T02', subagentType: 'general-purpose' } as never)
  expect(b.model).toBe('opus')
  // A subagent of no task is left alone.
  const c = await $.agent.spawn({ prompt: 'Explore the code.', description: 'map', subagentType: 'Explore', model: 'haiku' } as never)
  expect(c.model).toBe('haiku')
  expect(spawned[2]!.prompt).toBe('Explore the code.')
})

test('an unknown profile or task refuses the spawn', async ($, on) => {
  const { machine, run, file } = await scene($, on)
  const tasks = JSON.parse(machine.read(file)!)
  tasks.tasks[1].profile = 'nope'
  machine.write(file, JSON.stringify(tasks))
  const bad = await $.agent.spawn({ prompt: `--run ${run} --task T02 x`, description: 'T02', subagentType: 'general-purpose' } as never)
  expect(bad.deny).toBe('jtasks: perfil desconhecido "nope" (perfis: execute, execute-deep)')
  const none = await $.agent.spawn({ prompt: `--run ${run} --task T09 x`, description: 'T09', subagentType: 'general-purpose' } as never)
  expect(none.deny).toBe(`jtasks: a execução ${run} não tem a tarefa T09`)
})

test("a subagent's serialized command goes through jlock run; others and the main agent's run as they are", async ($, on) => {
  const { run, bash } = await scene($, on)
  await $.agent.spawn({ prompt: `--run ${run} --task T01 x`, description: 'T01', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Bash', command: 'bun test src', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'bun run lint', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'bun test' } as never)
  expect(bash[0]).toBe(
    `jlock run 'name:gt/repo/bun-test' --owner 'gt:${run}/T01-bash' --group '${run}' --intent 'bun test src' -- sh -c 'bun test src'`,
  )
  expect(bash.slice(1)).toEqual(['bun run lint', 'bun test'])
})

test("a subagent that ends with its task in progress gives it back to the queue (log agent-ended)", async ($, on) => {
  const { machine, run, file } = await scene($, on)
  await $.agent.spawn({ prompt: `--run ${run} --task T01 x`, description: 'T01', subagentType: 'general-purpose' } as never)
  const tasks = JSON.parse(machine.read(file)!)
  Object.assign(tasks.tasks[0], { status: 'in_progress', owner: 'claude:session-1/agent:agent-1', attempts: 1 })
  machine.write(file, JSON.stringify(tasks))
  await $.turn.complete({ answer: 'parei', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' } as never)
  expect(JSON.parse(machine.read(file)!).tasks[0]).toMatchObject({ status: 'pending', owner: null })
  const log = machine.read(`${ROOT}/.scratch/jtasks/runs/${run}/log.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l))
  expect(log.at(-1)).toMatchObject({ action: 'agent-ended', task: 'T01', from: 'in_progress', to: 'pending' })
  expect(machine.releases).toContain(`gt:${run}/T01`)
  // A second end of the same agent changes nothing.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-1', reason: 'answer' } as never)
  expect(JSON.parse(machine.read(file)!).tasks[0].status).toBe('pending')
})
