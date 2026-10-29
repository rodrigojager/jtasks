import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

const { root: ROOT } = ROOTS[0]!

/** The row of a message `origin` sent, as the transcript draws it. */
function row(text: string, origin: Record<string, unknown>) {
  return { plugin: 'jtasks', component: 'UserMessage', requestId: 'msg-1', props: { text, origin, isExpanded: false }, surface: 'terminal' } as const
}

test('a message the mod sent the orchestrator shows as a tag and a few words; the person\'s own rows are untouched', async ($, on) => {
  installMachine(on, ROOT)
  installSession(on, ROOT, 'session-1', 'pt-BR')
  // The engine's own drawing of the row, beneath the mod.
  on('ui.render', { component: 'UserMessage' }, ($, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine: ${e.props.text}`}</Text>
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const alert = "jtasks: run r-1 changed without your asking (read from the run's log now, not from the conversation):\n- T17: waits.\nGo on with the protocol."
  let ui = await $.ui.mount(row(alert, { kind: 'plugin', name: 'jtasks' }) as never)
  expect((await ui.findAll({ type: 'Text' })).map((t) => [t.text, t.props])).toEqual([
    [' jtasks  aviso da execução', {}],
    [' jtasks ', { backgroundColor: 'suggestion', color: 'inverseText', bold: true }],
    [' aviso da execução', { dimColor: true }],
  ])
  await ui.unmount()

  ui = await $.ui.mount(row('jtasks: run r-1 is idle · done 1/2 · 1 left.', { kind: 'plugin', name: 'jtasks' }) as never)
  expect((await ui.findAll({ type: 'Text' })).map((t) => t.text)).toContain(' execução parada, retomando')
  await ui.unmount()

  // Another plugin's message and the person's prompt draw as the engine draws them.
  for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'user' }]) {
    ui = await $.ui.mount(row('jtasks: run r-1 is idle', origin) as never)
    expect((await ui.findAll({ type: 'Text' })).map((t) => t.text)).toEqual(['engine: jtasks: run r-1 is idle'])
    await ui.unmount()
  }
})
