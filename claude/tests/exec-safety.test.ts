import { expect, test } from 'claude-code/testing'
import { installMachine, installSession, ROOTS } from './machine.ts'

// Exercise the actual mod adapter and shared exec action, without a model or real child processes.
for (const { os, root } of ROOTS) {
  test(`exec reserves cleanup time within the runtime ceiling and exposes truncated output · ${os}`, async ($, on) => {
    const calls: { argv: readonly string[]; timeout: number | undefined }[] = []
    const machine = installMachine(on, root, (argv, init) => {
      if (argv[1] !== 'exec') return undefined
      calls.push({ argv, timeout: init?.timeoutMs })
      return { exitCode: 124, stdout: 'partial evidence', stderr: 'deadline', isStdoutTruncated: true, isStderrTruncated: true }
    })
    installSession(on, root)
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    const call = async (command: string, json?: unknown) => String((await $.tool.call({ tool: 'mcp__jtasks__jtasks', command, ...(json ? { json } : {}) })).result)
    const planned = await call('plan', { tasks: [{ id: 'T01', title: 'Execution', files: ['src/a.ts'] }] })
    const run = /execução (\S+) criada/.exec(planned)![1]!
    await call('start T01')
    const file = `${root}/.scratch/jtasks/runs/${run}/tasks.json`
    const before = JSON.parse(machine.read(file)!).tasks[0]
    const result = await call('exec --task T01 -- node worker.cjs')
    expect(calls[0]!.argv.slice(0, 5)).toEqual(['jlock', 'exec', '--timeout', '585000ms', '--'])
    expect(calls[0]!.timeout).toBe(600_000)
    expect(result).toContain('stdout truncated by Claude runtime')
    expect(result).toContain('stderr truncated by Claude runtime')
    const after = JSON.parse(machine.read(file)!).tasks[0]
    expect(after.status).toBe('in_progress')
    expect(after.owner).toBe(before.owner)
    expect(after.attempts).toBe(before.attempts)
    expect(await call('exec --task T01 --timeout 10m -- node worker.cjs')).toContain('requires exec --timeout <= 585000ms')
    expect(calls.length).toBe(1)
    await call('exec --task T01 --timeout 1s -- node worker.cjs')
    expect(calls[1]!.argv[3]).toBe('1000ms')
    expect(calls[1]!.timeout).toBe(16_000)
  })
}
