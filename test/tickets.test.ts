import { describe, expect, test } from "bun:test"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES } from "../src/schema.ts"
import { renderTicket, ticketFileName } from "../src/tickets.ts"

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

  test("file names use the task number and the title's slug", () => {
    expect(ticketFileName(tasks[1]!, 1)).toBe("02-integracao-suite.md")
    expect(ticketFileName({ ...tasks[0]!, id: "setup" }, 6)).toBe("07-base.md")
  })
})
