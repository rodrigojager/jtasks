import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

// Transient failures (rev. 5.7): a subagent dead on a usage limit pauses the run with its task kept in progress and
// its locks held; the way back tells the orchestrator to resume the same agent. Any other API error goes on as before.
for (const { os, root: ROOT } of ROOTS) {
  const TOOL = 'mcp__jtasks__jtasks'
  const PLAN = { tasks: [{ id: 'T13', title: 'Descoberta', files: ['src/discovery.ts'] }, { id: 'T14', title: 'Calendário', files: ['src/calendar.ts'] }] }

  async function scene($: any, on: any) {
    const machine = installMachine(on, ROOT)
    const { clock } = installSession(on, ROOT)
    const submitted: string[] = []
    const toasts: string[] = []
    const statuses: (string | undefined)[] = []
    on('prompt.submit', (_$: unknown, e: { text: string }) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('agent.list', () => ({ value: [] }))
    let n = 0
    on('agent.spawn', (_$: unknown, e: { model?: string }) => ({ model: e.model ?? 'inherit', agentId: `agent-${++n}` }))
    on('session.messages', () => ({ value: [] }))
    on('ui.toast', (_$: unknown, e: { text: string }) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', (_$: unknown, e: { text: string | undefined }) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('ui.notify', () => ({ value: { isSent: true } }))
    on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('classic.StopFailure', () => ({}))
    on('classic.Notification', () => ({}))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const r = await $.tool.call({ tool: TOOL, command: 'plan', json: PLAN })
    const run = /execução (\S+) criada/.exec(String(r.result))![1]!
    const dir = `${ROOT}/.scratch/jtasks/runs/${run}`
    const file = `${dir}/tasks.json`
    await $.agent.spawn({ prompt: `--run ${run} --task T13 x`, description: 'T13', subagentType: 'general-purpose' } as never)
    const tasks = JSON.parse(machine.read(file)!)
    Object.assign(tasks.tasks[0], { status: 'in_progress', owner: 'claude:session-1/agent:agent-1', attempts: 1 })
    machine.write(file, JSON.stringify(tasks))
    const log = () => machine.read(`${dir}/log.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l))
    const runFile = () => JSON.parse(machine.read(`${dir}/run.json`)!)
    return { machine, clock, run, dir, file, submitted, toasts, statuses, log, runFile }
  }

  test(`a subagent dead on a session limit: the run pauses, T13 stays in progress with its locks, no new agent for it · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: '429', last_assistant_message: "API Error: You've hit your session limit · resets 12:50am", agent_id: 'agent-1' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'error' } as never)
    expect(JSON.parse(s.machine.read(s.file)!).tasks[0]).toMatchObject({ status: 'in_progress', owner: 'claude:session-1/agent:agent-1' })
    expect(s.machine.releases).toEqual([])
    const run = s.runFile()
    expect(run.status).toBe('paused')
    expect(run.pause).toMatchObject({ kind: 'quota', tasks: [{ id: 'T13', agent: 'agent-1' }] })
    expect(typeof run.pause.resetAt).toBe('string')
    expect(s.log().at(-1)).toMatchObject({ action: 'auto-pause', kind: 'quota', task: 'T13', kept: ['T13'] })
    expect(s.toasts.at(-1)).toContain('pausada por uma falha transitória do provedor (limite de uso ou cota')
    // The protocol says to wait and keep T13.
    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
    expect(JSON.stringify(composed)).toContain('The run is paused by a transient failure of the provider (quota')
    // A second subagent for T13 is refused: the same one is resumed.
    const again = await $.agent.spawn({ prompt: `--run ${s.run} --task T13 x`, description: 'T13', subagentType: 'general-purpose' } as never)
    expect(String((again as { deny?: string }).deny)).toContain('SendMessage')
    // The status says why and what it kept.
    const status = await $.tool.call({ tool: TOOL, command: 'status' })
    expect(String(status.result)).toContain('falha transitória (limite de uso ou cota')
    // unpause: active again, and the answer names the agent to resume.
    const back = await $.tool.call({ tool: TOOL, command: 'unpause' })
    expect(String(back.result)).toContain('SendMessage to agent agent-1')
    expect(s.runFile().status).toBe('active')
    expect(s.runFile().pause).toBeUndefined()
    // The same agent resumed (its loop starts again) and ending normally later is an ordinary end.
    await $.turn.start({ prompt: 'continue', turnId: 'a2', agentId: 'agent-1' } as never)
    await $.turn.complete({ answer: 'parei', durationMs: 10, isAborted: false, turnId: 'a2', agentId: 'agent-1', reason: 'answer' } as never)
    expect(JSON.parse(s.machine.read(s.file)!).tasks[0].status).toBe('pending')
  })

  test(`an API error that is not transient gives the task back as before · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.classic.StopFailure({ error: 'authentication_failed', last_assistant_message: 'API Error: 401 · Please run /login', agent_id: 'agent-1' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'error' } as never)
    expect(JSON.parse(s.machine.read(s.file)!).tasks[0]).toMatchObject({ status: 'pending', owner: null })
    expect(s.runFile().status).toBe('active')
    expect(s.log().at(-1)).toMatchObject({ action: 'agent-ended', task: 'T13' })
  })

  test(`the orchestrator itself on an overloaded API: paused, and no "stopped after an error" notice · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.classic.StopFailure({ error: 'overloaded', last_assistant_message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'error' } as never)
    await s.clock.settle()
    expect(s.runFile()).toMatchObject({ status: 'paused', pause: { kind: 'overloaded', tasks: [{ id: 'T13', agent: 'agent-1' }] } })
    expect(s.machine.exists(`${s.dir}/keepalive.json`)).toBe(false)
    expect(s.submitted).toEqual([])
    expect(s.toasts.some((t) => t.includes('parou num erro'))).toBe(false)
  })

  test(`the clock reaches resumeAt: the run resumes by itself and the orchestrator is told to resume the same agent · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached', agent_id: 'agent-1' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'error' } as never)
    const run = s.runFile()
    expect(run.status).toBe('paused')
    run.pause.resumeAt = new Date(Date.now() - 1000).toISOString()
    s.machine.write(`${s.dir}/run.json`, JSON.stringify(run))
    await s.clock.advance(2000)
    await s.clock.settle()
    expect(s.runFile().status).toBe('active')
    expect(s.submitted.length).toBe(1)
    expect(s.submitted[0]).toContain('T13 is still in progress with its locks and claims. Resume the same subagent (SendMessage to agent agent-1)')
    expect(s.log().some((l) => l.action === 'auto-resume')).toBe(true)
    expect(s.runFile().pauseStreak).toMatchObject({ n: 1 })
  })

  test(`Claude Code's quota_auto_resume_fired ends a pause for a limit at once · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Claude AI usage limit reached', agent_id: 'agent-1' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'error' } as never)
    expect(s.runFile().status).toBe('paused')
    await $.classic.Notification({ message: 'Continuing', notification_type: 'quota_auto_resume_fired' } as never)
    await s.clock.settle()
    expect(s.runFile().status).toBe('active')
    expect(s.submitted.at(-1)).toContain('SendMessage to agent agent-1')
  })

  test(`a StopFailure that comes after the subagent's end still pauses the run (its task went back already) · ${os}`, async ($, on) => {
    const s = await scene($, on)
    const ended = $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'error' } as never)
    await s.clock.advance(2000)
    await ended
    expect(JSON.parse(s.machine.read(s.file)!).tasks[0].status).toBe('pending')
    await $.classic.StopFailure({ error: 'overloaded', last_assistant_message: 'API Error: Overloaded', agent_id: 'agent-1' } as never)
    await s.clock.settle()
    expect(s.runFile()).toMatchObject({ status: 'paused', pause: { kind: 'overloaded' } })
  })
}
