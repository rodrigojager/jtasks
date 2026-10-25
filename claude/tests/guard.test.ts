import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

for (const { os, root: ROOT } of ROOTS) {
  const TOOL = 'mcp__jtasks__jtasks'
  const PLAN = {
    tasks: [
      { id: 'T01', title: 'Base', files: ['src/a.ts', 'src/lib'] },
      { id: 'T02', title: 'Junta', dependsOn: ['T01'], files: ['src/b.ts'] },
    ],
  }

  /** A bound run whose T01 is in progress, worked on by subagent `agent-1`. */
  async function scene($: any, on: any) {
    const machine = installMachine(on, ROOT)
    installSession(on, ROOT)
    const ran: { tool: string; command?: string }[] = []
    on('tool.call', (_$: unknown, e: { tool: string; command?: string }) => {
      ran.push({ tool: e.tool, command: e.command })
      return { result: 'ok' }
    })
    on('agent.spawn', (_$: unknown, e: { model?: string }) => ({ model: e.model ?? 'inherit', agentId: 'agent-1' }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const r = await $.tool.call({ tool: TOOL, command: 'plan', json: PLAN })
    const run = /execução (\S+) criada/.exec(String(r.result))![1]!
    const file = `${ROOT}/.scratch/jtasks/runs/${run}/tasks.json`
    const tasks = JSON.parse(machine.read(file)!)
    Object.assign(tasks.tasks[0], { status: 'in_progress', owner: 'claude:session-1/agent:agent-1', attempts: 1 })
    machine.write(file, JSON.stringify(tasks))
    await $.agent.spawn({ prompt: `--run ${run} --task T01 Faça a base.`, description: 'T01', subagentType: 'general-purpose' } as never)
    return { machine, run, ran, file }
  }

  const edit = (file_path: string, agentId?: string) => ({
    tool: 'Edit',
    file_path,
    old_string: 'a',
    new_string: 'b',
    ...(agentId ? { agentId } : {}),
  })

  test(`a subagent edits inside its ownership; outside it is refused with the plan message · ${os}`, async ($, on) => {
    const { ran } = await scene($, on)
    const inside = await $.tool.call(edit(`${ROOT}/src/a.ts`, 'agent-1') as never)
    expect(inside.deny).toBeUndefined()
    expect((await $.tool.call(edit(`${ROOT}/src/lib/x.ts`, 'agent-1') as never)).deny).toBeUndefined()
    const outside = await $.tool.call(edit(`${ROOT}/src/other.ts`, 'agent-1') as never)
    expect(outside.deny).toContain("jtasks: ")
    expect(outside.deny).toContain('jtasks: fora da posse de T01: src/other.ts; use jtasks claim T01 src/other.ts')
    const write = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: 'x', agentId: 'agent-1' } as never)
    expect(write.deny).toContain('fora da posse de T01: README.md')
    expect(ran.filter((c) => c.tool === 'Edit')).toHaveLength(2)
  })

  test(`git that changes the repository is refused to a subagent; reading and testing are free; the main agent is free · ${os}`, async ($, on) => {
    await scene($, on)
    const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -am "x"', agentId: 'agent-1' } as never)
    expect(commit.deny).toContain("jtasks: ")
    expect(commit.deny).toContain('subagente não roda git commit: o commit é feito por jtasks done T01')
    expect((await $.tool.call({ tool: 'Bash', command: 'echo x > src/other.ts', agentId: 'agent-1' } as never)).deny).toContain("jtasks: ")
    expect((await $.tool.call({ tool: 'Bash', command: 'git status && bun test', agentId: 'agent-1' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'git commit -am "x"' } as never)).deny).toBeUndefined()
    expect((await $.tool.call(edit(`${ROOT}/src/other.ts`) as never)).deny).toBeUndefined()
  })

  test(`nobody edits the run's own files by hand · ${os}`, async ($, on) => {
    const { file } = await scene($, on)
    const main = await $.tool.call(edit(file) as never)
    expect(main.deny).toContain("jtasks: ")
    expect(main.deny).toContain('tasks.json, run.json e os tickets só mudam pela ferramenta tasks')
    expect((await $.tool.call(edit(file, 'agent-1') as never)).deny).toContain("jtasks: ")
  })
}
