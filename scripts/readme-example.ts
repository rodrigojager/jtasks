// The READMEs never lie (ticket 29): every block marked `<!-- jtasks-example -->` is run for real, in a
// temporary repository with its own JTASKS_HOME and JLOCK_HOME and in the README's language, with the plan of
// the README's first ```json block as plan.json. `test/readmes.test.ts` compares the README with the real output
// (run ids, commit hashes and paths aside); `bun scripts/readme-example.ts` writes the real output into the eleven
// READMEs. A block holds `$ tasks …` commands and `$ echo "<text>" > <file>` edits, each followed by its output.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { splitCommand } from "../src/tool.ts"

const ROOT = join(import.meta.dir, "..").replace(/\\/g, "/")
const CLI = `${ROOT}/cli/tasks.ts`
export const MARK = "<!-- jtasks-example -->"
/** How the READMEs show the temporary repository's path. */
export const SHOWN_REPO = "~/project"

export const LANGS: [tag: string, file: string][] = [
  ["en", "README.md"],
  ["pt-BR", "README.pt-BR.md"],
  ["es", "README.es.md"],
  ["fr", "README.fr.md"],
  ["de", "README.de.md"],
  ["it", "README.it.md"],
  ["zh-CN", "README.zh-CN.md"],
  ["ja", "README.ja.md"],
  ["ru", "README.ru.md"],
  ["ar", "README.ar.md"],
  ["hi", "README.hi.md"],
]

export interface Step {
  command: string
  output: string
}

export interface Block {
  /** Line index of the opening fence and of the closing fence. */
  open: number
  close: number
  steps: Step[]
}

export function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== MARK) continue
    const open = i + 1
    if (!lines[open]?.startsWith("```")) throw new Error(`${MARK} at line ${i + 1} is not followed by a code block`)
    let close = open + 1
    while (close < lines.length && !lines[close]!.startsWith("```")) close++
    const steps: Step[] = []
    for (const line of lines.slice(open + 1, close)) {
      if (line.startsWith("$ ")) steps.push({ command: line.slice(2), output: "" })
      else if (steps.length) steps.at(-1)!.output += `${line}\n`
    }
    for (const s of steps) s.output = s.output.replace(/\s+$/, "")
    out.push({ open, close, steps })
    i = close
  }
  return out
}

/** The first ```json block of the README: the plan the examples use as plan.json. */
export function planOf(text: string): string {
  const m = /```json\n([\s\S]*?)\n```/.exec(text.replace(/\r\n/g, "\n"))
  if (!m) throw new Error("the README has no ```json block (the plan of the examples)")
  return `${m[1]}\n`
}

/** Run ids, commit hashes and paths aside, and trailing spaces: what the comparison ignores. */
export function normalize(text: string): string {
  return text
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}-[a-z0-9]{4}\b/g, "<run>")
    .replace(/\b[0-9a-f]{7}\b/g, "<hash>")
    .replace(/(?:[A-Za-z]:)?[\/~][^\s,;)]*/g, (p) => (/[\/\\]/.test(p) && p.length > 2 ? "<path>" : p))
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim()
}

/** Runs one block in a fresh temporary repository; returns each step's output as the README shows it. */
export function runBlock(block: Block, plan: string, tag: string): string[] {
  const temp = `${process.platform === "win32" ? "D:/claude-cache" : "/tmp"}/jtasks-readme-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
  const repo = `${temp}/repo`
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    JTASKS_LANG: tag,
    JTASKS_HOME: `${temp}/home`,
    JLOCK_HOME: `${temp}/jlock`,
    JLOCK_HINTS: "0",
    // Short jlock timings: the keeper of a released lock ends within a heartbeat, so the folder can be removed.
    JLOCK_HEARTBEAT_MS: "200",
    JLOCK_STALE_MS: "1500",
  }
  delete env.JTASKS_RUN
  delete env.JLOCK_LANG
  const sh = (...argv: string[]) => {
    const p = Bun.spawnSync(argv, { cwd: repo, env })
    if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`)
  }
  mkdirSync(`${temp}/jlock`, { recursive: true })
  mkdirSync(repo, { recursive: true })
  try {
    sh("git", "init", "-q", "-b", "main")
    sh("git", "config", "user.email", "readme@example.test")
    sh("git", "config", "user.name", "README")
    sh("git", "config", "core.autocrlf", "false")
    writeFileSync(`${repo}/README.md`, "# project\n")
    sh("git", "add", "-A")
    sh("git", "commit", "-q", "-m", "init")
    writeFileSync(`${repo}/plan.json`, plan)
    writeFileSync(`${repo}/.git/info/exclude`, "plan.json\n", { flag: "a" })
    const outputs: string[] = []
    for (const step of block.steps) {
      const argv = splitCommand(step.command)
      if (argv[0] === "echo") {
        const at = argv.indexOf(">")
        const file = join(repo, argv[at + 1]!)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${argv.slice(1, at).join(" ")}\n`)
        outputs.push("")
        continue
      }
      if (argv[0] !== "tasks") throw new Error(`not a tasks command: ${step.command}`)
      const p = Bun.spawnSync(["bun", CLI, ...argv.slice(1)], { cwd: repo, env })
      const text = `${p.stdout.toString()}${p.stderr.toString()}`.replace(/\s+$/, "")
      outputs.push(text.split(repo).join(SHOWN_REPO).replace(/\r\n/g, "\n"))
    }
    return outputs
  } finally {
    for (let i = 0; i < 60; i++) {
      try {
        rmSync(temp, { recursive: true, force: true })
        break
      } catch {
        Bun.sleepSync(200)
      }
    }
  }
}

/** The README with every example block's output replaced by the real one. */
export function rewrite(text: string, tag: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const plan = planOf(text)
  for (const block of blocks(text).reverse()) {
    const outputs = runBlock(block, plan, tag)
    const body: string[] = []
    block.steps.forEach((s, i) => {
      body.push(`$ ${s.command}`)
      if (outputs[i]) body.push(...outputs[i]!.split("\n"))
      if (i < block.steps.length - 1 && outputs[i]) body.push("")
    })
    lines.splice(block.open + 1, block.close - block.open - 1, ...body)
  }
  return lines.join("\n")
}

if (import.meta.main) {
  for (const [tag, file] of LANGS) {
    const path = join(ROOT, file)
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      console.log(`${file}: missing, skipped`)
      continue
    }
    writeFileSync(path, rewrite(text, tag))
    console.log(`${file}: examples written (${tag})`)
  }
}
