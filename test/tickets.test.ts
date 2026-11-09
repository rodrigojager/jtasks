import { describe, expect, test } from "bun:test"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES } from "../src/schema.ts"
import { parseTicket, renderTicket, ticketFileName } from "../src/tickets.ts"
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

describe("tickets", () => {
  const tasks = [
    toTask({ id: "T01", title: "Base", what: "A base do movimento.", files: ["src/a.ts", "src/b"], acceptance: ["passa", "testa"] }, DEFAULT_PROFILES),
    toTask({ id: "T02", title: "Integração: suíte", dependsOn: ["T01"], exclusive: true, profile: "review", boundary: "só a suíte" }, DEFAULT_PROFILES),
  ]

  test("the jlock ticket format, from tasks.json", () => {
    expect(renderTicket(tasks[0]!, 0, tasks)).toBe(
      [
        "# 01: Base",
        "",
        "**What to build:** A base do movimento.",
        "",
        "**Blocked by:** None (can start immediately)",
        "",
        "**Status:** pending",
        "",
        "**Profile:** execute",
        "",
        "**Files:** `src/a.ts`, `src/b`",
        "",
        "- [ ] passa",
        "- [ ] testa",
        "",
      ].join("\n"),
    )
    const second = renderTicket(tasks[1]!, 1, tasks)
    expect(second).toContain("# 02: Integração: suíte")
    expect(second).toContain("**Blocked by:** 01")
    expect(second).toContain("**Files:** (exclusive: roda sozinha)")
    expect(second).toContain("**Scope boundary:** só a suíte")
  })

  test("a ticket shows what the task uses and an exclusive machine scope; import reads them back", () => {
    const used = toTask({ id: "T03", title: "Clica", files: ["src/ui.ts"], uses: ["desktop", { resource: "gpu", mode: "shared" }] }, DEFAULT_PROFILES)
    const quiet = toTask({ id: "T04", title: "Mede", exclusive: "machine" }, DEFAULT_PROFILES)
    const text = renderTicket(used, 2, [...tasks, used, quiet])
    expect(text).toContain("**Files:** `src/ui.ts`\n\n**Uses:** `desktop`, `gpu` (shared)")
    expect(renderTicket(quiet, 3, [...tasks, used, quiet])).toContain(
      "**Files:** (exclusive: machine — espera todas as tarefas da máquina e roda sozinha)",
    )
    const back = parseTicket(text, "03-clica.md", 2)
    expect(back.task.uses).toEqual(["desktop", { resource: "gpu", mode: "shared" }])
    expect(parseTicket(renderTicket(quiet, 3, [...tasks, used, quiet]), "04-mede.md", 3).task.exclusive).toBe("machine")
  })

  test("the plan's source reaches every ticket, and a task's own source wins", () => {
    const plan = "https://github.com/acme/app/issues/42"
    const own = toTask({ id: "T01", title: "Base", source: "docs/spec.md" }, DEFAULT_PROFILES, plan)
    const inherited = toTask({ id: "T02", title: "Outra" }, DEFAULT_PROFILES, plan)
    expect(renderTicket(own, 0, [own, inherited])).toContain("**What to build:** Base\n\n**Source:** docs/spec.md\n\n**Blocked by:**")
    expect(renderTicket(inherited, 1, [own, inherited])).toContain(`**Source:** ${plan}\n`)
    expect(renderTicket(tasks[0]!, 0, tasks)).not.toContain("**Source:**")
  })

  test("file names use the task number and the title's slug", () => {
    expect(ticketFileName(tasks[1]!, 1)).toBe("02-integracao-suite.md")
    expect(ticketFileName({ ...tasks[0]!, id: "setup" }, 6)).toBe("07-base.md")
  })
})
