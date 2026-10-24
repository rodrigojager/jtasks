import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validatePlan } from "../src/validate.ts"
import { REPO_ROOT, cleanupTemp, makeRepo, tasksOk } from "./helpers.ts"

// Real git processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const HOSTS = ["claude-code", "opencode", "codex"]
const SKILLS = ["goal-tasks", "to-tickets"]
const dir = (host: string, skill: string) => join(REPO_ROOT, "skills", host, skill)
const read = (host: string, skill: string, name = "SKILL.md") => readFileSync(join(dir(host, skill), name), "utf8")
const example = JSON.parse(read("claude-code", "to-tickets", "example-plan.json"))

describe("to-tickets skill", () => {
  test("the example plan passes the core's validation", () => {
    expect(validatePlan(example, { platform: "win32" }).errors).toEqual([])
  })

  test("the example, in two batches as the skill says, goes through --draft, --add, --show and --commit", async () => {
    const repo = makeRepo()
    await tasksOk(repo, ["plan", "--draft", "--name", example.feature, "--objective", example.objective])
    const { tasks, ...rest } = example
    await tasksOk(repo, ["plan", "--add"], { json: { ...rest, tasks: tasks.slice(0, 3) } })
    await tasksOk(repo, ["plan", "--add"], { json: tasks.slice(3) })
    expect((await tasksOk(repo, ["plan", "--show"])).text.split("\n")[0]).toMatch(/: 5 tarefa\(s\)$/)
    const committed = await tasksOk(repo, ["plan", "--commit"])
    const next = await tasksOk(repo, ["next"], { boundRun: committed.bind! })
    expect((next.data as { ready: { id: string }[] }).ready.map((t) => t.id)).toEqual(["T01"])
  })

  test("the skill states the batch commands, the ownership rules and the never-by-hand rule, in every host", () => {
    for (const host of HOSTS) {
      const text = read(host, "to-tickets")
      for (const needle of ["tasks plan --draft", "tasks plan --add", "tasks plan --fix <id>", "tasks plan --show", "tasks plan --commit", "`dir/**`", "`src/*.ts` is refused", "Never edit `tasks.json`"])
        expect(text, host).toContain(needle)
    }
  })
})

describe("the skills of every agent", () => {
  test("six skills, each with a front matter that names it and says when to use it", () => {
    for (const host of HOSTS)
      for (const skill of SKILLS) {
        const text = read(host, skill)
        const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
        expect(front, `${host}/${skill}`).not.toBeNull()
        expect(front![1]).toContain(`name: ${skill}\n`)
        expect(front![1]).toMatch(/\ndescription: .{40,}/)
        expect(text, `${host}/${skill}`).not.toMatch(/\{\{\w+\}\}/)
      }
  })

  test("the three versions of a skill have the same sections and differ only in how the host calls the tool", () => {
    for (const skill of SKILLS) {
      const headings = HOSTS.map((h) => read(h, skill).split("\n").filter((l) => l.startsWith("#")))
      expect(headings[1]).toEqual(headings[0]!)
      expect(headings[2]).toEqual(headings[0]!)
      expect(headings[0]!.length).toBeGreaterThan(3)
    }
    expect(read("claude-code", "goal-tasks")).toContain("mcp__goal-tasks__tasks")
    expect(read("opencode", "goal-tasks")).toContain("`subagent` tool")
    expect(read("codex", "goal-tasks")).toContain("in the shell")
    expect(read("codex", "goal-tasks")).not.toContain("mcp__goal-tasks__tasks")
  })

  test("goal-tasks covers doctor, the loop, ownership, timeout, deadlock, lost ownership, /goal and the exit codes", () => {
    for (const host of HOSTS) {
      const text = read(host, "goal-tasks")
      for (const needle of ["tasks doctor", "tasks next", "tasks start <id>", "tasks claim <id> <file>", "tasks done <id> --evidence", "tasks fail <id>", "tasks status", "Deadlock", "Ownership lost", "Without /goal", "With /goal", "## Exit codes"])
        expect(text, `${host}: ${needle}`).toContain(needle)
    }
  })

  test("no profile of the old names and the side files are the same in every host and in the mod", () => {
    for (const host of HOSTS)
      for (const skill of SKILLS)
        for (const name of readdirSync(dir(host, skill))) {
          expect(read(host, skill, name), `${host}/${skill}/${name}`).not.toMatch(/"(impl|deep)"|\bimpl-deep\b|`(impl|deep)`/)
          if (name !== "SKILL.md") expect(read(host, skill, name)).toBe(read("claude-code", skill, name))
          if (host === "claude-code")
            expect(readFileSync(join(REPO_ROOT, "claude/skills", skill, name), "utf8"), `mod copy of ${skill}/${name}`).toBe(read(host, skill, name))
        }
  })
})
