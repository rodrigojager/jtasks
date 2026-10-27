// The display model of a run (sections 14 and 15): the same checklist and bar for the Claude Code pane and the
// OpenCode sidebar. Built from tasks.json, run.json and `jlock list`; never writes.

import { assess, blockerText, waitingOf, waitingText, type RunState } from "./frontier.ts"
import { counts, progress } from "./format.ts"
import type { Host } from "./host.ts"
import { jlockList, type JlockLock } from "./jlock.ts"
import { keepaliveNotice, readKeepalive } from "./keepalive.ts"
import { pauseViewNotice } from "./transient.ts"
import { awaitingWhat } from "./procs.ts"
import { listRuns, readRun, readTasks, runDir } from "./store.ts"
import type { RunFile, Task, TasksFile, ToolName } from "./schema.ts"
import { tr, width as columns } from "./i18n.ts"

export type LineState = "done" | "running" | "waiting" | "ready" | "blocked" | "skipped" | "failed"

export interface ViewLine {
  mark: string
  id: string
  title: string
  detail: string
  state: LineState
  /** A short note the pane adds to the row (rev. 5.6): the files a task waits for after a yield, or its saved edits. */
  note?: string
}

export interface RunView {
  kind: "run"
  run: string
  paused: boolean
  done: number
  total: number
  skipped: number
  failed: number
  remaining: number
  percent: number
  lines: ViewLine[]
  /** The keepalive gave up on the run as it stands (`view.stalled`): shown under the tasks. */
  notice?: string
}

export interface RunsView {
  kind: "runs"
  runs: { id: string; status: string; done: number; total: number; percent: number }[]
}

export type View = RunView | RunsView

const MARKS: Record<LineState, string> = {
  done: "☑",
  running: "◐",
  waiting: "◐",
  ready: "☐",
  blocked: "☐",
  skipped: "⊘",
  failed: "✗",
}

function profileDetail(tasks: TasksFile, task: Task, tool: ToolName): string {
  const p = tasks.profiles[task.profile]
  const extra = tool === "opencode" ? p?.opencode?.agent : p?.claude?.model
  return extra && extra !== task.profile ? `${task.profile}·${extra}` : task.profile
}

/** The checklist of a run: one line per task, with its mark and why it stands where it stands. */
export function buildView(state: RunState, locks: JlockLock[], platform: string, tool: ToolName): RunView {
  const c = counts(state.tasks.tasks)
  const pending = new Map(assess(state, locks, platform).map((a) => [a.task.id, a]))
  const waiting = waitingOf(state, locks)
  const lines: ViewLine[] = state.tasks.tasks.map((t) => {
    let st: LineState
    let detail = ""
    let note: string | undefined
    switch (t.status) {
      case "done":
        st = "done"
        detail = t.commit ?? ""
        break
      case "skipped":
        st = "skipped"
        detail = t.reason ?? ""
        break
      case "failed":
        st = "failed"
        detail = t.error ?? ""
        break
      case "in_progress": {
        const w = waiting.get(t.id)
        st = w || t.awaiting ? "waiting" : "running"
        detail = w ? waitingText(w, state, platform) : profileDetail(state.tasks, t, tool)
        if (w?.yielded) note = tr("view.waits_for", { files: w.yielded.join(", ") })
        // Its subagent's loop ended while its process runs (rev. 5.8): it waits for the process, not for a lock.
        if (t.awaiting) {
          detail = t.awaiting.endedAt ? tr("view.awaiting_back") : tr("view.awaiting", { what: awaitingWhat(t) })
          note = detail
        }
        break
      }
      default: {
        const a = pending.get(t.id)
        st = a && a.blockers.length ? "blocked" : "ready"
        detail = a?.blockers.map((b) => blockerText(b, state, platform)).join(" · ") ?? ""
        if (t.lost) detail = `${tr("view.lost")}${detail ? ` · ${detail}` : ""}`
      }
    }
    const line: ViewLine = { mark: MARKS[st], id: t.id, title: t.title, detail, state: st }
    if (note) line.note = note
    return line
  })
  return {
    kind: "run",
    run: state.run.id,
    paused: state.run.status === "paused",
    done: c.done,
    total: c.total,
    skipped: c.skipped,
    failed: c.failed,
    remaining: c.remaining,
    percent: c.percent,
    lines,
  }
}

export function runsView(runs: { run: RunFile; tasks?: TasksFile }[]): RunsView {
  return {
    kind: "runs",
    runs: runs.map((r) => {
      const c = r.tasks ? counts(r.tasks.tasks) : { done: 0, total: 0 }
      return { id: r.run.id, status: r.run.status, done: c.done, total: c.total, percent: progress(c.done, c.total) }
    }),
  }
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/** The bar's width in the sidebar and the pane, as the opencode-hud draws its meters. */
export const BAR_CELLS = 10

/**
 * The bar in three runs to paint, as the opencode-hud's `Meter` draws it: the full cells (the theme's primary colour),
 * one partial cell in eighths (primary on the track's background) and the empty cells (`█` in the track colour).
 */
export function barCells(percent: number, cells = BAR_CELLS): { full: string; partial: string; empty: string } {
  const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells * 8)
  const full = Math.floor(eighths / 8)
  const partial = EIGHTHS[eighths % 8]!
  return { full: "█".repeat(full), partial, empty: "█".repeat(Math.max(0, cells - full - (partial ? 1 : 0))) }
}

