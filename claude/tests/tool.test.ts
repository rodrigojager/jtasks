import { expect, test } from 'claude-code/testing'
import { installMachine, installSession } from './machine.ts'

// The test runtime has timers, though a hooks module's types do not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const ROOT = 'D:/work/repo'
const TOOL = 'mcp__goal-tasks__tasks'

const PLAN = {
  objective: 'Duas fatias',
  tasks: [
    { id: 'T01', title: 'Base', files: ['src/a.ts'] },
    { id: 'T02', title: 'Junta', dependsOn: ['T01'], files: ['src/b.ts'] },
  ],
}

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

/** What the model reads back from one call of the tool. */
async function call($: any, command: string, json?: unknown): Promise<string> {
  const r = await $.tool.call(json === undefined ? { tool: TOOL, command } : { tool: TOOL, command, json })
  return String(r.result)
}

test('session.start registers the tasks tool, in the prompt from the start', async ($, on) => {
  installMachine(on, ROOT)
  const session = installSession(on, ROOT)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(session.tools).toEqual(['tasks'])
  expect(await call($, 'version')).toBe('tasks 0.1.0')
  expect(await call($, 'help')).toContain('plan <json|@arquivo>')
})

test('plan binds the run to the session; status answers; another --run is refused', async ($, on) => {
  const m = installMachine(on, ROOT)
  installSession(on, ROOT)
  const states: unknown[] = []
  on('state.set', (_$, e, next) => {
    if (e.key === 'run') states.push(e)
    return next(e)
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const planned = await call($, 'plan', PLAN)
  const run = /execução (\S+) criada/.exec(planned)![1]!
  expect(planned).toContain(`branch gt/${run}`)
  expect(m.branch()).toBe(`gt/${run}`)
  const tasks = JSON.parse(m.read(`${ROOT}/.scratch/goal-tasks/runs/${run}/tasks.json`)!)
  expect(tasks.tasks.map((t: { id: string }) => t.id)).toEqual(['T01', 'T02'])
  expect(m.read(`${ROOT}/.git/info/exclude`)).toBe('.scratch/\n')
  expect(m.list(`${ROOT}/.scratch/goal-tasks/runs/${run}/tickets`)).toEqual(['01-base.md', '02-junta.md'])

  expect(states).toEqual([expect.objectContaining({ plugin: 'goal-tasks', key: 'run', value: { run, root: ROOT } })])

  const status = await call($, 'status')
  expect(status.split('\n')[0]).toBe('feitas 0/2 (0%) · restam 2')
  expect(status).toContain('prontas: T01')
  expect(await call($, 'status --run outra-261024-zzzz')).toBe(`esta sessão está ligada à execução ${run}; --run outra-261024-zzzz é recusado`)
})

test('the protocol section is in the system prompt only while a run is bound', async ($, on) => {
  installMachine(on, ROOT)
  installSession(on, ROOT)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const before = await $.prompt.compose(COMPOSE as never)
  expect(before.sections.map((s) => s.id)).toEqual(['intro'])

  const run = /execução (\S+) criada/.exec(await call($, 'plan', PLAN))![1]!
  const after = await $.prompt.compose(COMPOSE as never)
  expect(after.sections.map((s) => s.id)).toEqual(['intro', 'goal-tasks:protocol'])
  const section = after.sections[1]!
  expect(section.scope).toBe('session')
  expect(section.text).toContain(`goal-tasks: bound run ${run} · feitas 0/2 (0%) · restam 2`)
  expect(section.text).toContain('1. Call tasks next.')
  expect(section.text).toContain('the Agent tool')
})

test('start takes the ownership with jlock hold --detach --ttl through $.process.run; done gives it back with jlock release', async ($, on) => {
  const m = installMachine(on, ROOT)
  installSession(on, ROOT)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const run = /execução (\S+) criada/.exec(await call($, 'plan', { tasks: [{ id: 'T01', title: 'Base', files: ['src/a.ts'] }] }))![1]!

  expect(await call($, 'start T01')).toContain(`T01 em andamento (tentativa 1): posse travada no jlock (1 chave(s), dono gt:${run}/T01)`)
  // One call, the answer in hand; jlock's own keeper holds the lock until `release` or the run's ttl.
  expect(m.commands).toContain(
    `jlock hold d:/work/repo/src/a.ts --owner gt:${run}/T01 --group ${run} --intent Base --meta task=T01 --meta run=${run} --meta tool=claude --meta session=session-1 --no-wait --ttl 2h --detach --json`,
  )
  expect(m.locks.map((l) => [l.key, l.owner])).toEqual([['d:/work/repo/src/a.ts', `gt:${run}/T01`]])
  expect(await call($, 'status')).toContain(`travas ativas (jlock --group ${run}): src/a.ts → T01`)
  expect(await call($, 'done T01 --evidence ok')).toContain('T01 feita: nenhuma mudança na posse, sem commit; posse devolvida')
  expect(m.releases).toEqual([`gt:${run}/T01`])
  expect(m.locks).toEqual([])
})
