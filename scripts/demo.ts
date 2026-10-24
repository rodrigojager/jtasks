// The end-to-end demonstration through the CLI, in a temporary repository with a private JLOCK_HOME and
// GOAL_TASKS_HOME (removed at the end): plan in batches with a validation error fixed by --fix, next with parallel
// tasks, start holding the locks (jlock list --group), a claim that waits in jlock's queue, done with one commit per
// task, status down to "restam 0", the ledger, and undo of one task. Prints each command and its literal output.
// Usage: bun scripts/demo.ts

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..").replace(/\\/g, "/")
const CLI = `${REPO}/cli/tasks.ts`
const base = (process.platform === "win32" ? "D:/claude-cache" : tmpdir()).replace(/\\/g, "/")
const ROOT = `${base}/goal-tasks-demo-${process.pid}-${Date.now().toString(36)}`
const WORK = `${ROOT}/repo`

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  JLOCK_HOME: `${ROOT}/jlock`,
  GOAL_TASKS_HOME: `${ROOT}/goal-tasks-home`,
  JLOCK_HEARTBEAT_MS: "300",
  JLOCK_STALE_MS: "3000",
  JLOCK_HINTS: "0",
}
delete env.GOAL_TASKS_RUN

function print(text: string) {
  process.stdout.write(`${text}\n`)
}

/** Runs one shown command and prints it with its output, as a terminal would. */
function run(shown: string, argv: string[], options: { allowFail?: boolean } = {}): string {
  const p = Bun.spawnSync(argv, { cwd: WORK, env })
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.replace(/\s+$/, "")
  print(`$ ${shown}`)
  if (out) print(out)
  if (p.exitCode !== 0) {
    print(`(saiu com ${p.exitCode})`)
    if (!options.allowFail) throw new Error(`${shown} failed`)
  }
  print("")
  return out
}

const shell = (a: string) => (/[\s;"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
const tasks = (args: string[], options?: { allowFail?: boolean }) => run(`tasks ${args.map(shell).join(" ")}`, ["bun", CLI, ...args], options)
const quiet = (...argv: string[]) => Bun.spawnSync(argv, { cwd: WORK, env })

function file(rel: string, text: string) {
  mkdirSync(join(WORK, rel, ".."), { recursive: true })
  writeFileSync(join(WORK, rel), text)
}

async function main() {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(env.JLOCK_HOME!, { recursive: true })
  quiet("git", "init", "-q", "-b", "main")
  quiet("git", "config", "user.email", "demo@example.test")
  quiet("git", "config", "user.name", "Demo")
  quiet("git", "config", "core.autocrlf", "false")
  file("README.md", "# demo\n")
  quiet("git", "add", "-A")
  quiet("git", "commit", "-q", "-m", "init")
  print(`# repositório temporário: ${WORK}`)
  print(`# JLOCK_HOME=${env.JLOCK_HOME}  GOAL_TASKS_HOME=${env.GOAL_TASKS_HOME}\n`)

  // 1. The plan in batches; the second batch makes T03 share src/core.ts with T01 with no dependency.
  file("../batch1.json", JSON.stringify({ serialize: ["bun test"], tasks: [
    { id: "T01", title: "Núcleo", files: ["src/core.ts"], acceptance: ["core exporta a função"] },
    { id: "T02", title: "Tela", files: ["src/ui"], acceptance: ["view.ts usa o núcleo"] },
  ] }, null, 2))
  file("../batch2.json", JSON.stringify([{ id: "T03", title: "Entrada", files: ["src/main.ts", "src/core.ts"] }], null, 2))
  file("../fix-t03.json", JSON.stringify({ title: "Entrada", dependsOn: ["T01", "T02"], files: ["src/main.ts"] }, null, 2))
  tasks(["plan", "--draft", "--name", "demo", "--objective", "Demonstração do goal-tasks"])
  tasks(["plan", "--add", "@../batch1.json"])
  tasks(["plan", "--add", "@../batch2.json"])
  tasks(["plan", "--commit"], { allowFail: true })
  tasks(["plan", "--fix", "T03", "@../fix-t03.json"])
  tasks(["plan", "--show"])
  const committed = tasks(["plan", "--commit"])
  const runId = /execução (\S+) criada/.exec(committed)![1]!

  // 2. next: T01 and T02 can run in parallel; start holds their keys in jlock.
  tasks(["next"])
  tasks(["start", "T01"])
  tasks(["start", "T02"])
  run(`jlock list --group ${runId} --json`, ["jlock", "list", "--group", runId, "--json"])

  // 3. T02 needs src/core.ts, which T01 owns: the claim waits in jlock's queue (position 1) until its timeout, and
  // gives up saying who holds the file. One flow, nothing in the background.
  tasks(["claim", "T02", "src/core.ts", "--timeout", "3s"], { allowFail: true })
  tasks(["status"])

  // 4. T01 is done (its commit), which releases src/core.ts; T02 asks again and gets it.
  file("src/core.ts", "export function soma(a: number, b: number) {\n  return a + b\n}\n")
  tasks(["done", "T01", "--evidence", "core.ts exporta soma"])
  tasks(["claim", "T02", "src/core.ts"])
  run(`jlock list --group ${runId} --json`, ["jlock", "list", "--group", runId, "--json"])

  file("src/ui/view.ts", "import { soma } from '../core'\nexport const view = () => `2 + 2 = ${soma(2, 2)}`\n")
  file("src/core.ts", "export function soma(a: number, b: number) {\n  return a + b\n}\nexport const versao = 2\n")
  tasks(["done", "T02", "--evidence", "view.ts usa soma; core ganhou versao"])
  tasks(["next"])
  tasks(["start", "T03"])
  file("src/main.ts", "import { view } from './ui/view'\nconsole.log(view())\n")
  tasks(["done", "T03", "--evidence", "main.ts imprime a view"])
  tasks(["status"])
  run("git log --oneline", ["git", "log", "--oneline"])

  // 5. The ledger, and undo of one task (a revert commit; the task goes back to pending).
  tasks(["ledger"])
  tasks(["undo", "--task", "T02"])
  run("git log --oneline -3", ["git", "log", "--oneline", "-3"])
  tasks(["status"])
}

let code = 0
try {
  await main()
} catch (error) {
  print(`demo falhou: ${(error as Error).message}`)
  code = 1
} finally {
  // Every hold was given back by done/undo (a detached hold ends by itself once released); remove everything.
  for (let i = 0; i < 50; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true })
      break
    } catch {
      await Bun.sleep(200)
    }
  }
  print(`# removido: ${ROOT}`)
}
process.exit(code)
