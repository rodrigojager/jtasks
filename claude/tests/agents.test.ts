import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

for (const { os, root: ROOT } of ROOTS) {
  const TOOL = 'mcp__jtasks__jtasks'
  const PLAN = {
    serialize: ['bun test'],
    profiles: {
      execute: { claude: { agent: 'jtasks:execute', model: 'sonnet', effort: 'medium', role: 'backend-developer' } },
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
    const spawned: { model?: string; prompt: string; subagentType?: string }[] = []
    const bash: string[] = []
    on('agent.spawn', (_$: unknown, e: { model?: string; prompt: string; subagentType?: string }) => {
      spawned.push({ model: e.model, prompt: e.prompt, subagentType: e.subagentType })
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

  test(`a task's subagent becomes its profile's agent, on its model, with the role in its prompt · ${os}`, async ($, on) => {
    const { run, spawned } = await scene($, on)
    const a = await $.agent.spawn({ prompt: `--run ${run} --task T01 Faça a base.`, description: 'T01', subagentType: 'general-purpose' } as never)
    expect(a.model).toBe('sonnet')
    expect(spawned[0]!.subagentType).toBe('jtasks:execute')
    expect(spawned[0]!.prompt).toBe(`--role backend-developer --run ${run} --task T01 Faça a base.`)
    const b = await $.agent.spawn({ prompt: `--run ${run} --task T02 Funda.`, description: 'T02', subagentType: 'general-purpose' } as never)
    expect(b.model).toBe('opus')
    // A profile that names no agent keeps the type the call asked for.
    expect(spawned[1]!.subagentType).toBe('general-purpose')
    // A subagent of no task is left alone.
    const c = await $.agent.spawn({ prompt: 'Explore the code.', description: 'map', subagentType: 'Explore', model: 'haiku' } as never)
    expect(c.model).toBe('haiku')
    expect(spawned[2]!.prompt).toBe('Explore the code.')
    expect(spawned[2]!.subagentType).toBe('Explore')
  })

  test(`every model request of a task's subagent carries its profile's effort; others keep theirs · ${os}`, async ($, on) => {
    const efforts: { agentId?: string; effort?: unknown }[] = []
    on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; agentId?: string; effort?: unknown }) {
      efforts.push({ agentId: e.agentId, effort: e.effort })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    const { run } = await scene($, on)
    await $.agent.spawn({ prompt: `--run ${run} --task T01 x`, description: 'T01', subagentType: 'general-purpose' } as never)
    await $.agent.spawn({ prompt: `--run ${run} --task T02 y`, description: 'T02', subagentType: 'general-purpose' } as never)
    const step = async (agentId: string | undefined, effort: string | undefined) => {
      const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, ...(agentId ? { agentId } : {}), ...(effort ? { effort } : {}) } as never)
      for await (const _ of stream as AsyncIterable<unknown>) void _
    }
    await step('agent-1', 'xhigh')
    await step('agent-2', 'low')
    await step(undefined, 'low')
    await step('agent-3', 'low')
    // A model without effort is sent none.
    await step('agent-1', undefined)
    expect(efforts).toEqual([
      { agentId: 'agent-1', effort: 'medium' },
      { agentId: 'agent-2', effort: 'high' },
      { agentId: undefined, effort: 'low' },
      { agentId: 'agent-3', effort: 'low' },
      { agentId: 'agent-1', effort: undefined },
    ])
  })

  test(`an unknown profile or task refuses the spawn · ${os}`, async ($, on) => {
    const { machine, run, file } = await scene($, on)
    const tasks = JSON.parse(machine.read(file)!)
    tasks.tasks[1].profile = 'nope'
    machine.write(file, JSON.stringify(tasks))
    const bad = await $.agent.spawn({ prompt: `--run ${run} --task T02 x`, description: 'T02', subagentType: 'general-purpose' } as never)
    expect(bad.deny).toBe('jtasks: perfil desconhecido "nope" (perfis: execute, execute-deep)')
    const none = await $.agent.spawn({ prompt: `--run ${run} --task T09 x`, description: 'T09', subagentType: 'general-purpose' } as never)
    expect(none.deny).toBe(`jtasks: a execução ${run} não tem a tarefa T09`)
  })

  test(`a subagent's serialized command goes through jlock run; others and the main agent's run as they are · ${os}`, async ($, on) => {
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

  test(`a subagent that ends with its task in progress gives it back to the queue (log agent-ended) · ${os}`, async ($, on) => {
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

  test(`the holds of this session's tasks are taken again when they expire (every minute); others' are left alone · ${os}`, async ($, on) => {
    const machine = installMachine(on, ROOT)
    const { clock } = installSession(on, ROOT)
    on('agent.spawn', (_$: unknown, e: { model?: string }) => ({ model: e.model ?? 'inherit', agentId: 'agent-1' }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.status', () => ({ value: undefined }))
    on('command.run', (_$: unknown, e: unknown) => e as never)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const r = await $.tool.call({ tool: 'mcp__jtasks__jtasks', command: 'plan', json: PLAN })
    const run = /execução (\S+) criada/.exec(String(r.result))![1]!
    // The pane closed: a minute of its 120 ms spinner is not what this test is about.
    await $.command.run({ command: 'jtasks', args: '' } as never)
    await $.agent.spawn({ prompt: `--run ${run} --task T01 x`, description: 'T01', subagentType: 'general-purpose' } as never)
    await $.tool.call({ tool: 'mcp__jtasks__jtasks', command: 'start T01', agentId: 'agent-1' } as never)
    expect(machine.locks.map((l) => l.owner)).toEqual([`gt:${run}/T01`])
    // The ttl ran out: jlock no longer has it.
    machine.locks.splice(0)
    const holds = () => machine.commands.filter((c) => c.startsWith('jlock hold')).length
    const before = holds()
    await clock.advance(60_000)
    expect(holds()).toBe(before + 1)
    expect(machine.commands.filter((c) => c.startsWith('jlock hold')).at(-1)).toContain('--no-wait')
    expect(machine.locks.map((l) => l.owner)).toEqual([`gt:${run}/T01`])
    const log = machine.read(`${ROOT}/.scratch/jtasks/runs/${run}/log.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l).action)
    expect(log).toContain('retake')
    // A task another session started is not this one's to renew.
    const file = `${ROOT}/.scratch/jtasks/runs/${run}/tasks.json`
    const tasks = JSON.parse(machine.read(file)!)
    tasks.tasks[0].owner = 'claude:other-session'
    machine.write(file, JSON.stringify(tasks))
    machine.locks.splice(0)
    await clock.advance(60_000)
    expect(holds()).toBe(before + 1)
  })
}
