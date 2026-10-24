/** @jsxImportSource @opentui/solid */
// The spinner of the Tasks section, in OpenCode's own style: a 3×2 grid of squares (a six-dot braille cell) with two
// neighbouring squares missing, the gap going round clockwise. One character wide, so it sits where a mark would.

import { createSignal, onCleanup } from "solid-js"

/**
 * The frames: all six dots but two neighbours, the missing pair walking the ring top → right → bottom → left
 * (dots 1-4, 4-5, 5-6, 6-3, 3-2, 2-1 of the cell).
 */
export const SPINNER_FRAMES = ["⠶", "⠧", "⠏", "⠛", "⠹", "⠼"] as const
export const SPINNER_INTERVAL_MS = 100

/** The frame shown after `ticks` steps. */
export function spinnerFrame(ticks: number): string {
  return SPINNER_FRAMES[((ticks % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!
}

/** An animated spinner in `color` (the theme's hue). It stops when it is unmounted. */
export function Spinner(props: { color: unknown; intervalMs?: number }) {
  const [ticks, setTicks] = createSignal(0)
  const timer = setInterval(() => setTicks((n) => n + 1), props.intervalMs ?? SPINNER_INTERVAL_MS)
  onCleanup(() => clearInterval(timer))
  return <span style={{ fg: props.color as never }}>{spinnerFrame(ticks())}</span>
}
