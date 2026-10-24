// The "Tasks" pane: the bound run's checklist and bar (the core's view model, the same the OpenCode sidebar draws),
// folded to one line by its header button. The view is kept in $.state, so writing it redraws the pane.

import { barCells, headerText, lineText, loadRunsView, loadView, repoRoot, summaryTail, tr, type View } from '../core/core.js'
import type { PaneView } from '../types'
import type { ViewLine } from '../core/types/view.js'
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

/** Colors for the HUD bar: Claude Code's bright blue and a dim track. */
/** Legacy renderer color; the next renderer uses HUD_BAR_COLOR for the Usage-blue HUD bar. */
export const BAR_COLOR = 'suggestion'
export const HUD_BAR_COLOR = 'brightBlue'
export const TRACK_COLOR = 'subtle'

export const SPINNER_FRAMES = ['✻', '✶', '✳', '✢', '·'] as const

export interface HudBar {
  filled: string
  empty: string
  text: string
}

export function hudBar(percent: number, done: number, total: number): HudBar {
  const filledCount = Math.max(0, Math.min(10, Math.round(percent / 100 * 10)))
  return {
    filled: '█'.repeat(filledCount),
    empty: '░'.repeat(10 - filledCount),
    text: `${percent}% · ${done}/${total}`,
  }
}

export interface PaneRow {
  label: string
  state: 'done' | 'running' | 'pending' | 'failed' | 'skipped'
}

export function paneRows(view: PaneView): PaneRow[] {
  const v = view as View
  if (v.kind !== 'run') return []
  return v.lines.map((line: ViewLine) => ({
    label: `${line.id.replace(/^T0*/, 'T')} - ${line.title}`,
    state: rowState(line.state),
  }))
}

function rowState(state: ViewLine['state']): PaneRow['state'] {
  switch (state) {
    case 'done': return 'done'
    case 'running':
    case 'waiting': return 'running'
    case 'ready':
    case 'blocked': return 'pending'
    case 'failed': return 'failed'
    case 'skipped': return 'skipped'
  }
}

// Kept as a compatibility adapter for the current renderer; the next pane slice consumes hudBar/paneRows directly.
export interface PaneSummary {
  full: string
  partial: string
  empty: string
  tail: string
}

export function paneLines(view: PaneView, collapsed: boolean, columns: number): { header: string; summary?: PaneSummary; body: string[] } {
  const v = view as View
  const header = headerText(v, collapsed)
  if (collapsed) return { header, body: [] }
  if (v.kind === 'runs') {
    const body = v.runs.length ? v.runs.map((r) => `${r.id} · ${r.status} · ${r.done}/${r.total} (${r.percent}%)`) : [tr('view.no_runs')]
    return { header, body }
  }
  const width = Math.max(24, columns)
  return { header, summary: { ...barCells(v.percent), tail: summaryTail(v) }, body: v.lines.map((l) => lineText(l, width)) }
}

/** Whether the view has something that changes without the run's files changing (locks, waits). */
export function isLive(view: PaneView | null): boolean {
  return !!view && view.kind === 'run' && view.lines.some((l) => l.state === 'running' || l.state === 'waiting' || l.state === 'blocked')
}
