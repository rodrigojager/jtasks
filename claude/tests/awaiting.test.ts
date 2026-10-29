import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

// A subagent whose loop ends while its process runs (rev. 5.8): the task waits for it in progress, with its locks and
// nothing spent; Claude Code reopening the agent ends the wait. Every transition the orchestrator did not ask for
// reaches it at once (a plugin prompt with the status line) and the person (a toast), ready task or not; and every
// notification of a background task carries the status line.
for (const { os, root: ROOT } of ROOTS) {
  const TOOL = 'mcp__jtasks__jtasks'
  const TASKS = [{ id: 'T13', title: 'Descoberta', files: ['src/discovery.ts'] }, { id: 'T14', title: 'Calendário', files: ['src/calendar.ts'], dependsOn: ['T13'] }]

  async function scene($: any, on: any, plan: Record<string, unknown> = {}) {
    const machine = installMachine(on, ROOT)
    const { clock } = installSession(on, ROOT)
    const submitted: string[] = []
    const contexts: (readonly string[] | undefined)[] = []
    const toasts: string[] = []
    const agents: { id: string; status: string; description: string; type: string }[] = []
    on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
      submitted.push(e.text)
      contexts.push(e.context)
      return { text: e.text }
    })
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('agent.list', () => ({ value: agents }))
    let n = 0
    on('agent.spawn', (_$: unknown, e: { model?: string }) => ({ model: e.model ?? 'inherit', agentId: `agent-${++n}` }))
    on('session.messages', () => ({ value: [] }))
    on('ui.toast', (_$: unknown, e: { text: string }) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', () => ({ value: undefined }))
    on('ui.notify', () => ({ value: { isSent: true } }))
    on('tool.call', () => ({ result: 'ok' }))
    on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('classic.StopFailure', () => ({}))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const r = await $.tool.call({ tool: TOOL, command: 'plan', json: { ...plan, tasks: TASKS } })
    const run = /execução (\S+) criada/.exec(String(r.result))![1]!
    const dir = `${ROOT}/.scratch/jtasks/runs/${run}`
    await $.agent.spawn({ prompt: `--run ${run} --task T13 x`, description: 'T13', subagentType: 'general-purpose' } as never)
    agents.push({ id: 'agent-1', status: 'running', description: 'T13', type: 'jtasks:execute' })
    const started = await $.tool.call({ tool: TOOL, command: 'start T13', agentId: 'agent-1' } as never)
    expect(String(started.result)).toContain('T13 em andamento (tentativa 1)')
    const t13 = () => JSON.parse(machine.read(`${dir}/tasks.json`)!).tasks[0]
    const log = () => machine.read(`${dir}/log.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l))
    const runFile = () => JSON.parse(machine.read(`${dir}/run.json`)!)
    const end = (turnId: string) => $.turn.complete({ answer: 'esperando', durationMs: 10, isAborted: false, turnId, agentId: 'agent-1', reason: 'answer' } as never)
    return { machine, clock, run, dir, submitted, contexts, toasts, agents, t13, log, runFile, end }
  }

  test(`a background command left running: the task waits, locks kept, the orchestrator told; the agent's return ends the wait · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.tool.call({ tool: 'Bash', command: 'bun test e2e', run_in_background: true, agentId: 'agent-1' } as never)
    s.agents[0]!.status = 'waiting'
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'in_progress', attempts: 1, owner: 'claude:session-1/agent:agent-1', awaiting: { agent: 'agent-1', host: 'background: bun test e2e' } })
    expect(s.machine.releases).toEqual([])
    expect(s.machine.locks.map((l) => l.owner)).toEqual([`gt:${s.run}/T13`])
    expect(s.log().at(-1)).toMatchObject({ action: 'await', task: 'T13', host: 'background: bun test e2e' })
    await s.clock.settle()
    // The orchestrator hears of it at once (no task is ready: T14 depends on T13), with the status line.
    const message = s.submitted.at(-1)!
    expect(message).toContain(`jtasks: run ${s.run} changed without your asking`)
    expect(message).toContain("T13: its subagent's loop ended while a process it started still runs (background: bun test e2e)")
    expect(message).toContain('Status now: feitas 0/2 (0%) · 1 em andamento · restam 2 · em andamento: T13 (aguardando processo)')
    expect(s.toasts.at(-1)).toBe('jtasks: T13 aguarda o processo (background: bun test e2e); o subagente volta quando ele terminar')
    // The status says it too.
    expect(String((await $.tool.call({ tool: TOOL, command: 'status' })).result)).toContain('aguardando processo: T13 (background: bun test e2e, desde')
    // Claude Code reopens the agent when its background work ends: the wait is over, and it finishes normally.
    s.agents[0]!.status = 'running'
    await $.turn.start({ prompt: 'the background command finished', turnId: 't2', agentId: 'agent-1' } as never)
    expect(s.t13().awaiting).toBeUndefined()
    expect(s.log().at(-1)).toMatchObject({ action: 'await-back', task: 'T13', how: 'turn.start' })
    const done = await $.tool.call({ tool: TOOL, command: 'done T13 --evidence "bun test e2e: 40 passed"', agentId: 'agent-1' } as never)
    expect(String(done.result)).toContain('T13 feita')
  })

  test(`Claude Code's own word (the agent is waiting) keeps the task waiting too · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.agents[0]!.status = 'waiting'
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'in_progress', awaiting: { host: 'Claude Code: the agent waits on background work it owns' } })
    expect(s.machine.releases).toEqual([])
  })

  test(`a process registered with wait ends and the agent does not come back: told to resume it, then it counts as ended · ${os}`, async ($, on) => {
    const s = await scene($, on, { awaitGrace: '1ms' })
    s.machine.alive.add(4242)
    expect(String((await $.tool.call({ tool: TOOL, command: 'wait T13 --pid 4242 --command "bun test"', agentId: 'agent-1' } as never)).result)).toContain('T13 aguarda 4242 (bun test)')
    s.agents[0]!.status = 'completed'
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'in_progress', awaiting: { pids: [4242] } })
    expect(s.log().at(-1)).toMatchObject({ action: 'await', pids: [4242] })
    // Still alive: the clock leaves it alone.
    await s.clock.advance(2000)
    await s.clock.settle()
    expect(s.t13().awaiting.endedAt).toBeUndefined()
    // The process ends: the next pass marks it, and the orchestrator is told to resume the same agent.
    s.machine.alive.delete(4242)
    for (let i = 0; i < 5; i++) {
      await s.clock.advance(2000)
      await s.clock.settle()
    }
    expect(s.log().some((e) => e.action === 'await-ended' && e.task === 'T13')).toBe(true)
    expect(s.submitted.some((m) => m.includes('T13: the process its subagent waited for ended.') && m.includes('SendMessage to agent agent-1'))).toBe(true)
    // It did not come back within awaitGrace: the task goes back to the queue, without spending an attempt.
    for (let i = 0; i < 5; i++) {
      await s.clock.advance(2000)
      await s.clock.settle()
    }
    expect(s.t13()).toMatchObject({ status: 'pending', attempts: 0, agentEnded: 1 })
    expect(s.machine.releases).toContain(`gt:${s.run}/T13`)
    expect(s.submitted.some((m) => m.includes('T13: its subagent did not come back after its process ended: back to pending'))).toBe(true)
  })

  test(`the orchestrator's wait on a task waiting for its subagent's process keeps the wait (T17, fase3) · ${os}`, async ($, on) => {
    const s = await scene($, on, { awaitGrace: '1h' })
    s.machine.alive.add(4242)
    await $.tool.call({ tool: TOOL, command: 'wait T13 --pid 4242 --command "bun test"', agentId: 'agent-1' } as never)
    s.agents[0]!.status = 'completed'
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'in_progress', awaiting: { agent: 'agent-1', pids: [4242] } })
    // The orchestrator (no agentId) declares the same pid 21 s later: the wait goes on, and it is told to keep off.
    const answer = String((await $.tool.call({ tool: TOOL, command: 'wait T13 --pid 4242' })).result)
    expect(answer).toContain('T13 continua aguardando o processo do seu subagente')
    expect(s.t13()).toMatchObject({ status: 'in_progress', awaiting: { agent: 'agent-1', pids: [4242] } })
    expect(s.log().some((e) => e.action === 'await-back')).toBe(false)
    // The process ends: the orchestrator is told to resume that same agent, as for any wait.
    s.machine.alive.delete(4242)
    for (let i = 0; i < 5; i++) {
      await s.clock.advance(2000)
      await s.clock.settle()
    }
    expect(s.submitted.some((m) => m.includes('T13: the process its subagent waited for ended.') && m.includes('SendMessage to agent agent-1'))).toBe(true)
  })

  test(`a task that lost its wait (its agent gone, its process alive) waits again; the end of the process is told · ${os}`, async ($, on) => {
    const s = await scene($, on, { awaitGrace: '1h' })
    s.machine.alive.add(4242)
    await $.tool.call({ tool: TOOL, command: 'wait T13 --pid 4242', agentId: 'agent-1' } as never)
    s.agents[0]!.status = 'completed'
    await s.end('t1')
    // The wait lost as 0.3.2 lost it (someone else's wait cleared it): in progress, no wait, the process alive.
    const file = `${s.dir}/tasks.json`
    const tasks = JSON.parse(s.machine.read(file)!)
    delete tasks.tasks[0].awaiting
    tasks.revision++
    s.machine.write(file, JSON.stringify(tasks))
    for (let i = 0; i < 5; i++) {
      await s.clock.advance(2000)
      await s.clock.settle()
    }
    expect(s.t13()).toMatchObject({ status: 'in_progress', awaiting: { agent: 'agent-1', pids: [4242] } })
    expect(s.log().some((e) => e.action === 'await' && e.how === 'sweep' && e.agent === 'agent-1')).toBe(true)
    s.machine.alive.delete(4242)
    for (let i = 0; i < 5; i++) {
      await s.clock.advance(2000)
      await s.clock.settle()
    }
    expect(s.log().some((e) => e.action === 'await-ended' && e.task === 'T13')).toBe(true)
    expect(s.submitted.some((m) => m.includes('T13: the process its subagent waited for ended.') && m.includes('SendMessage to agent agent-1'))).toBe(true)
    // The agent comes back: the wait the clock put back is over too.
    s.agents[0]!.status = 'running'
    await $.turn.start({ prompt: 'the process ended', turnId: 't2', agentId: 'agent-1' } as never)
    expect(s.t13().awaiting).toBeUndefined()
  })

  test(`the ends of a subagent run out: failed, the run paused for a person, and the orchestrator and the person told at once · ${os}`, async ($, on) => {
    const s = await scene($, on, { maxAgentEnded: 1 })
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'failed', agentEnded: 1 })
    expect(s.runFile()).toMatchObject({ status: 'paused', needsPerson: { task: 'T13', count: 1, max: 1 } })
    await s.clock.settle()
    const message = s.submitted.at(-1)!
    expect(message).toContain('T13: its subagent ended without finishing, 1 times (the run\'s limit 1): T13 failed and the run is paused for a person.')
    expect(message).toContain('The run is paused: do not call jtasks next or start.')
    expect(s.toasts.some((t) => t.includes(`execução ${s.run} pausada: o subagente de T13 terminou 1 vezes sem concluir; precisa de uma pessoa`))).toBe(true)
  })

  test(`a subagent that ends without finishing: back to pending, and the orchestrator told even with nothing ready · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.agents[0]!.status = 'completed'
    await s.end('t1')
    expect(s.t13()).toMatchObject({ status: 'pending', attempts: 0, agentEnded: 1 })
    await s.clock.settle()
    expect(s.submitted.some((m) => m.includes('T13: its subagent ended without finishing: back to pending'))).toBe(true)
    expect(s.toasts.some((t) => t.includes('T13 voltou à fila'))).toBe(true)
  })

  test(`a notification of a background task carries the run's status line · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.prompt.submit({ text: '<task-notification>agent-1 completed</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
    const context = s.contexts.at(-1)
    expect(context?.at(-1)).toBe(`jtasks status of run ${s.run}, read now from tasks.json: feitas 0/2 (0%) · 1 em andamento · restam 2 · em andamento: T13`)
  })
}
