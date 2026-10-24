// The display model (src/view.ts, shipped in core/core.js): the same lines the sidebar and the Claude pane draw.
import { describe, expect, test } from "bun:test"
import { bar, barCells, buildView, headerText, lineText, runsView, toTask, viewLines, DEFAULT_PROFILES } from "../core/core.js"
import type { JlockLock, PlanTask, RunFile, RunState } from "../core/core.js"

const ROOT = "D:/Proj"
const RUN = "cursory-261023-k7f2"

function state(tasks: PlanTask[], status: RunFile["status"] = "active"): RunState {
  return {
    root: ROOT,
    dir: `${ROOT}/.scratch/goal-tasks/runs/${RUN}`,
    run: { id: RUN, status } as RunFile,
    tasks: { version: 1, run: RUN, revision: 1, profiles: DEFAULT_PROFILES, tasks: tasks.map((t) => toTask(t, DEFAULT_PROFILES)) },
  }
}

describe("view", () => {
  const s = state([
    { id: "T01", title: "Movimento substituível", files: ["src/a.ts"] },
    { id: "T02", title: "Gerador nativo", files: ["src/rec"] },
    { id: "T03", title: "Paridade completa", files: ["src/par"], profile: "implement-deep" },
    { id: "T04", title: "Mouse move", dependsOn: ["T02"], files: ["src/move.ts"] },
    { id: "T05", title: "Atraso e escala", files: ["src/timing.ts"], profile: "implement-deep" },
    { id: "T06", title: "Fill/clear", dependsOn: ["T04"], files: ["src/fill.ts"] },
    { id: "T07", title: "Insert text", files: ["src/insert.ts"] },
    { id: "T08", title: "Tipos", files: ["src/types.ts"] },
  ])
  const t = s.tasks.tasks
  Object.assign(t[0]!, { status: "done", commit: "9f1c2ab" })
  Object.assign(t[1]!, { status: "done", commit: "3be77d0" })
  Object.assign(t[2]!, { status: "skipped", reason: "coberto" })
  Object.assign(t[3]!, { status: "failed", error: "types.ts em uso por T02" })
  Object.assign(t[4]!, { status: "in_progress", owner: "opencode:s1" })
  Object.assign(t[7]!, { status: "in_progress", owner: "opencode:s1" })
  const locks: JlockLock[] = [
    { key: "d:/proj/src/timing.ts", holder: { owner: `gt:${RUN}/T05` }, queue: [] },
    { key: "d:/proj/src/insert.ts", holder: { owner: `gt:${RUN}/T05` }, queue: [] },
    { key: "d:/proj/src", holder: { owner: "gt:auth-261024-p0q9/T03" }, queue: [{ owner: `gt:${RUN}/T08`, position: 1 }] },
  ]

  test("marks and reasons, with the profile's model for Claude and its agent for OpenCode", () => {
    const claude = buildView(s, locks, "win32", "claude")
    expect(claude.lines.map((l) => [l.mark, l.id, l.detail])).toEqual([
      ["☑", "T01", "9f1c2ab"],
      ["☑", "T02", "3be77d0"],
      ["⊘", "T03", "coberto"],
      ["✗", "T04", "types.ts em uso por T02"],
      ["◐", "T05", "implement-deep·opus"],
      ["☐", "T06", "⛔ T04 (falha) · 🔒 auth-261024-p0q9/T03: src/fill.ts (via src)"],
      ["☐", "T07", "🔒 T05: src/insert.ts"],
      ["◐", "T08", "⏳ auth-261024-p0q9/T03: src · posição 1"],
    ])
    expect(buildView(s, locks, "win32", "opencode").lines[4]!.detail).toBe("implement-deep")
    expect(claude).toMatchObject({ done: 2, total: 8, skipped: 1, failed: 1, percent: 25, remaining: 5 })
  })

  test("header, bar, collapsed and paused forms", () => {
    const v = buildView(s, locks, "win32", "claude")
    expect(headerText(v, false)).toBe(`▾ Tasks · ${RUN}`)
    expect(headerText(v, true)).toBe("▸ Tasks 2/8 · 25%")
    const paused = buildView(state([{ id: "T01", title: "a" }], "paused"), [], "win32", "claude")
    expect(headerText(paused, true)).toBe("▸ Tasks · pausada")
    expect(headerText(paused, false)).toContain("pausada")
    expect(bar(58, 16)).toBe("█████████▎░░░░░░")
    // The painted form, as the opencode-hud's Meter: full cells, one partial in eighths, the track as full blocks.
    expect(barCells(0)).toEqual({ full: "", partial: "", empty: "██████████" })
    expect(barCells(33)).toEqual({ full: "███", partial: "▎", empty: "██████" })
    expect(barCells(50)).toEqual({ full: "█████", partial: "", empty: "█████" })
    expect(barCells(100)).toEqual({ full: "██████████", partial: "", empty: "" })
    expect(bar(0, 4)).toBe("░░░░")
    expect(bar(100, 4)).toBe("████")
    const lines = viewLines(v, { collapsed: false, width: 44 })
    expect(lines[1]).toBe(`${bar(25, 16)}  25% · 2/8 · 1 pulada · 1 falha`)
    expect(lines[2]).toBe("☑ T01 Movimento substituível         9f1c2ab")
    expect(viewLines(v, { collapsed: true, width: 44 })).toEqual(["▸ Tasks 2/8 · 25%"])
  })

  test("long titles and details fit the width", () => {
    const line = { mark: "☐", id: "T09", title: "Um título bem comprido que não cabe", detail: "🔒 outra-execucao/T03: src/a/b/c.ts", state: "blocked" as const }
    expect([...lineText(line, 40)].length).toBeLessThanOrEqual(40)
  })

  test("without a bound run: the list of runs", () => {
    const v = runsView([{ run: { id: "a-261024-aaaa", status: "active" } as RunFile, tasks: s.tasks }])
    expect(viewLines(v, { collapsed: false, width: 40 })).toEqual(["▾ Tasks · sem execução ligada", "a-261024-aaaa · active · 2/8 (25%)"])
    expect(viewLines(runsView([]), { collapsed: false, width: 40 })[1]).toBe("nenhuma execução (tasks plan)")
  })
})
