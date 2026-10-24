// A fake machine beneath the mod for `claude plugin test` (which runs with no fs and no processes): the files
// in memory, and the answers of the commands the core runs (git, jlock, and cmd for what $.fs lacks). The test's
// own hooks stand for the engine, so every $.fs and $.process call of the mod lands here.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

type Node = { kind: 'file' | 'dir'; text: string; mtimeMs: number }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export interface Machine {
  root: string
  files: Map<string, Node>
  read(path: string): string | undefined
  write(path: string, text: string): void
  exists(path: string): boolean
  list(dir: string): string[]
  /** Every command line the mod ran, in order. */
  commands: string[]
  branch: () => string
  locks: { key: string; owner: string; group: string }[]
  releases: string[]
}

export function installMachine(on: On, root: string): Machine {
  const files = new Map<string, Node>()
  let clock = 1_800_000_000_000
  const tick = () => (clock += 1000)
  const parents = (p: string) => {
    const parts = norm(p).split('/')
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (d && !files.has(d)) files.set(d, { kind: 'dir', text: '', mtimeMs: tick() })
    }
  }
  const write = (path: string, text: string) => {
    parents(path)
    files.set(norm(path), { kind: 'file', text, mtimeMs: tick() })
  }
  const mkdir = (path: string) => {
    parents(path)
    if (files.has(norm(path))) return false
    files.set(norm(path), { kind: 'dir', text: '', mtimeMs: tick() })
    return true
  }
  const children = (dir: string) => {
    const d = `${norm(dir)}/`
    return [...files.keys()].filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/'))
  }
  const removeTree = (path: string) => {
    const p = norm(path)
    for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
  }
  const move = (from: string, to: string) => {
    const f = norm(from)
    const t = norm(to)
    parents(to)
    for (const [k, v] of [...files]) {
      if (k === f || k.startsWith(`${f}/`)) {
        files.delete(k)
        files.set(t + k.slice(f.length), v)
      }
    }
  }
  mkdir(root)
  mkdir(`${root}/.git/info`)

  const branches = new Set(['main'])
  let current = 'main'
  const locks: Machine['locks'] = []
  const releases: string[] = []
  const commands: string[] = []
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = (stderr = '') => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

  const git = (args: readonly string[]) => {
    const a = args.join(' ')
    if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`)
    if (a === 'symbolic-ref --short -q HEAD') return ok(`${current}\n`)
    if (a === 'rev-parse --verify -q HEAD') return ok('abc1234\n')
    if (a.startsWith('rev-parse --verify -q refs/heads/')) return branches.has(a.slice(33)) ? ok('abc1234\n') : fail()
    if (a === 'rev-parse --git-path info/exclude') return ok('.git/info/exclude\n')
    if (a.startsWith('switch -q -c ')) {
      branches.add(args[3]!)
      current = args[3]!
      return ok()
    }
    if (a.startsWith('switch -q ')) {
      current = args[2]!
      return ok()
    }
    if (a.startsWith('status ')) return ok('')
    return ok('')
  }
  const jlock = (args: readonly string[]) => {
    if (args[0] === '--version') return ok('jlock 0.1.1\n')
    if (args[0] === 'hold') {
      // `hold --detach`: answers granted and returns; the (pretend) keeper is the lock in `locks`.
      if (!args.includes('--detach')) return fail('fake jlock: hold without --detach would never return here')
      const keys = args.slice(1, args.findIndex((a, i) => i > 0 && a.startsWith('--')))
      const owner = args[args.indexOf('--owner') + 1]!
      const group = args[args.indexOf('--group') + 1]!
      for (const key of keys) locks.push({ key, owner, group })
      return ok(`${JSON.stringify({ result: 'granted', owner, keys })}\n`)
    }
    if (args[0] === 'list') {
      const group = args.includes('--group') ? args[args.indexOf('--group') + 1] : undefined
      const shown = locks.filter((l) => !group || l.group === group)
      return ok(JSON.stringify({ locks: shown.map((l) => ({ key: l.key, holder: { owner: l.owner, group: l.group }, queue: [] })), result: 'ok' }))
    }
    if (args[0] === 'release') {
      const owner = args[args.indexOf('--owner') + 1]!
      releases.push(owner)
      const mine = locks.filter((l) => l.owner === owner)
      for (const l of mine) locks.splice(locks.indexOf(l), 1)
      return ok(JSON.stringify({ keys: mine.map((l) => l.key), owner, result: 'released' }))
    }
    return fail(`fake jlock: ${args.join(' ')}`)
  }
  const cmd = (args: readonly string[]) => {
    const [verb, ...rest] = args.slice(2)
    const operands = rest.filter((r) => !r.startsWith('/'))
    if (verb === 'mkdir') return mkdir(operands[0]!) ? ok() : fail('A subdirectory or file already exists.')
    if (verb === 'move') {
      move(operands[0]!, operands[1]!)
      return ok('        1 file(s) moved.')
    }
    if (verb === 'rmdir' || verb === 'del') {
      removeTree(operands[0]!)
      return ok()
    }
    return fail(`fake cmd: ${args.join(' ')}`)
  }

  on('process.run', (_$, e) => {
    commands.push(e.argv.join(' '))
    const [exe, ...args] = e.argv
    if (exe === 'git') return git(args)
    if (exe === 'jlock') return jlock(args)
    if (exe === 'cmd') return cmd(args)
    return fail(`fake machine: no ${exe}`)
  })
  on('fs.read', (_$, e) => {
    const n = files.get(norm(e.path))
    return n?.kind === 'file' ? { value: n.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.stat', (_$, e) => {
    const n = files.get(norm(e.path))
    return n ? { value: { kind: n.kind, size: n.text.length, mtimeMs: n.mtimeMs, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_$, e) => {
    const n = files.get(norm(e.path))
    if (n?.kind !== 'dir') return { deny: `ENOENT: ${e.path}` }
    return {
      value: children(e.path).map((k) => {
        const c = files.get(k)!
        return { name: k.slice(k.lastIndexOf('/') + 1), kind: c.kind, size: c.text.length, mtimeMs: c.mtimeMs, isLink: false }
      }),
    }
  })

  return {
    root,
    files,
    read: (p) => {
      const n = files.get(norm(p))
      return n?.kind === 'file' ? n.text : undefined
    },
    write,
    exists: (p) => files.has(norm(p)),
    list: (d) => children(d).map((k) => k.slice(k.lastIndexOf('/') + 1)),
    commands,
    branch: () => current,
    locks,
    releases,
  }
}

/**
 * The engine's answers a session needs beneath the mod: start, cwd, id, tool and command registration, env, a
 * clock that moves only when the test moves it, a store, and panes that always fit.
 */
export function installSession(on: On, cwd: string, sessionId = 'session-1', lang = 'pt-BR') {
  const tools: string[] = []
  const panes: string[] = []
  const clock = mock.clock(on)
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', (_$, e) => {
    panes.push(`open ${e.id}`)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('env.get', (_$, e) => ({ value: e.name === 'JTASKS_HOME' ? `${cwd}/../gt-home` : e.name === 'JTASKS_LANG' ? lang : undefined }))
  on('tool.register', (_$, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__jtasks__${e.name}` } }
  })
  return { tools, panes, clock, store }
}
