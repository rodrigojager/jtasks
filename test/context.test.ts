import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES, type RunFile } from "../src/schema.ts"
import { renderContext, renderTicket } from "../src/tickets.ts"
import { readContext, validatePlan } from "../src/validate.ts"
import { select } from "../src/i18n.ts"
import { cleanupTemp, makeRepo, runPath, tasks, tasksOk } from "./helpers.ts"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const context = {
  summary: "Login por link mágico. Decidido: token de uso único, 15 minutos.",
  read: ["_work/30-plan/PLAN.md", "_work/10-docs/adr/0001-token.md"],
  constraints: ["Tudo em inglês no código.", "Nunca tocar em src/legacy."],
}

const plan = {
  feature: "contexto",
  objective: "Contexto nos tickets",
  context,
  tasks: [
    { id: "T01", title: "Base", files: ["src/a.ts"], acceptance: ["passa"] },
    {
      id: "T02",
      title: "Segunda",
      dependsOn: ["T01"],
      files: ["src/b.ts"],
      acceptance: ["passa"],
      context: { summary: "Esta tarefa só mexe no envio.", read: ["_work/30-plan/PLAN-mail.md", "_work/30-plan/PLAN.md"] },
    },
  ],
}

const ticketText = async (repo: string, run: string, prefix: string) => {
  const dir = await runPath(repo, run, "tickets")
  const name = readdirSync(dir).find((n) => n.startsWith(prefix))!
  return readFileSync(join(dir, name), "utf8")
}

