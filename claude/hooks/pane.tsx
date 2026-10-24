// The "Tasks" pane: the bound run's checklist and bar (the core's view model, the same the OpenCode sidebar draws),
// folded to one line by its header button. The view is kept in $.state, so writing it redraws the pane.

import { headerText, lineText, loadRunsView, loadView, repoRoot, summaryText, type View } from '../core/core.js'
import type { PaneView } from '../types'
import { createModHost, type Port } from './mod-host.ts'

export const PANE = 'tasks'
export const PANE_TITLE = 'Tasks'

/** The view of the session: its bound run, or the runs of the repository. */
export async function computeView(p: Port): Promise<PaneView> {
  const cwd = await p.cwd()
  const host = createModHost(p, cwd)
  const bound = await p.getRun()
  if (bound) {
    const v = await loadView(host, bound.root, bound.run, 'claude')
    if (v) return v as PaneView
  }
  const root = await repoRoot(host, cwd)
  return (root ? await loadRunsView(host, root) : { kind: 'runs', runs: [] }) as PaneView
}

/** The pane's text lines for a width: header, bar and checklist (just the header when folded). */
export function paneLines(view: PaneView, collapsed: boolean, columns: number): { header: string; body: string[] } {
  const v = view as View
  const header = headerText(v, collapsed)
  if (collapsed) return { header, body: [] }
  if (v.kind === 'runs') {
    const body = v.runs.length ? v.runs.map((r) => `${r.id} · ${r.status} · ${r.done}/${r.total} (${r.percent}%)`) : ['nenhuma execução (tasks plan)']
    return { header, body }
  }
  const width = Math.max(24, columns)
  return { header, body: [summaryText(v, Math.max(8, Math.min(16, width - 24))), ...v.lines.map((l) => lineText(l, width))] }
}

/** Whether the view has something that changes without the run's files changing (locks, waits). */
export function isLive(view: PaneView | null): boolean {
  return !!view && view.kind === 'run' && view.lines.some((l) => l.state === 'running' || l.state === 'waiting' || l.state === 'blocked')
}
