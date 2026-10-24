// The Host for Node and Bun: the CLI, the OpenCode plugin and the tests. Compiled to `dist/node-host.js`,
// separately from `core.js`, so that the core stays free of `node:*` for the Claude Code mod.

import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { DirEntry, FileStat, Host, Resident, RunOptions, RunResult, SpawnOptions } from "./host.ts"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function kindOf(stat: { isFile(): boolean; isDirectory(): boolean }): "file" | "dir" | "other" {
  return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other"
}

async function retry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows: a reader holding the file open for a moment makes rename/unlink fail with EPERM/EBUSY.
      if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
      await delay(25 + i * 10)
    }
  }
}

class ChildResident implements Resident {
  private readonly out: string[] = []
  private partial = ""
  private waiters: (() => void)[] = []
  private done = false
  readonly exited: Promise<number>
  readonly pid?: number

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid
    this.exited = new Promise((resolve) => {
      child.on("error", () => {
        this.finish()
        resolve(127)
      })
      child.on("exit", (code) => {
        this.finish()
        resolve(code ?? 1)
      })
    })
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.feed(chunk))
  }

  private feed(chunk: string) {
    this.partial += chunk
    let cut: number
    while ((cut = this.partial.indexOf("\n")) >= 0) {
      this.out.push(this.partial.slice(0, cut).replace(/\r$/, ""))
      this.partial = this.partial.slice(cut + 1)
    }
    this.wake()
  }

  private finish() {
    if (this.partial.trim()) this.out.push(this.partial.trim())
    this.partial = ""
    this.done = true
    this.wake()
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  async firstLine(timeoutMs = 30_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.out.length > 0) return this.out[0]
      if (this.done) return undefined
      const left = deadline - Date.now()
      if (left <= 0) return undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1000))
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  lines(): string[] {
    return [...this.out]
  }

  async send(text: string): Promise<boolean> {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || this.done) return false
    return new Promise((resolve) => stdin.write(text, (error) => resolve(!error)))
  }

  async closeInput(): Promise<void> {
    this.child.stdin?.end()
  }

  async stop(): Promise<void> {
    if (this.done) return
    this.child.kill()
    await Promise.race([this.exited, delay(5000)])
  }
}

export function createNodeHost(): Host {
  return {
    platform: process.platform,
    cwd: () => process.cwd(),
    env: (name) => process.env[name],
    now: () => new Date(),
    random: () => Math.random(),
    sleep: delay,
    async readText(file) {
      try {
        return await fs.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async writeText(file, text) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await retry(() => fs.writeFile(file, text, "utf8"))
    },
    async appendText(file, text) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await retry(() => fs.appendFile(file, text, "utf8"))
    },
    async rename(from, to) {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await retry(() => fs.rename(from, to))
    },
    async remove(target, options) {
      await retry(() => fs.rm(target, { recursive: options?.recursive ?? false, force: true }))
    },
    async mkdir(dir) {
      await fs.mkdir(dir, { recursive: true })
    },
    async mkdirExclusive(dir) {
      try {
        await fs.mkdir(dir)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
      }
    },
    async list(dir): Promise<DirEntry[]> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return entries.map((e) => ({ name: e.name, kind: kindOf(e) }))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return []
        throw error
      }
    },
    async stat(target): Promise<FileStat | undefined> {
      try {
        const s = await fs.lstat(target)
        return { kind: s.isSymbolicLink() ? "other" : kindOf(s), size: s.size, mtimeMs: s.mtimeMs }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return undefined
        throw error
      }
    },
    run(argv, options: RunOptions = {}): Promise<RunResult> {
      return new Promise((resolve) => {
        const [cmd, ...args] = argv
        const child = spawnChild(cmd!, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (c: string) => (stdout += c))
        child.stderr.on("data", (c: string) => (stderr += c))
        const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined
        child.on("error", (error) => {
          if (timer) clearTimeout(timer)
          resolve({ code: 127, stdout, stderr: stderr + String(error.message) })
        })
        child.on("close", (code) => {
          if (timer) clearTimeout(timer)
          resolve({ code: code ?? 1, stdout, stderr })
        })
        child.stdin.on("error", () => {})
        child.stdin.end(options.stdin ?? "")
      })
    },
    async spawn(argv, options: SpawnOptions = {}): Promise<Resident> {
      const [cmd, ...args] = argv
      const child = spawnChild(cmd!, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      })
      child.stdin?.on("error", () => {})
      return new ChildResident(child)
    },
  }
}