describe("run context", () => {
  test("validation: shape, unknown fields and types are refused with the block named; text is normalized", () => {
    select({ lang: "en", env: () => undefined })
    expect(readContext([]).errors).toEqual(['context must be an object with summary (text), read (list of paths) and constraints (list of texts)'])
    expect(readContext({ summary: 1, read: "x", notes: [] }).errors).toEqual([
      'context: unknown field "notes" (use summary, read, constraints)',
      "context.summary must be text",
      "context.read must be a list of texts",
    ])
    expect(readContext({ summary: "  a\r\nb  ", read: [" p.md ", "p.md", ""], constraints: [] })).toEqual({ context: { summary: "a\nb", read: ["p.md"] }, errors: [] })
    expect(readContext({ summary: " " })).toEqual({ errors: [] })

    const bad = validatePlan({ context: { read: [1] }, tasks: [{ id: "T01", title: "A", context: "x" }] }, { platform: "win32" })
    expect(bad.errors).toEqual([
      "context.read must be a list of texts",
      "T01: context must be an object with summary (text), read (list of paths) and constraints (list of texts)",
    ])
    const good = validatePlan(plan, { platform: "win32" })
    expect(good.errors).toEqual([])
    expect(good.plan.context).toEqual(context)
    expect(good.plan.tasks[1]!.context!.read).toEqual(["_work/30-plan/PLAN-mail.md", "_work/30-plan/PLAN.md"])
  })

  test("rendering: the run's block, then the task's addition, paths deduplicated; same input, same bytes", () => {
    const task = toTask(plan.tasks[1]!, DEFAULT_PROFILES)
    expect(renderContext(context, task.context).join("\n")).toBe(
      [
        "## Context",
        "",
        "Login por link mágico. Decidido: token de uso único, 15 minutos.",
        "",
        "Esta tarefa só mexe no envio.",
        "",
        "**Read first:**",
        "",
        "- `_work/30-plan/PLAN.md`",
        "- `_work/10-docs/adr/0001-token.md`",
        "- `_work/30-plan/PLAN-mail.md`",
        "",
        "**Constraints:**",
        "",
        "- Tudo em inglês no código.",
        "- Nunca tocar em src/legacy.",
        "",
      ].join("\n"),
    )
    const all = [toTask(plan.tasks[0]!, DEFAULT_PROFILES), task]
    const once = renderTicket(task, 1, all, context)
    expect(renderTicket(task, 1, structuredClone(all), structuredClone(context))).toBe(once)
    expect(once.endsWith("- Nunca tocar em src/legacy.\n")).toBe(true)
    // No context anywhere: no section, the ticket as before.
    expect(renderTicket(all[0]!, 0, all)).not.toContain("## Context")
    expect(renderContext(undefined, undefined)).toEqual([])
  })

  test("plan writes the context once in run.json and renders it in every ticket", async () => {
    const repo = makeRepo()
    const r = await tasksOk(repo, ["plan"], { json: plan })
    const id = (r.data as { run: string }).run
    const run = JSON.parse(readFileSync(await runPath(repo, id, "run.json"), "utf8")) as RunFile
    expect(run.context).toEqual(context)
    const first = await ticketText(repo, id, "01-")
    expect(first).toContain("## Context\n\nLogin por link mágico.")
    expect(first).toContain("- `_work/30-plan/PLAN.md`\n- `_work/10-docs/adr/0001-token.md`\n\n**Constraints:**")
    expect(first).not.toContain("Esta tarefa só mexe no envio.")
    const second = await ticketText(repo, id, "02-")
    expect(second).toContain("Esta tarefa só mexe no envio.")
    expect(second).toContain("- `_work/30-plan/PLAN-mail.md`")

    // `context` shows the run's block; `context --set` replaces it and rewrites every ticket not finished.
    expect((await tasksOk(repo, ["context"])).text).toContain("**Read first:**")
    await tasksOk(repo, ["skip", "T01", "--reason", "fora"])
    const skipped = await ticketText(repo, id, "01-")
    const set = await tasksOk(repo, ["context", "--set"], { json: { summary: "Novo resumo.", read: ["docs/PLAN.md"] } })
    expect((set.data as { tickets: string[] }).tickets).toHaveLength(1)
    expect(await ticketText(repo, id, "01-")).toBe(skipped)
    const rewritten = await ticketText(repo, id, "02-")
    expect(rewritten).toContain("## Context\n\nNovo resumo.\n\nEsta tarefa só mexe no envio.")
    expect(rewritten).not.toContain("Login por link mágico.")
    expect(rewritten).not.toContain("**Constraints:**")
    expect(((await tasksOk(repo, ["context"])).data as { context: unknown }).context).toEqual({ summary: "Novo resumo.", read: ["docs/PLAN.md"] })

    // A bad block is refused and changes nothing; --unset clears it.
    const refused = await tasks(repo, ["context", "--set", "--lang", "en"], { json: { summary: 3 } })
    expect(refused.code).toBe(1)
    expect(refused.text).toContain("context.summary must be text")
    expect(await ticketText(repo, id, "02-")).toBe(rewritten)
    await tasksOk(repo, ["context", "--unset"])
    const cleared = await ticketText(repo, id, "02-")
    expect(cleared).toContain("## Context\n\nEsta tarefa só mexe no envio.")
    expect(cleared).not.toContain("Novo resumo.")
    expect((await tasksOk(repo, ["context", "--lang", "en"])).text).toContain("no shared context")
  })

  test("in batches: the context arrives with any --add and reaches the run at --commit", async () => {
    const repo = makeRepo()
    const opened = await tasksOk(repo, ["plan", "--draft", "--name", "lotes"])
    const id = (opened.data as { draft: string }).draft
    await tasksOk(repo, ["plan", "--add"], { json: { context, tasks: [plan.tasks[0]] } })
    await tasksOk(repo, ["plan", "--add"], { json: [plan.tasks[1]] })
    const bad = await tasks(repo, ["plan", "--add", "--lang", "en"], { json: { context: { extra: 1 }, tasks: [] } })
    expect(bad.code).toBe(1)
    expect(bad.text).toContain('context: unknown field "extra"')
    await tasksOk(repo, ["plan", "--commit"])
    expect(await ticketText(repo, id, "01-")).toContain("## Context\n\nLogin por link mágico.")
    expect(await ticketText(repo, id, "02-")).toContain("Esta tarefa só mexe no envio.")
  })
})
