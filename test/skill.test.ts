import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validatePlan } from "../src/validate.ts"
import { REPO_ROOT, cleanupTemp, makeRepo, tasksOk } from "./helpers.ts"

// Real git processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const SKILL = join(REPO_ROOT, "skills/to-tickets")
const example = JSON.parse(readFileSync(join(SKILL, "example-plan.json"), "utf8"))

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

  test("the skill states the batch commands, the ownership rules and the never-by-hand rule", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8")
    for (const needle of ["tasks plan --draft", "tasks plan --add", "tasks plan --fix <id>", "tasks plan --show", "tasks plan --commit", "`dir/**`", "`src/*.ts` is refused", "Never edit `tasks.json`"])
      expect(text).toContain(needle)
  })

  test("the copy inside the mod is the same as the canonical one", () => {
    for (const name of ["SKILL.md", "schema.json", "example-plan.json"])
      expect(readFileSync(join(REPO_ROOT, "claude/skills/to-tickets", name), "utf8")).toBe(readFileSync(join(SKILL, name), "utf8").replace(/\r\n/g, "\n"))
  })
})