/** `████████▌░░░░░░░`: the percent in `width` cells, in eighths; the text form, for where nothing is painted. */
export function bar(percent: number, width: number): string {
  const w = Math.max(1, width)
  const units = Math.round((Math.max(0, Math.min(100, percent)) / 100) * w * 8)
  const full = Math.floor(units / 8)
  const part = EIGHTHS[units % 8]!
  const used = full + (part ? 1 : 0)
  return "█".repeat(full) + part + "░".repeat(Math.max(0, w - used))
}

export function headerText(view: View, collapsed: boolean): string {
  if (view.kind === "runs") return `${collapsed ? "▸" : "▾"} Tasks · ${tr("view.no_run")}`
  if (collapsed) return view.paused ? `▸ Tasks · ${tr("view.paused")}` : `▸ Tasks ${view.done}/${view.total} · ${view.percent}%`
  return `▾ Tasks · ${view.run}${view.paused ? ` · ${tr("view.paused")}` : ""}`
}

/** What follows the bar: `58% · 7/12 · 1 pulada · 1 falha`. */
export function summaryTail(view: RunView): string {
  const parts = [`${view.percent}% · ${view.done}/${view.total}`]
  if (view.skipped) parts.push(tr("progress.skipped", { n: view.skipped }))
  if (view.failed) parts.push(tr("progress.failed", { n: view.failed }))
  return parts.join(" · ")
}

export function summaryText(view: RunView, barWidth: number): string {
  return `${bar(view.percent, barWidth)}  ${summaryTail(view)}`
}

/** The text cut to `width` terminal columns (wide characters count two), with … when cut. */
function fit(text: string, width: number): string {
  if (columns(text) <= width) return text
  let out = ""
  for (const ch of text) {
    if (columns(out + ch) > Math.max(1, width - 1)) break
    out += ch
  }
  return `${out}…`
}

/** One checklist line in `width` columns: `☑ T01 Título            9f1c2ab`. */
export function lineText(line: ViewLine, width: number): string {
  const head = `${line.mark} ${line.id} `
  const detail = line.detail ? fit(line.detail, Math.max(8, Math.floor(width * 0.45))) : ""
  const room = width - columns(head) - (detail ? columns(detail) + 1 : 0)
  const title = fit(line.title, Math.max(4, room))
  const gap = Math.max(1, width - columns(head) - columns(title) - columns(detail))
  return detail ? `${head}${title}${" ".repeat(gap)}${detail}` : `${head}${title}`
}

/** The whole view as text lines (the sidebar, the pane, and tests read the same lines). */
export function viewLines(view: View, options: { collapsed: boolean; width: number }): string[] {
  const out = [headerText(view, options.collapsed)]
  if (options.collapsed) return out
  if (view.kind === "runs") {
    if (!view.runs.length) out.push(tr("view.no_runs"))
    for (const r of view.runs) out.push(fit(`${r.id} · ${r.status} · ${r.done}/${r.total} (${r.percent}%)`, options.width))
    return out
  }
  out.push(summaryText(view, Math.max(8, Math.min(16, options.width - 24))))
  for (const l of view.lines) out.push(lineText(l, options.width))
  return out
}

/** The view of one run, read now: its files and `jlock list --under <repo>` (the whole machine with `*` in play). */
export async function loadView(host: Host, root: string, run: string, tool: ToolName): Promise<RunView | undefined> {
  const dir = runDir(root, run)
  const [runFile, tasks] = await Promise.all([readRun(host, dir).catch(() => undefined), readTasks(host, dir).catch(() => undefined)])
  if (!runFile || !tasks) return undefined
  const star = tasks.tasks.some((t) => t.exclusive && (t.status === "pending" || t.status === "in_progress"))
  const locks = await (star ? jlockList(host) : jlockList(host, { under: root })).catch(() => [])
  const view = buildView({ root, dir, run: runFile, tasks }, locks, host.platform, tool)
  // A run that needs a person (rev. 5.8) says so; a transient pause (rev. 5.7) says why and until when; otherwise a
  // give-up of the keepalive, if any.
  const needs = runFile.status === "paused" ? runFile.needsPerson : undefined
  const notice = needs
    ? tr("view.needs_person", { id: needs.task, n: needs.count })
    : runFile.status === "paused" && runFile.pause
      ? pauseViewNotice(runFile.pause, host.now())
      : keepaliveNotice(runFile, tasks, await readKeepalive(host, dir))
  return notice ? { ...view, notice } : view
}

export async function loadRunsView(host: Host, root: string): Promise<RunsView> {
  return runsView(await listRuns(host, root))
}
