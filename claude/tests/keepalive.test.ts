import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

for (const { os, root: ROOT } of ROOTS) {
  const TOOL = 'mcp__jtasks__jtasks'
  const PLAN = {
    tasks: [
      { id: 'T07', title: 'Formulário', files: ['src/form.ts'] },
      { id: 'T08', title: 'Máscara de PII', files: ['src/pii.ts'], dependsOn: ['T07'] },
    ],
  }

  async function scene($: any, on: any, interactive = true) {
    const machine = installMachine(on, ROOT)
    const { clock } = installSession(on, ROOT)
    const submitted: string[] = []
    const toasts: string[] = []
    const statuses: (string | undefined)[] = []
    const notes: string[] = []
    const box = { draft: '' }
    const agents: { id: string; status: string }[] = []
    /** From the `after`-th call of $.agent.list on, a subagent someone started meanwhile is alive. */
    const late = { after: Infinity, calls: 0 }
    // The engine beneath the mod: what reaches it is what entered the session (a drop above never gets here).
    on('prompt.submit', (_$: unknown, e: { text: string }) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('prompt.read', () => ({ value: { text: box.draft, cursor: box.draft.length } }))
    on('agent.list', () => {
      const list = agents.map((a) => ({ id: a.id, description: a.id, type: 'jtasks:execute', status: a.status }))
      if (++late.calls >= late.after) list.push({ id: 'agent-late', description: 'late', type: 'jtasks:execute', status: 'running' })
      return { value: list }
    })
    on('agent.spawn', (_$: unknown, e: { model?: string }) => {
      agents.push({ id: `agent-${agents.length + 1}`, status: 'running' })
      return { model: e.model ?? 'inherit', agentId: agents.at(-1)!.id }
    })
    on('ui.toast', (_$: unknown, e: { text: string }) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', (_$: unknown, e: { text: string | undefined }) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('ui.notify', (_$: unknown, e: { text: string }) => {
      notes.push(e.text)
      return { value: { isSent: true } }
    })
    on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: ROOT, surface: interactive ? 'terminal' : null, isInteractive: interactive })
    const r = await $.tool.call({ tool: TOOL, command: 'plan', json: PLAN })
    const run = /execução (\S+) criada/.exec(String(r.result))![1]!
    const dir = `${ROOT}/.scratch/jtasks/runs/${run}`
    const file = `${dir}/tasks.json`
    /** T07 done (its subagent gone), T08 ready: the real case of 25/10. */
    const t07Done = () => {
      const tasks = JSON.parse(machine.read(file)!)
      Object.assign(tasks.tasks[0], { status: 'done', commit: 'abc1234', owner: null })
      tasks.revision++
      machine.write(file, JSON.stringify(tasks))
    }
    // The end of a main-loop turn, and what it left running settled (the message enters once the session is idle).
    const end = async (reason = 'answer', n = 1) => {
      await $.turn.complete({ answer: 'falta a T07 concluir', durationMs: 10, isAborted: reason === 'aborted', turnId: `t${n}`, reason } as never)
      await clock.settle()
    }
    const start = (n = 1) => $.turn.start({ prompt: '', turnId: `t${n}` } as never)
    const log = () => machine.read(`${dir}/log.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l).action as string)
    return { machine, clock, run, dir, file, submitted, toasts, statuses, notes, box, agents, late, t07Done, end, start, log }
  }

  test(`the orchestrator stops with T08 ready and no agent alive: the mod reopens the loop by itself · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    await s.end()
    expect(s.submitted.length).toBe(1)
    expect(s.submitted[0]).toContain(`jtasks: run ${s.run} is idle · done 1/2 · 1 left · ready: T08 · no subagent is running.`)
    expect(s.submitted[0]).toContain('call jtasks next')
    expect(s.log().filter((a) => a.startsWith('keepalive'))).toEqual(['keepalive-nudge'])
    expect(JSON.parse(s.machine.read(`${s.dir}/keepalive.json`)!)).toMatchObject({ action: 'nudge', tries: 1, ready: ['T08'] })
  })

  test(`no message: an interrupted turn (quiet until the run moves), an API error, a refusal, a subagent alive, a -p run · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    // An API error: nothing sent, the person told at once (once: a refusal right after adds nothing).
    await s.end('error')
    await s.end('refusal')
    expect(s.submitted).toEqual([])
    expect(s.toasts).toEqual([`jtasks: a execução ${s.run} parou num erro com T08 por fazer e nada rodando; depois de um erro o host não manda nada (mande uma mensagem para seguir)`])
    // A subagent alive (the engine's list): its own end wakes the orchestrator.
    s.agents.push({ id: 'agent-x', status: 'running' })
    await s.end()
    expect(s.submitted).toEqual([])
    s.agents[0]!.status = 'completed'
    // Esc: no message, and none at the next ends either while nothing moves.
    await s.end('aborted')
    await s.end()
    expect(s.submitted).toEqual([])
    expect(JSON.parse(s.machine.read(`${s.dir}/keepalive.json`)!).action).toBe('held')
    // The run moves (T08 starts and goes back): watched again.
    const tasks = JSON.parse(s.machine.read(s.file)!)
    Object.assign(tasks.tasks[1], { status: 'in_progress', owner: 'claude:session-1' })
    s.machine.write(s.file, JSON.stringify(tasks))
    await s.end()
    expect(s.submitted.length).toBe(1)
    expect(s.submitted[0]).toContain('T08 is in progress and no subagent is running: continue it yourself, or call jtasks release T08')
  })

  test(`a -p run or the SDK gets no message · ${os}`, async ($, on) => {
    const s = await scene($, on, false)
    s.t07Done()
    await s.end()
    expect(s.submitted).toEqual([])
  })

  test(`a draft in the prompt box: the message waits until the box is empty and the session idle · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    s.box.draft = 'espera, deixa eu ver'
    await s.end()
    expect(s.submitted).toEqual([])
    await s.clock.advance(2000)
    expect(s.submitted).toEqual([])
    s.box.draft = ''
    await s.clock.advance(2000)
    expect(s.submitted.length).toBe(1)
    // A turn the person starts meanwhile cancels the wait.
    s.box.draft = 'outra coisa'
    await s.start(2)
    await s.end('answer', 2)
    await s.start(3)
    s.box.draft = ''
    await s.clock.advance(2000)
    expect(s.submitted.length).toBe(1)
  })

  test(`twice without progress: the mod gives up and tells the person (toast, notification, status); progress re-arms it · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    await s.end('answer', 1)
    await s.start(2)
    await s.end('answer', 2)
    await s.start(3)
    await s.end('answer', 3)
    expect(s.submitted.length).toBe(2)
    const notice = `a execução ${s.run} está parada com T08 por fazer e nada rodando; 2 mensagem(ns) sem progresso, o host desistiu (jtasks keepalive on volta a vigiar)`
    expect(s.toasts).toEqual([`jtasks: ${notice}`])
    expect(s.notes).toEqual([`jtasks: ${notice}`])
    // The status line already carries the plugin's name.
    expect(s.statuses.filter((t) => t !== undefined)).toEqual([notice])
    // The pane says it too, under the tasks, until the run moves.
    const ui = await $.ui.mount({
      plugin: 'jtasks',
      component: 'Pane',
      requestId: 'tasks',
      props: { title: 'Tasks', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      surface: 'terminal',
    } as never)
    expect((await ui.find({ type: 'Text', text: /parada:/ }))?.text).toBe('⚠ parada: T08 por fazer, nada rodando')
    await ui.unmount()
    await s.start(4)
    await s.end('answer', 4)
    expect(s.submitted.length).toBe(2)
    expect(s.toasts.length).toBe(1)
    expect(s.log().filter((a) => a.startsWith('keepalive'))).toEqual(['keepalive-nudge', 'keepalive-nudge', 'keepalive-stalled'])
    // A reload of the mod (session.start again) keeps the line while it holds.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(s.statuses.at(-1)).toBe('parada: T08 por fazer, nada rodando')
    // `jtasks keepalive on` (here, or from a terminal) watches it again: the clock clears the status line.
    await $.tool.call({ tool: TOOL, command: 'keepalive on' })
    await s.clock.advance(2000)
    expect(s.statuses.at(-1)).toBeUndefined()
    await s.start(5)
    await s.end('answer', 5)
    expect(s.submitted.length).toBe(3)
  })

  test(`the message is checked again right before it enters: dropped when a subagent started meanwhile · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    // The decision sees no agent; by the time the message enters, one is alive: its end will wake the orchestrator.
    s.late.after = s.late.calls + 2
    await s.end()
    expect(s.log().filter((a) => a.startsWith('keepalive'))).toEqual(['keepalive-nudge'])
    expect(s.submitted).toEqual([])
    // Another plugin's prompt (or the person's) is never checked.
    await $.prompt.submit({ text: 'oi' } as never)
    expect(s.submitted).toEqual(['oi'])
  })

  test(`keepalive off: no message; pause: no message · ${os}`, async ($, on) => {
    const s = await scene($, on)
    s.t07Done()
    expect(String((await $.tool.call({ tool: TOOL, command: 'keepalive off' })).result)).toContain('retomada desligada')
    await s.end()
    await $.tool.call({ tool: TOOL, command: 'keepalive on' })
    await $.tool.call({ tool: TOOL, command: 'pause' })
    await s.end()
    expect(s.submitted).toEqual([])
    await $.tool.call({ tool: TOOL, command: 'unpause' })
    await s.end()
    expect(s.submitted.length).toBe(1)
  })

  test(`a subagent's end still only gives its task back (no message from its loop) · ${os}`, async ($, on) => {
    const s = await scene($, on)
    await $.agent.spawn({ prompt: `--run ${s.run} --task T07 x`, description: 'T07', subagentType: 'general-purpose' } as never)
    const tasks = JSON.parse(s.machine.read(s.file)!)
    Object.assign(tasks.tasks[0], { status: 'in_progress', owner: 'claude:session-1/agent:agent-1', attempts: 1 })
    s.machine.write(s.file, JSON.stringify(tasks))
    s.agents[0]!.status = 'completed'
    await $.turn.complete({ answer: 'parei', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1', reason: 'answer' } as never)
    expect(JSON.parse(s.machine.read(s.file)!).tasks[0]).toMatchObject({ status: 'pending', owner: null })
    expect(s.submitted).toEqual([])
  })
}
