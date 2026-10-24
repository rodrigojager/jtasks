// The core's Host made of the mod's $, through a Port: files through $.fs; what $.fs lacks (rename, remove, an
// empty folder, an exclusive folder) through $.process.run; processes through $.process.run, the `jlock hold
// --detach` of a task included (one call; jlock's own keeper holds the lock until `jlock release` or the run's ttl,
// so a reload of the mod loses nothing). $.process.spawn stays for long-running children (docs/DEVIATIONS.md).
// The Port is built in session.start out of closures spelled `$.noun.call(...)`, since $ itself is never passed.

import type { FsEntry, FsStat, ProcessRunInit, ProcessRunResult, ProcessSpawnRequest } from 'claude-code'
import type { DirEntry, FileStat, Host, Resident, RunOptions, RunResult, SpawnOptions } from '../core/core.js'
import type { AgentTask, BoundRun } from '../types'

export type Env = Record<string, string | undefined>

/** What the mod's code needs from $, as plain functions (built where $ is in hand). */
export interface Port {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  run(argv: readonly string[], init: ProcessRunInit): Promise<ProcessRunResult>
  spawn(request: ProcessSpawnRequest): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null }>
  sleep(ms: number): Promise<void>
  getRun(): Promise<BoundRun | null>
  setRun(run: BoundRun | null): Promise<void>
  getAgents(): Promise<Record<string, AgentTask>>
  setAgents(agents: Record<string, AgentTask>): Promise<void>
  sessionId(): Promise<string>
  cwd(): Promise<string>
  env: Env
}

/** The platform, from the shape of the working directory (the mod has no `process`). */
export function platformOf(cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(cwd)) return 'win32'
  return cwd.startsWith('/Users/') ? 'darwin' : 'linux'
}

const win = (p: string) => p.replace(/\//g, '\\')

class SpawnedResident implements Resident {
  /** $.process.spawn closes standard input at the start: nothing to close later. */
  async closeInput(): Promise<void> {}

  private readonly out: string[] = []
  private partial = ''
  private done = false
  private wakers: (() => void)[] = []
  readonly exited: Promise<number>
  private readonly stream: AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null }>

  constructor(
    private readonly port: Port,
    argv: readonly string[],
    cwd: string | undefined,
  ) {
    this.stream = port.spawn(cwd ? { argv, cwd } : { argv })
    this.exited = this.pump()
  }

  private async pump(): Promise<number> {
    let code = 1
    try {
      for (;;) {
        const r = await this.stream.next()
        if (r.done) {
          code = r.value?.code ?? 1
          break
        }
        if (r.value.stream !== 'stdout') continue
        this.partial += r.value.text
        let cut: number
        while ((cut = this.partial.indexOf('\n')) >= 0) {
          this.out.push(this.partial.slice(0, cut).replace(/\r$/, ''))
          this.partial = this.partial.slice(cut + 1)
        }
        this.wake()
      }
    } catch {
      code = 127
    }
    if (this.partial.trim()) this.out.push(this.partial.trim())
    this.done = true
    this.wake()
    return code
  }

  private wake() {
    const w = this.wakers
    this.wakers = []
    for (const f of w) f()
  }

  async firstLine(timeoutMs = 30_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    while (!this.out.length && !this.done && Date.now() < deadline) {
      await Promise.race([new Promise<void>((resolve) => this.wakers.push(resolve)), this.port.sleep(Math.min(1000, deadline - Date.now()))])
    }
    return this.out[0]
  }

  lines(): string[] {
    return [...this.out]
  }

  async send(): Promise<boolean> {
    return false
  }

  async stop(): Promise<void> {
    if (this.done) return
    await this.stream.return({ code: null } as never).catch(() => undefined)
    await Promise.race([this.exited, this.port.sleep(3000)])
  }
}

export function createModHost(port: Port, cwd: string): Host {
  const env = port.env
  const platform = platformOf(cwd)
  const isWin = platform === 'win32'
  const run = async (argv: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
    try {
      const init: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}
      if (options.cwd) init.cwd = options.cwd
      if (options.env) init.env = options.env
      if (options.stdin !== undefined) init.stdin = options.stdin
      init.timeoutMs = options.timeoutMs ?? 120_000
      const r = await port.run(argv, init)
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (error) {
      return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  const stat = async (path: string): Promise<FileStat | undefined> => {
    try {
      const s = await port.stat(path)
      return { kind: s.isLink ? 'other' : s.kind === 'file' ? 'file' : s.kind === 'dir' ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  }
  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await port.read(path)
    } catch {
      return undefined
    }
  }
  const mkdirOne = async (path: string): Promise<boolean> =>
    (await run(isWin ? ['cmd', '/d', '/c', 'mkdir', win(path)] : ['mkdir', path])).code === 0
  return {
    platform,
    cwd: () => cwd,
    runtime: 'claude-code mod',
    env: (name) => env[name],
    now: () => new Date(),
    random: () => Math.random(),
    sleep: (ms) => port.sleep(ms),
    readText,
    writeText: (path, text) => port.write(path, text),
    async appendText(path, text) {
      await port.write(path, ((await readText(path)) ?? '') + text)
    },
    async rename(from, to) {
      const r = await run(isWin ? ['cmd', '/d', '/c', 'move', '/y', win(from), win(to)] : ['mv', '-f', from, to])
      if (r.code !== 0) throw new Error(`rename ${from} → ${to}: ${(r.stderr || r.stdout).trim()}`)
    },
    async remove(path, options) {
      const s = await stat(path)
      if (!s) return
      const argv =
        s.kind === 'dir'
          ? isWin
            ? ['cmd', '/d', '/c', 'rmdir', options?.recursive ? '/s' : '', '/q', win(path)].filter(Boolean)
            : ['rm', options?.recursive ? '-rf' : '-d', path]
          : isWin
            ? ['cmd', '/d', '/c', 'del', '/f', '/q', win(path)]
            : ['rm', '-f', path]
      const r = await run(argv)
      if (r.code !== 0 && (await stat(path))) throw new Error(`remove ${path}: ${(r.stderr || r.stdout).trim()}`)
    },
    async mkdir(path) {
      if ((await stat(path))?.kind === 'dir') return
      if (isWin) await mkdirOne(path)
      else await run(['mkdir', '-p', path])
    },
    async mkdirExclusive(path) {
      if (await stat(path)) return false
      return mkdirOne(path)
    },
    async list(path): Promise<DirEntry[]> {
      try {
        return (await port.list(path)).map((e) => ({ name: e.name, kind: e.isLink ? 'other' : e.kind }))
      } catch {
        return []
      }
    },
    stat,
    run,
    async spawn(argv, options: SpawnOptions = {}): Promise<Resident> {
      return new SpawnedResident(port, argv, options.cwd)
    },
  }
}
