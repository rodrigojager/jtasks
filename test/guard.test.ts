import { describe, expect, test } from "bun:test"
import { checkEdit, checkShell, shellSegments, type GuardContext } from "../src/guard.ts"

const base: GuardContext = {
  root: "D:/Proj",
  platform: "win32",
  cwd: "D:/Proj",
  task: { id: "T04", files: ["src/humanizer/move.ts", "tests/humanizer"], claimed: ["src/humanizer/types.ts"] },
}
const main: GuardContext = { ...base, task: undefined }

describe("edit guard", () => {
  test("inside files + claimed is allowed (hierarchy rule, case-insensitive on Windows)", () => {
    expect(checkEdit(base, "src/humanizer/move.ts")).toEqual({ allow: true })
    expect(checkEdit(base, "D:\\proj\\TESTS\\humanizer\\a.test.ts")).toEqual({ allow: true })
    expect(checkEdit(base, "src/humanizer/types.ts")).toEqual({ allow: true })
  })

  test("outside the ownership is refused with the plan's message", () => {
    expect(checkEdit(base, "src/humanizer/other.ts")).toEqual({
      allow: false,
      reason: "fora da posse de T04: src/humanizer/other.ts; use tasks claim T04 src/humanizer/other.ts",
    })
    expect(checkEdit({ ...base, cwd: "D:/Proj/src" }, "humanizer/x.ts").allow).toBe(false)
  })

  test("tasks.json, run.json and tickets are refused to everyone, the main agent included", () => {
    for (const p of [".scratch/jtasks/runs/r/tasks.json", "D:/Proj/.scratch/jtasks/runs/r/tickets/01-a.md"]) {
      expect(checkEdit(main, p).allow).toBe(false)
      expect(checkEdit(base, p).allow).toBe(false)
    }
  })

  test("the main agent and paths outside the repository are free; exclusive owns everything", () => {
    expect(checkEdit(main, "anything.ts").allow).toBe(true)
    expect(checkEdit(base, "C:/Users/me/notes.md").allow).toBe(true)
    expect(checkEdit({ ...base, task: { id: "T09", files: [], exclusive: true } }, "x/y.ts").allow).toBe(true)
  })
})

describe("shell guard", () => {
  test("git mutators of a subagent are refused; reading git is free", () => {
    expect(checkShell(base, 'git commit -m "x"')).toEqual({
      allow: false,
      reason: "subagente não roda git commit: o commit é feito por tasks done T04",
    })
    for (const c of ["git add .", "git -C D:/Proj checkout main", "git stash", "git reset --hard", "bun test && git switch x"])
      expect(checkShell(base, c).allow).toBe(false)
    for (const c of ["git status", "git diff --stat", "git log -1", "bun test", "dotnet build"]) expect(checkShell(base, c).allow).toBe(true)
    expect(checkShell(main, "git commit -m x").allow).toBe(true)
  })

  test("shell writes outside the ownership are refused; inside are allowed", () => {
    expect(checkShell(base, "rm src/other.ts").allow).toBe(false)
    expect(checkShell(base, "echo x > src/other.ts").allow).toBe(false)
    expect(checkShell(base, "sed -i s/a/b/ src/other.ts").allow).toBe(false)
    expect(checkShell(base, "mv src/humanizer/move.ts src/x.ts").allow).toBe(false)
    expect(checkShell(base, "cat a | tee src/other.ts").allow).toBe(false)
    expect(checkShell(base, "echo x > src/humanizer/move.ts").allow).toBe(true)
    expect(checkShell(base, "rm tests/humanizer/old.test.ts").allow).toBe(true)
    expect(checkShell(base, "bun test > /dev/null").allow).toBe(true)
    expect(checkShell(main, "echo x > .scratch/jtasks/runs/r/tasks.json").allow).toBe(false)
  })

  test("segments", () => {
    expect(shellSegments('a "b c" && d | e; f > g')).toEqual([["a", "b c"], ["d"], ["e"], ["f", ">", "g"]])
  })
})
