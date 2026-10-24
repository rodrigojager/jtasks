import { expect, test } from 'claude-code/testing'
import { installMachine, installSession } from './machine.ts'

const ROOT = 'D:/work/repo'
const TOOL = 'mcp__goal-tasks__tasks'
const PLAN = {
  tasks: [
    { id: 'T01', title: 'Base', files: ['src/a.ts'] },
    { id: 'T02', title: 'Junta', dependsOn: ['T01'], files: ['src/b.ts'] },
  ],
}

const PANE = {
  plugin: 'goal-tasks',
  component: 'Pane',
  requestId: 'tasks',
  props: { title: 'Tasks', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

/** The engine beneath the pane: the machine and the session (clock, store, panes), in a language. */
function engine(on: any, lang = 'pt-BR') {
  const machine = installMachine(on, ROOT)
  const { clock, panes, store } = installSession(on, ROOT, 'session-1', lang)
  return { machine, clock, panes, store }
}

async function plan($: any): Promise<string> {
  const r = await $.tool.call({ tool: TOOL, command: 'plan', json: PLAN })
  return /(?:execução|run) (\S+) (?:criada|created)/.exec(String(r.result))![1]!
}

test('binding a run opens the pane; it draws the checklist on terminal and desktop and follows a done', async ($, on) => {
  const { machine, clock, panes, store } = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const run = await plan($)
  expect(panes).toEqual(['open tasks'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle' }))?.text).toBe(`▾ Tasks · ${run}`)
    expect((await ui.find({ type: 'Text', text: /0% · 0\/2/ }))?.text).toBe('██████████ 0% · 0/2')
    // The bar as the opencode-hud paints it: the done part in the interactive hue, the rest a dim track.
    const runs = (await ui.findAll({ type: 'Text' })).filter((t) => t.props.color !== undefined && /█/.test(t.text))
    expect(runs.map((t) => [t.text, t.props.color])).toEqual([['██████████', 'subtle']])
    expect((await ui.find({ type: 'Text', text: /T01/ }))?.text).toMatch(/^☐ T01 Base/)
    expect((await ui.find({ type: 'Text', text: /T02/ }))?.text).toContain('⛔ T01')
    await ui.unmount()
  }

  // Another process finishes T01: the 2 s refresh sees tasks.json change.
  const file = `${ROOT}/.scratch/goal-tasks/runs/${run}/tasks.json`
  const tasks = JSON.parse(machine.read(file)!)
  Object.assign(tasks.tasks[0], { status: 'done', commit: '9f1c2ab' })
  machine.write(file, JSON.stringify(tasks))
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /T01/ }))?.text).toMatch(/^☑ T01 Base\s+9f1c2ab$/)
  expect((await ui.find({ type: 'Text', text: /50% · 1\/2/ }))?.text).toBe('██████████ 50% · 1/2')
  const half = (await ui.findAll({ type: 'Text' })).filter((t) => t.props.color !== undefined && /█/.test(t.text))
  expect(half.map((t) => [t.text, t.props.color])).toEqual([
    ['█████', 'suggestion'],
    ['█████', 'subtle'],
  ])

  // The header button folds the pane to one line, and the choice is stored.
  await ui.press({ key: 'toggle' })
  expect((await ui.find({ key: 'toggle' }))?.text).toBe('▸ Tasks 1/2 · 50%')
  expect(await ui.find({ type: 'Text', text: /T01/ })).toBeUndefined()
  expect(store.get('collapsed')).toBe(true)
  await ui.unmount()
})

test('/jtasks opens and closes the pane; with no bound run it lists the runs', async ($, on) => {
  const { panes } = engine(on)
  on('command.run', (_$: unknown, e: unknown) => e as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const opened = await $.command.run({ command: 'jtasks', args: '' } as never)
  expect((opened as { text: string }).text).toBe('Painel Tasks aberto.')
  // No run is bound: the pane lists the repository's runs (none yet).
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'toggle' }))?.text).toBe('▾ Tasks · sem execução ligada')
  expect((await ui.find({ type: 'Text', text: /nenhuma execução/ }))?.text).toBe('nenhuma execução (tasks plan)')
  await ui.unmount()
  const closed = await $.command.run({ command: 'jtasks', args: '' } as never)
  expect((closed as { text: string }).text).toBe('Painel Tasks fechado.')
  expect(panes).toEqual(['open tasks', 'close tasks'])
})

test('a view an earlier version stored is declined', async ($, on) => {
  engine(on)
  on('state.get', (_$, e, next) => (e.key === 'view' ? ({ value: { value: { kind: 'run', lines: 'old shape' }, version: 1 } } as never) : next(e)))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Tasks: carregando…')
  await ui.unmount()
})

test('the same pane in English: GOAL_TASKS_LANG=en for the session', async ($, on) => {
  const { panes } = engine(on, 'en')
  on('command.run', (_$: unknown, e: unknown) => e as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const opened = await $.command.run({ command: 'jtasks', args: '' } as never)
  expect((opened as { text: string }).text).toBe('Tasks pane open.')
  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await empty.find({ key: 'toggle' }))?.text).toBe('▾ Tasks · no bound run')
  expect((await empty.find({ type: 'Text', text: /no run/ }))?.text).toBe('no run (tasks plan)')
  await empty.unmount()
  const run = await plan($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'toggle' }))?.text).toBe(`▾ Tasks · ${run}`)
  expect((await ui.find({ type: 'Text', text: /T02/ }))?.text).toContain('⛔ T01')
  await ui.press({ key: 'toggle' })
  expect((await ui.find({ key: 'toggle' }))?.text).toBe('▸ Tasks 0/2 · 0%')
  await ui.unmount()
  expect(panes[0]).toBe('open tasks')
})
