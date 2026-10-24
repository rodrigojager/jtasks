/** @jsxImportSource @opentui/solid */
// The TUI section, mounted in OpenTUI's test renderer against a fake TUI context whose RPC client reaches the
// server plugin of a fake host (real jlock and git in temporary folders).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import { createTuiPlugin } from "../tui.tsx"
import { cleanupTemp, fakeHost, makeRepo, writeFiles } from "./fake-host.ts"

const cleanups: (() => Promise<void>)[] = []
let mounted: { renderer: { destroy(): void } }[] = []
afterEach(() => {
  for (const m of mounted) m.renderer.destroy()
  mounted = []
})
afterAll(async () => {
  for (const c of cleanups) await c()
  await Bun.sleep(400)
  cleanupTemp()
})

/** Renders until the frame satisfies `predicate` (the section loads through git and jlock, so it takes a moment). */
async function frame(setup: { renderOnce(): Promise<void>; captureCharFrame(): string }, predicate: (f: string) => boolean, ms = 15_000) {
  const end = Date.now() + ms
  for (;;) {
    await setup.renderOnce()
    const f = setup.captureCharFrame()
    if (predicate(f)) return f
    if (Date.now() > end) throw new Error(`frame never matched; last frame:\n${f}`)
    await Bun.sleep(50)
  }
}

const hex = (v: string) => RGBA.fromHex(v)
const theme = { text: { base: hex("#eeeeee"), muted: hex("#999999"), faint: hex("#666666"), feedback: { error: { base: hex("#ff4444") } } } }

async function tui(server: Awaited<ReturnType<typeof fakeHost>>) {
  const slots: any[] = []
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  const context = {
    options: {},
    location: { directory: "D:/x" },
    theme: { ...theme, surface: () => theme },
    client: { rpc: server.rpcClient },
    storage: {
      store: (_key: string, options: { initial: object }) => {
        const [state, set] = createStore(JSON.parse(JSON.stringify(options.initial)))
        return [state, async (mutation: (draft: any) => void) => set(produce(mutation))]
      },
    },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler])
        return () => listeners.set(type, (listeners.get(type) ?? []).filter((h) => h !== handler))
      },
    },
    ui: { slot: (claim: any) => (slots.push(claim), () => {}) },
  }
  await createTuiPlugin({ refreshMs: 100 }).setup(context as never)
  const emit = (type: string) => {
    for (const h of listeners.get(type) ?? []) h({ type })
  }
  const mount = async (sessionID: string) => {
    const claim = slots.find((s) => s.append === "sidebar.content")
    const setup = await testRender(() => claim.render({ sessionID }), { width: 44, height: 12 })
    mounted.push(setup)
    await setup.renderOnce()
    return setup
  }
  return { slots, emit, mount }
}

describe("TUI section", () => {
  test("appends to sidebar.content; changes from 0/2 to 1/2 after a done; a click folds it", async () => {
    const repo = makeRepo()
    const server = await fakeHost(repo)
    if (server.cleanup) cleanups.push(server.cleanup)
    const planned = await server.call("s1", "plan", {
      tasks: [
        { id: "T01", title: "Movimento", files: ["src/a.ts"] },
        { id: "T02", title: "Gravador", files: ["src/b.ts"] },
      ],
    })
    const run = /execução (\S+) criada/.exec(planned.text)![1]!
    const t = await tui(server)
    expect(t.slots.map((s) => s.append)).toEqual(["sidebar.content"])

    const view = await t.mount("s1")
    const first = await frame(view, (f) => f.includes("Tasks"))
    expect(first).toContain(`▾ Tasks · ${run}`)
    expect(first).toContain("0% · 0/2")
    expect(first).toContain("☐ T01 Movimento")

    server.addSession("c1", "s1")
    await server.call("c1", "start T01")
    // While T01 runs, the 2 s refresh (100 ms here) picks it up.
    expect(await frame(view, (f) => f.includes("◐ T01"))).toContain("◐ T01 Movimento")
    writeFiles(repo, { "src/a.ts": "a\n" })
    await server.call("c1", 'done T01 --evidence "ok"')
    t.emit("session.tool.success")
    const after = await frame(view, (f) => f.includes("1/2"))
    expect(after).toContain("50% · 1/2")
    expect(after).toMatch(/☑ T01 Movimento\s+[0-9a-f]{7}/)

    await view.mockMouse.click(2, 0)
    const folded = await frame(view, (f) => f.includes("▸ Tasks"))
    expect(folded).toContain("▸ Tasks 1/2 · 50%")
    expect(folded).not.toContain("T01")
  })

  test("a session without a bound run shows the runs of its repository", async () => {
    const repo = makeRepo()
    const server = await fakeHost(repo)
    if (server.cleanup) cleanups.push(server.cleanup)
    server.addSession("other")
    const t = await tui(server)
    const view = await t.mount("other")
    expect(await frame(view, (f) => f.includes("Tasks"))).toContain("▾ Tasks · sem execução ligada")
  })
})
