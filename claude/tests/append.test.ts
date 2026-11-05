// Ticket 60, item 6: the mod's appendText. $.fs has no append, and reading the whole file and writing it back lost the
// lines two appends wrote at once (log.jsonl, where the alerts come from; events.jsonl now). The append is one write
// by a short process (`bun -e`, the text on standard input), so appends at once all land.

import { expect, test } from 'claude-code/testing'
import { createModHost, type Port } from '../hooks/mod-host.ts'
import { installMachine, ROOTS } from './machine.ts'

for (const { os, root: ROOT } of ROOTS) {
  test(`appends at once through the mod's host all land, each line whole · ${os}`, async (_$, on) => {
    const machine = installMachine(on, ROOT)
    // The mod's Port over the fake machine, each call asynchronous like the engine's.
    const tick = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }
    const port = {
      read: async (path: string) => {
        await tick()
        const text = machine.read(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      write: async (path: string, text: string) => {
        await tick()
        machine.write(path, text)
      },
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        await tick()
        return machine.run(argv, init)
      },
      sleep: async () => {},
      env: {},
    } as unknown as Port
    const host = createModHost(port, ROOT)
    const file = `${ROOT}/.scratch/jtasks/runs/r-1/log.jsonl`
    machine.write(file, '{"n":0}\n')
    const lines = Array.from({ length: 24 }, (_, i) => `{"n":${i + 1},"pad":"${'x'.repeat(40 + i)}"}\n`)
    await Promise.all(lines.map((l) => host.appendText(file, l)))
    const got = machine.read(file)!.split('\n').filter(Boolean)
    expect(got).toHaveLength(25)
    expect(got.map((l) => JSON.parse(l).n).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    // One process per append, the text on its standard input: never a read and a rewrite of the whole file.
    const appends = machine.commands.filter((c) => c.startsWith('bun -e '))
    expect(appends).toHaveLength(24)
  })
}
