import { expect, test } from 'claude-code/testing'
import { hudBar, paneRows } from '../hooks/pane.tsx'
import type { PaneView } from '../types'

test('hud bar uses ten whole cells and follows with percent and task count', () => {
  expect(hudBar(60, 3, 5)).toEqual({ filled: '██████', empty: '░░░░', text: '60% · 3/5' })
  expect(hudBar(0, 0, 4)).toEqual({ filled: '', empty: '░░░░░░░░░░', text: '0% · 0/4' })
  expect(hudBar(100, 4, 4)).toEqual({ filled: '██████████', empty: '', text: '100% · 4/4' })
  expect(hudBar(65, 2, 4).filled + hudBar(65, 2, 4).empty).not.toMatch(/[▏▎▍▌▋▊▉]/)
})

test('pane rows normalize task IDs and collapse task statuses into five display states', () => {
  const view = {
    kind: 'run',
    lines: [
      { id: 'T01', title: 'Base', state: 'done' },
      { id: 'T02', title: 'Running', state: 'running' },
      { id: 'T03', title: 'Waiting', state: 'waiting' },
      { id: 'T04', title: 'Ready', state: 'ready' },
      { id: 'T05', title: 'Blocked', state: 'blocked' },
      { id: 'T06', title: 'Failed', state: 'failed' },
      { id: 'T07', title: 'Skipped', state: 'skipped' },
      { id: 'T12', title: 'Twelve', state: 'done' },
    ],
  } as PaneView

  expect(paneRows(view)).toEqual([
    { label: 'T1 - Base', state: 'done' },
    { label: 'T2 - Running', state: 'running' },
    { label: 'T3 - Waiting', state: 'running' },
    { label: 'T4 - Ready', state: 'pending' },
    { label: 'T5 - Blocked', state: 'pending' },
    { label: 'T6 - Failed', state: 'failed' },
    { label: 'T7 - Skipped', state: 'skipped' },
    { label: 'T12 - Twelve', state: 'done' },
  ])
})

test('a task waiting for what it yielded says so in its row', () => {
  const view = { kind: 'run', lines: [{ id: 'T04', title: 'Pytest', state: 'waiting', note: 'espera core/run/index.ts' }] } as PaneView
  expect(paneRows(view)).toEqual([{ label: 'T4 - Pytest · espera core/run/index.ts', state: 'running' }])
})
