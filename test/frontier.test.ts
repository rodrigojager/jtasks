import { describe, expect, test } from "bun:test"
import { assess, blockerText, selectReady, taskKeys, type RunState } from "../src/frontier.ts"
import type { JlockLock } from "../src/jlock.ts"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES, type PlanTask, type RunFile } from "../src/schema.ts"

const ROOT = "D:/Proj"

function state(tasks: PlanTask[], status: RunFile["status"] = "active"): RunState {
  return {
    root: ROOT,
    dir: `${ROOT}/.scratch/jtasks/runs/r-261024-abcd`,
    run: { id: "r-261024-abcd", status } as RunFile,
    tasks: { version: 1, run: "r-261024-abcd", revision: 1, profiles: DEFAULT_PROFILES, tasks: tasks.map((t) => toTask(t, DEFAULT_PROFILES)) },
  }
}

const lock = (key: string, owner: string): JlockLock => ({ key, holder: { owner }, queue: [] })

describe("frontier", () => {
  test("keys: files and claims as absolute lower-case keys; exclusive is *", () => {
    const s = state([{ id: "T01", title: "a", files: ["src/B.ts", "src/a.ts"] }])
    const t = { ...s.tasks.tasks[0]!, claimed: ["lib"] }
    expect(taskKeys(ROOT, t, "win32")).toEqual(["d:/proj/lib", "d:/proj/src/a.ts", "d:/proj/src/b.ts"])
    expect(taskKeys(ROOT, { ...t, exclusive: true }, "win32")).toEqual(["*"])
  })

  test("independent tasks are ready together; dependents wait", () => {
    const s = state([
      { id: "T01", title: "a", files: ["src/a.ts"] },
      { id: "T02", title: "b", files: ["src/b.ts"] },
      { id: "T03", title: "c", dependsOn: ["T01"], files: ["src/c.ts"] },
    ])
    const a = assess(s, [], "win32")
    expect(selectReady(s, a, "win32").map((t) => t.id)).toEqual(["T01", "T02"])
    expect(selectReady(s, a, "win32", 1).map((t) => t.id)).toEqual(["T01"])
    expect(blockerText(a[2]!.blockers[0]!, s, "win32")).toBe("⛔ T01")
  })

  test("ownership in use blocks by the hierarchy rule, and says by whom and via what", () => {
    const s = state([
      { id: "T01", title: "a", files: ["src/humanizer/types.ts"] },
      { id: "T02", title: "b", files: ["docs"] },
      { id: "T03", title: "c", files: ["lib/x.ts"] },
    ])
    const locks = [
      lock("d:/proj/src", "gt:r-261024-abcd/T09"),
      lock("d:/proj/docs/a.md", "gt:auth-261024-p0q9/T03"),
      lock("d:/proj/lib/x.ts", "vim"),
    ]
    const a = assess(s, locks, "win32")
    expect(selectReady(s, a, "win32")).toEqual([])
    expect(a.map((x) => blockerText(x.blockers[0]!, s, "win32"))).toEqual([
      "🔒 T09: src/humanizer/types.ts (via src)",
      "🔒 auth-261024-p0q9/T03: docs (via docs/a.md)",
      "🔒 outro programa: vim: lib/x.ts",
    ])
  })

  test("a stale holder (dead process) does not block", () => {
    const s = state([{ id: "T01", title: "a", files: ["src/a.ts"] }])
    const dead: JlockLock = { key: "d:/proj/src", holder: { owner: "x", stale: true }, queue: [] }
    expect(assess(s, [dead], "win32")[0]!.ready).toBe(true)
  })

  test("a lock held by the task's own owner does not block it", () => {
    const s = state([{ id: "T01", title: "a", files: ["src/a.ts"] }])
    expect(assess(s, [lock("d:/proj/src/a.ts", "gt:r-261024-abcd/T01")], "win32")[0]!.ready).toBe(true)
  })

  test("an exclusive task goes alone; * held elsewhere blocks everything", () => {
    const s = state([
      { id: "T01", title: "a", files: ["src/a.ts"] },
      { id: "T02", title: "b", exclusive: true },
    ])
    expect(selectReady(s, assess(s, [], "win32"), "win32").map((t) => t.id)).toEqual(["T01"])
    const only = state([{ id: "T02", title: "b", exclusive: true }, { id: "T01", title: "a", files: ["src/a.ts"] }])
    expect(selectReady(only, assess(only, [], "win32"), "win32").map((t) => t.id)).toEqual(["T02"])
    const star = assess(s, [lock("*", "gt:other-261024-zzzz/T01")], "win32")
    expect(star.every((x) => !x.ready)).toBe(true)
  })

  test("failed dependencies and a paused run are reasons too", () => {
    const s = state(
      [
        { id: "T01", title: "a" },
        { id: "T02", title: "b", dependsOn: ["T01"] },
      ],
      "paused",
    )
    s.tasks.tasks[0]!.status = "failed"
    const a = assess(s, [], "win32")
    expect(a.map((x) => x.blockers.map((b) => blockerText(b, s, "win32")))).toEqual([["⛔ T01 (falha)", "pausada"]])
  })
})
