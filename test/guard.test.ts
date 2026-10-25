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
      reason: "fora da posse de T04: src/humanizer/other.ts; use jtasks claim T04 src/humanizer/other.ts",
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
      reason: "subagente não roda git commit: o commit é feito por jtasks done T04",
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

  // rev. 5.6: what the guard resolves, and the right reason for what it cannot.
  const posix: GuardContext = {
    root: "/work/proj",
    platform: "linux",
    cwd: "/work/proj",
    home: "/home/me",
    task: { id: "T02", files: ["src/adapters/pytest", "tests/pytest.test.ts"] },
  }

  test("variables the command assigns itself are expanded; outside the repository passes", () => {
    for (const c of [
      "S=/tmp/x; echo hi > $S/f",
      "S=/tmp/run-1; mkdir -p $S && bun test > $S/arquivo.log 2>&1",
      "export OUT=/tmp/o; bun test > ${OUT}/t.log",
      "LOG=/tmp/l.txt bun test > $LOG",
      "echo x > ~/notes.md",
      'echo x > "$HOME/notes.md"',
    ])
      expect(checkShell(posix, c), c).toEqual({ allow: true })
    expect(checkShell(posix, "D=src/adapters/pytest; echo x > $D/a.py")).toEqual({ allow: true })
    expect(checkShell(posix, "D=src/other; echo x > $D/a.py")).toEqual({
      allow: false,
      reason: "fora da posse de T02: src/other/a.py; use jtasks claim T02 src/other/a.py",
    })
  })

  test("a path that keeps a variable, a substitution or a glob: guard.unresolved, never a claim with $", () => {
    const r = checkShell(posix, "echo > $X/f")
    expect(r).toEqual({ allow: false, reason: "T02: o caminho $X/f tem variável, substituição ou glob e não pode ser conferido; use o caminho literal, ou Edit/Write" })
    expect((r as { reason: string }).reason).not.toContain("claim")
    for (const c of ["echo > $(pwd)/f", "echo > `pwd`/f", "rm src/*.py", "cd $X && echo > y"]) {
      const v = checkShell(posix, c)
      expect(v.allow, c).toBe(false)
      expect((v as { reason: string }).reason, c).toContain("não pode ser conferido")
    }
    // Plainly outside the repository even with a variable: allowed, as any outside path.
    expect(checkShell(posix, "echo > /tmp/$X/f").allow).toBe(true)
    // Above the repository is not plainly outside: it could be inside.
    expect(checkShell(posix, "echo > /work/$X/f").allow).toBe(false)
    // In single quotes a $ is literal; the main agent is not judged on it.
    expect(checkShell(posix, "echo > '/tmp/$X'").allow).toBe(true)
    expect(checkShell({ ...posix, task: undefined }, "echo > $X/f").allow).toBe(true)
  })

  test("heredocs: the target is a write like any other, and the body is data", () => {
    const heredoc = "cat > src/adapters/pytest/run.py <<'EOF'\nrm -rf src\necho > /etc/x > src/other.py\nEOF\necho done"
    expect(checkShell(posix, heredoc)).toEqual({ allow: true })
    expect(checkShell(posix, "tee tests/pytest.test.ts <<EOF\nimport x\nEOF").allow).toBe(true)
    expect(checkShell(posix, "cat > src/other.py <<'EOF'\nx\nEOF")).toEqual({
      allow: false,
      reason: "fora da posse de T02: src/other.py; use jtasks claim T02 src/other.py",
    })
    // What follows the delimiter is a command again.
    expect(checkShell(posix, "cat > src/adapters/pytest/a.py <<EOF\nx\nEOF\nrm src/other.py").allow).toBe(false)
  })

  test("sed -i: -e/-f/--expression scripts are not files, -i.bak and -i '' are in-place; inside passes, outside refused", () => {
    for (const c of [
      "sed -i -e 's/a/b/' src/adapters/pytest/a.py",
      "sed -i 's/a/b/' src/adapters/pytest/a.py",
      "sed -i.bak -e s/a/b/ -e s/c/d/ src/adapters/pytest/a.py",
      "sed --in-place --expression='s/a|b/c/' src/adapters/pytest/a.py",
      "sed -i '' 's/a/b/' src/adapters/pytest/a.py",
      "sed -ni 's/a/b/p' src/adapters/pytest/a.py",
      "sed -n 's/a/b/p' src/other.py > /tmp/out",
    ])
      expect(checkShell(posix, c), c).toEqual({ allow: true })
    expect(checkShell(posix, "sed -i -e 's/a/b/' src/other.py")).toEqual({
      allow: false,
      reason: "fora da posse de T02: src/other.py; use jtasks claim T02 src/other.py",
    })
  })

  test("redirections to descriptors, cp's source, cd and options with values", () => {
    expect(checkShell(posix, "bun test 2>&1 | tee /tmp/x.log").allow).toBe(true)
    expect(checkShell(posix, "bun test >&2").allow).toBe(true)
    expect(checkShell(posix, "cp src/other.py src/adapters/pytest/copy.py").allow).toBe(true)
    expect(checkShell(posix, "cp src/adapters/pytest/a.py src/other.py").allow).toBe(false)
    expect(checkShell(posix, "cd src/adapters/pytest && echo x > a.py").allow).toBe(true)
    expect(checkShell(posix, "cd /tmp && echo x > a.py").allow).toBe(true)
    expect(checkShell(posix, "cd src && echo x > a.py").allow).toBe(false)
    expect(checkShell(posix, "truncate -s 0 src/adapters/pytest/a.py").allow).toBe(true)
    expect(checkShell(posix, "mkdir -m 755 src/adapters/pytest/sub").allow).toBe(true)
    expect(checkShell(posix, "cat < src/other.py > /tmp/x").allow).toBe(true)
    expect(checkShell(posix, "echo '>' src/other.py # a comment > src/x").allow).toBe(true)
  })
})

