// The ownership guard through OpenCode's permission hook: `edit` (edit, write, patch) and `shell` decisions of a
// session in a bound run are judged by the core's rule (src/guard.ts): outside the task's ownership, git mutators
// of a subagent, and direct edits of tasks.json/tickets are denied with the reason.

import { checkEdit, checkShell, readTasks, runDir } from "../core/core.js"
import type { Host } from "../core/core.js"
import type { Bindings } from "./binding.ts"

export interface Evaluation {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "ask" | "deny"
  message?: string
}

export async function judge(host: Host, bindings: Bindings, event: Evaluation, fallbackDir: string): Promise<void> {
  if (event.action !== "edit" && event.action !== "shell") return
  const run = await bindings.run(event.sessionID)
  if (!run) return
  const mine = await bindings.task(event.sessionID)
  let task
  if (mine && mine.run === run.run) {
    const tasks = await readTasks(host, runDir(run.root, run.run)).catch(() => undefined)
    task = tasks?.tasks.find((t) => t.id === mine.task && t.status === "in_progress")
  }
  const cwd = (await bindings.directory(event.sessionID)) ?? fallbackDir
  const ctx = { root: run.root, platform: host.platform, cwd, task, home: host.env("HOME") ?? host.env("USERPROFILE") }
  for (const resource of event.resources) {
    const verdict = event.action === "edit" ? checkEdit(ctx, resource) : checkShell(ctx, resource)
    if (!verdict.allow) {
      event.effect = "deny"
      event.message = verdict.reason
      return
    }
  }
}
