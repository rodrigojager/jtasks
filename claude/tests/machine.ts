// A fake machine beneath the mod for `claude plugin test` (which runs with no fs and no processes): the files
// in memory, and the answers of the commands the core runs (git, jlock, and cmd or mkdir/mv/rm for what $.fs
// lacks). The test's own hooks stand for the engine, so every $.fs and $.process call of the mod lands here. Every
// test runs on a Windows and on a POSIX root (ROOTS), whatever the OS the tests run on.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

type Node = { kind: 'file' | 'dir'; text: string; mtimeMs: number }

/** The roots each test runs on: the mod takes its platform from the shape of the working directory. */
export const ROOTS = [
  { os: 'windows', root: 'D:/work/repo' },
  { os: 'posix', root: '/work/repo' },
] as const

/**
 * A path as the machine keys it. The engine resolves a path its OS does not call absolute under the tests' own
 * folder (`D:/work` on Linux arrives as `<folder>/D:/work`) and puts the current drive on a POSIX one on Windows
 * (`/work` arrives as `C:\work`): both are undone, so a path names the same file on every OS.
 */
const normalize = (p: string, posix: boolean) => {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/^.*\/(?=[a-z]:\/)/, '')
  return posix ? n.replace(/^[a-z]:(?=\/)/, '') : n
}

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
  /** Files changed in the working tree (relative to the root): what `git status` lists, `git diff` saves, `git checkout HEAD` puts back. */
  dirty: Map<string, string>
  /** The pids `tasklist` / `ps` see alive (rev. 5.8: the processes a task waits for). */
  alive: Set<number>
}

export function installMachine(on: On, root: string): Machine {
  const posix = root.startsWith('/')
  const norm = (p: string) => normalize(p, posix)
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
    if (a.startsWith('status ')) return ok([...dirty.keys()].map((f) => ` M ${f}\0`).join(''))
    if (args[0] === 'cat-file') return ok()
    if (args[0] === 'diff') {
      const out = args.find((x) => x.startsWith('--output='))!.slice(9)
      const f = args[args.length - 1]!
      write(out, `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+${dirty.get(f) ?? ''}\n`)
      return ok()
    }
    if (args[0] === 'checkout') {
      dirty.delete(args[args.length - 1]!)
      return ok()
    }
    return ok('')
  }
  const dirty = new Map<string, string>()
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
  // What the POSIX side of the mod runs for what $.fs lacks: mkdir [-p], mv -f, rm -rf | -d | -f.
  const posixFs = (exe: string, args: readonly string[]) => {
    const operands = args.filter((a) => !a.startsWith('-'))
    if (exe === 'mkdir') return mkdir(operands[0]!) || args.includes('-p') ? ok() : fail(`mkdir: cannot create directory '${operands[0]}': File exists`)
    if (exe === 'mv') {
      move(operands[0]!, operands[1]!)
      return ok()
    }
    removeTree(operands[0]!)
    return ok()
  }

  const alive = new Set<number>()
  on('process.run', (_$, e) => {
    commands.push(e.argv.join(' '))
    const [exe, ...args] = e.argv
    if (exe === 'git') return git(args)
    // The pids the core looks at (rev. 5.8): Windows' tasklist, POSIX's ps.
    if (exe === 'tasklist') {
      const pid = Number(/PID eq (\d+)/.exec(args.join(' '))?.[1])
      return ok(alive.has(pid) ? `"bun.exe","${pid}","Console","1","10,000 K"\r\n` : 'INFO: No tasks are running which match the specified criteria.\r\n')
    }
    if (exe === 'ps') return alive.has(Number(args[1])) ? ok('bun\n') : fail()
    if (exe === 'jlock') return jlock(args)
    if (exe === 'cmd') return cmd(args)
    if (exe === 'mkdir' || exe === 'mv' || exe === 'rm') return posixFs(exe, args)
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
    dirty,
    alive,
  }
}

/**
 * The engine's answers a session needs beneath the mod: start, cwd, id, tool and command registration, env, a
 * clock that moves only when the test moves it, a store, and panes that always fit. `ownCommand`: the person has a
 * /jtasks of their own (a skill), so the engine refuses the mod's.
 */
export function installSession(on: On, cwd: string, sessionId = 'session-1', lang = 'pt-BR', ownCommand = false) {
  const tools: string[] = []
  const panes: string[] = []
  const clock = mock.clock(on)
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', (_$, e) => (ownCommand ? { deny: `"/${e.name}" refused: it is the user's /${e.name}` } : { value: { command: e.name } }) as never)
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
