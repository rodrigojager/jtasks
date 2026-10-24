// Everything the core needs from the outside world. The core never imports `node:*`: the CLI and the OpenCode
// plugin give it the Node host (`node-host.ts`), the Claude Code mod gives it one made of `$.fs` and `$.process`.

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
}

/**
 * A process that keeps running after it is started: a `jlock hold --release-on-eof` in a long-lived host, which
 * keeps its standard input open so that the host dying frees the lock at once. The CLI and the mod use
 * `hold --detach` through `run` instead, and keep no resident.
 */
export interface Resident {
  /** Informative only: never used to stop a process from another window. */
  readonly pid?: number
  /** The first line the process writes to standard output, or `undefined` when it ends without one. */
  firstLine(timeoutMs?: number): Promise<string | undefined>
  /** Every line written to standard output so far (the first included). */
  lines(): string[]
  /** Writes to standard input; `false` when the host cannot (a host without stdin pipes). */
  send(text: string): Promise<boolean>
  /** Closes standard input: a `hold --release-on-eof` takes it as `release`. */
  closeInput(): Promise<void>
  /** Resolves with the exit code once the process ends. */
  readonly exited: Promise<number>
  /** Ends our own child. */
  stop(): Promise<void>
}

export interface FileStat {
  kind: "file" | "dir" | "other"
  size: number
  mtimeMs: number
}

export interface DirEntry {
  name: string
  kind: "file" | "dir" | "other"
}

export interface Host {
  readonly platform: string
  /** What runs the tool, for `jtasks doctor` (`bun 1.3.14`, `claude-code mod`). */
  readonly runtime?: string
  cwd(): string
  env(name: string): string | undefined
  now(): Date
  random(): number
  sleep(ms: number): Promise<void>
  /** `undefined` when the file does not exist. */
  readText(path: string): Promise<string | undefined>
  /** Writes the whole file, creating its folders. Not atomic: the core does `.tmp` + `rename` on top of it. */
  writeText(path: string, text: string): Promise<void>
  appendText(path: string, text: string): Promise<void>
  /** Replaces `to` when it exists. */
  rename(from: string, to: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  mkdir(path: string): Promise<void>
  /** Creates one folder (its parent must exist); `false` when it already exists. The core's short write lock. */
  mkdirExclusive(path: string): Promise<boolean>
  /** `[]` when the folder does not exist. */
  list(path: string): Promise<DirEntry[]>
  /** `undefined` when the path does not exist. Links are not followed. */
  stat(path: string): Promise<FileStat | undefined>
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  spawn(argv: readonly string[], options?: SpawnOptions): Promise<Resident>
}
