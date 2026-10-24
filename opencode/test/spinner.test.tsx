/** @jsxImportSource @opentui/solid */
// The spinner of the Tasks section: OpenCode's 3×2 squares (a six-dot braille cell) with two neighbouring squares
// missing, the gap walking the ring clockwise. The frames are checked dot by dot, then the component is mounted in
// OpenTUI's test renderer.
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SPINNER_FRAMES, Spinner, spinnerFrame } from "../src/spinner.tsx"

/** The ring of a braille cell's six dots, clockwise from the top-left: 1 → 4 → 5 → 6 → 3 → 2 → 1. */
const RING = [1, 4, 5, 6, 3, 2]

/** The dots (1-8) set in a braille character. */
function dots(ch: string): number[] {
  const code = ch.codePointAt(0)! - 0x2800
  return [1, 2, 3, 4, 5, 6, 7, 8].filter((d) => code & (1 << (d - 1)))
}

/** The six-dot dots missing from a frame, as positions on the ring, sorted. */
function gap(ch: string): number[] {
  const set = dots(ch)
  return RING.map((d, i) => (set.includes(d) ? -1 : i)).filter((i) => i >= 0)
}

/** The ring edge index (0-5) of a gap of two neighbours: the edge from RING[i] to RING[i+1]. */
function edge(g: number[]): number {
  const [a, b] = g as [number, number]
  return b - a === 1 ? a : 5 // only the pair (0, 5) wraps round
}

describe("spinner frames", () => {
  test("six frames, each a six-dot braille character with four dots set", () => {
    expect(SPINNER_FRAMES.length).toBe(6)
    for (const f of SPINNER_FRAMES) {
      expect([...f].length).toBe(1)
      const code = f.codePointAt(0)!
      expect(code).toBeGreaterThanOrEqual(0x2800)
      expect(code).toBeLessThanOrEqual(0x283f)
      const set = dots(f)
      expect(set.length).toBe(4)
      expect(set.every((d) => d >= 1 && d <= 6)).toBe(true)
    }
  })

  test("the two missing dots are neighbours on the ring", () => {
    for (const f of SPINNER_FRAMES) {
      const g = gap(f)
      expect(g.length).toBe(2)
      const [a, b] = g as [number, number]
      expect(b - a === 1 || (a === 0 && b === 5)).toBe(true)
    }
  })

  test("the gap moves one step clockwise from frame to frame, all the way round", () => {
    const edges = SPINNER_FRAMES.map((f) => edge(gap(f)))
    expect(new Set(edges).size).toBe(6)
    for (let i = 0; i < edges.length; i++) {
      const next = edges[(i + 1) % edges.length]!
      expect(next).toBe((edges[i]! + 1) % 6)
    }
    // The first frame leaves out the top row (dots 1 and 4).
    expect(gap(SPINNER_FRAMES[0])).toEqual([0, 1])
  })

  test("spinnerFrame cycles, negative ticks included", () => {
    for (let n = 0; n < 6; n++) expect(spinnerFrame(n)).toBe(SPINNER_FRAMES[n]!)
    expect(spinnerFrame(6)).toBe(SPINNER_FRAMES[0])
    expect(spinnerFrame(13)).toBe(SPINNER_FRAMES[1])
    expect(spinnerFrame(-1)).toBe(SPINNER_FRAMES[5])
    expect(spinnerFrame(-6)).toBe(SPINNER_FRAMES[0])
    expect(spinnerFrame(-7)).toBe(SPINNER_FRAMES[5])
  })
})

let mounted: { renderer: { destroy(): void } }[] = []
afterEach(() => {
  for (const m of mounted) m.renderer.destroy()
  mounted = []
})

describe("Spinner component", () => {
  test("draws a frame in the given colour and animates", async () => {
    const color = RGBA.fromHex("#3399ff")
    const setup = await testRender(
      () => (
        <text>
          <Spinner color={color} intervalMs={20} />
        </text>
      ),
      { width: 4, height: 1 },
    )
    mounted.push(setup)
    await setup.renderOnce()
    const first = setup.captureCharFrame().trim()
    expect((SPINNER_FRAMES as readonly string[]).includes(first)).toBe(true)

    const span = setup
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((s) => s.text.includes(first))!
    expect(span.fg.toInts().slice(0, 3)).toEqual([51, 153, 255])

    const seen = new Set([first])
    const end = Date.now() + 2_000
    while (seen.size < 3 && Date.now() < end) {
      await Bun.sleep(25)
      await setup.renderOnce()
      const f = setup.captureCharFrame().trim()
      expect((SPINNER_FRAMES as readonly string[]).includes(f)).toBe(true)
      seen.add(f)
    }
    expect(seen.size).toBeGreaterThanOrEqual(3)

    const later = setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => /[⠀-⠿]/.test(s.text))!
    expect(later.fg.toInts().slice(0, 3)).toEqual([51, 153, 255])
  })
})
