import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { toTask } from "../src/plan.ts"
import { DEFAULT_PROFILES, type RunFile } from "../src/schema.ts"
import { normalizeBrief, renderContext, renderTicket } from "../src/tickets.ts"
import { contextWarnings, readContext, validatePlan } from "../src/validate.ts"
import { select } from "../src/i18n.ts"
import { cleanupTemp, makeRepo, runPath, tasks, tasksOk, tempDir } from "./helpers.ts"

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
    expect(readContext([]).errors).toEqual(['context must be an object with brief (path of the common brief, plan only), summary (text), read (list of paths), consult (list of { path, why }) and constraints (list of texts)'])
    expect(readContext({ summary: 1, read: "x", notes: [] }).errors).toEqual([
      'context: unknown field "notes" (use brief, summary, read, consult, constraints)',
      "context.summary must be text",
      "context.read must be a list of texts",
    ])
    expect(readContext({ summary: "  a\r\nb  ", read: [" p.md ", "p.md", ""], constraints: [] })).toEqual({ context: { summary: "a\nb", read: ["p.md"] }, errors: [] })
    expect(readContext({ summary: " " })).toEqual({ errors: [] })

    const bad = validatePlan({ context: { read: [1] }, tasks: [{ id: "T01", title: "A", context: "x" }] }, { platform: "win32" })
    expect(bad.errors).toEqual([
      "context.read must be a list of texts",
      "T01: context must be an object with brief (path of the common brief, plan only), summary (text), read (list of paths), consult (list of { path, why }) and constraints (list of texts)",
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

// ── The common brief and the consult list (0.6.0) ─────────────────────────────────────────────────────────────

const BRIEF = [
  "# Login por link mágico",
  "",
  "Problema: senhas esquecidas geram 40% dos chamados. Decidido: token de uso único, 15 minutos, guardado com hash.",
  "",
  "- Interface comum: `sendMagicLink(email): Promise<void>` em `src/auth/link.ts`.",
  "- Convenção: erros como `AuthError` com `code`.",
].join("\n")

const briefPlan = (briefPath: string) => ({
  feature: "brief",
  objective: "Resumo comum nos tickets",
  context: { brief: briefPath, constraints: ["Código em inglês."] },
  tasks: [
    { id: "T01", title: "Base", what: "O usuário pede um link e recebe o e-mail.", files: ["src/a.ts"], acceptance: ["passa"] },
    {
      id: "T02",
      title: "Consumo",
      what: "O link abre a sessão uma única vez.",
      dependsOn: ["T01"],
      files: ["src/b.ts"],
      acceptance: ["passa"],
      context: {
        summary: "Comece por `src/auth/session.ts:createSession`; o hash é sha256 hex.",
        read: ["src/auth/session.ts"],
        consult: [{ path: "_work/30-plan/PLAN.md#tokens", why: "se a regra de expiração parecer ambígua" }],
      },
    },
  ],
})

describe("common brief and consult list", () => {
  test("validation: brief only at run level, consult needs path and why, key order fixed", () => {
    select({ lang: "en", env: () => undefined })
    expect(readContext({ brief: 3 }).errors).toEqual(["context.brief must be the path of a Markdown file (text)"])
    expect(readContext({ brief: "b.md" }, "T01: context", { task: true }).errors).toEqual([
      "T01: context.brief is only for the plan's context (the run's common brief); a task adds only its own summary, read, consult and constraints",
    ])
    const consultError = 'context.consult must be a list of { "path": text, "why": text }: a document to open only in case of doubt, and the reason'
    expect(readContext({ consult: ["a.md"] }).errors).toEqual([consultError])
    expect(readContext({ consult: [{ path: "a.md" }] }).errors).toEqual([consultError])
    expect(readContext({ consult: [{ path: "a.md", why: "x", extra: 1 }] }).errors).toEqual([consultError])
    const read = readContext({ consult: [{ why: " b ", path: " a.md " }, { path: "a.md", why: "again" }], read: ["r.md"], brief: " b.md " })
    expect(read).toEqual({ context: { brief: "b.md", read: ["r.md"], consult: [{ path: "a.md", why: "b" }] }, errors: [] })
    expect(Object.keys(read.context!)).toEqual(["brief", "read", "consult"])
    const plan = validatePlan({ tasks: [{ id: "T01", title: "A", context: { brief: "x.md" } }] }, { platform: "win32" })
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain("T01: context.brief is only for the plan's context")
  })

  test("rendering: the brief verbatim first, then only the task's own context; pure", () => {
    const p = briefPlan("brief.md")
    const run = { brief: "brief.md", constraints: ["Código em inglês."] }
    const all = p.tasks.map((t) => toTask(t, DEFAULT_PROFILES))
    const section = renderContext(run, all[1]!.context, BRIEF).join("\n")
    expect(section).toBe(
      [
        "## Context",
        "",
        BRIEF,
        "",
        "Comece por `src/auth/session.ts:createSession`; o hash é sha256 hex.",
        "",
        "**Read first:**",
        "",
        "- `src/auth/session.ts`",
        "",
        "**If in doubt, consult:**",
        "",
        "- `_work/30-plan/PLAN.md#tokens`: se a regra de expiração parecer ambígua",
        "",
        "**Constraints:**",
        "",
        "- Código em inglês.",
        "",
      ].join("\n"),
    )
    // Same input, same bytes; each ticket's section starts with the brief, byte for byte.
    const once = renderTicket(all[1]!, 1, all, run, BRIEF)
    expect(renderTicket(structuredClone(all[1]!), 1, structuredClone(all), structuredClone(run), `${BRIEF}`)).toBe(once)
    for (let i = 0; i < all.length; i++) expect(renderTicket(all[i]!, i, all, run, BRIEF)).toContain(`## Context\n\n${BRIEF}\n\n`)
    // A consult entry already in Read first is not repeated.
    expect(renderContext({ read: ["a.md"] }, { consult: [{ path: "a.md", why: "x" }] }).join("\n")).not.toContain("If in doubt")
    // A brief the run names but whose file is gone is said, not silently left out.
    expect(renderContext(run, undefined, null).join("\n")).toContain("**Brief:** missing")
    expect(normalizeBrief("\uFEFF\r\n\r\n# T\r\n\r\n  x  \r\n\r\n")).toBe("# T\n\n  x")
  })

  test("repeated information is warned: context restating what, the run's context or the brief", () => {
    select({ lang: "en", env: () => undefined })
    const p = briefPlan("brief.md")
    expect(contextWarnings({ context: { read: ["r.md"] }, tasks: validatePlan(p, { platform: "win32" }).plan.tasks }, BRIEF)).toEqual([])
    const what = "O link abre a sessão uma única vez e expira em 15 minutos."
    const warnings = contextWarnings(
      {
        context: { read: ["_work/30-plan/PLAN.md"], constraints: ["Código em inglês."] },
        tasks: [
          {
            id: "T01",
            title: "A",
            what,
            context: {
              summary: what,
              read: ["_work/30-plan/PLAN.md"],
              constraints: ["Código em inglês."],
              consult: [{ path: "_work/30-plan/PLAN.md", why: "x" }],
            },
          },
          { id: "T02", title: "B", context: { summary: "Decidido: token de uso único, 15 minutos, guardado com hash." } },
        ],
      },
      BRIEF,
    )
    expect(warnings).toEqual([
      "T01: context.summary repeats the task's what; the context adds only what the executor needs to know how (decisions, interfaces, pitfalls, the code to start from)",
      "T01: context repeats _work/30-plan/PLAN.md, which the run's context already gives every ticket; remove it",
      "T01: context repeats _work/30-plan/PLAN.md, which the run's context already gives every ticket; remove it",
      "T01: context repeats Código em inglês., which the run's context already gives every ticket; remove it",
      "T02: context.summary repeats text of the common brief, which every ticket already shows; remove it",
    ])
  })

  test("plan keeps one copy of the brief in the run's folder and renders it in every ticket; context --set replaces it", async () => {
    select({ lang: "en", env: () => undefined })
    const repo = makeRepo()
    const outside = tempDir("brief")
    const source = join(outside, "brief.md").replace(/\\/g, "/")

    // A missing or empty brief file is a plan error with a clear message; nothing is created.
    const missing = await tasks(repo, ["plan", "--lang", "en"], { json: briefPlan(source) })
    expect(missing.code).toBe(1)
    expect(missing.text).toContain(`context.brief: cannot read ${source}`)
    writeFileSync(source, " \r\n\r\n")
    const empty = await tasks(repo, ["plan", "--lang", "en"], { json: briefPlan(source) })
    expect(empty.code).toBe(1)
    expect(empty.text).toContain(`context.brief: ${source} is empty`)
    expect((await tasks(repo, ["validate", "--lang", "en"], { json: briefPlan(source) })).text).toContain("is empty")

    writeFileSync(source, `\r\n${BRIEF.replace(/\n/g, "\r\n")}\r\n\r\n`)
    expect((await tasksOk(repo, ["validate"], { json: briefPlan(source) })).code).toBe(0)
    const r = await tasksOk(repo, ["plan"], { json: briefPlan(source) })
    const id = (r.data as { run: string }).run
    const run = JSON.parse(readFileSync(await runPath(repo, id, "run.json"), "utf8")) as RunFile
    expect(run.context).toEqual({ brief: "brief.md", constraints: ["Código em inglês."] })
    expect(readFileSync(await runPath(repo, id, "brief.md"), "utf8")).toBe(`${BRIEF}\n`)
    const first = await ticketText(repo, id, "01-")
    const second = await ticketText(repo, id, "02-")
    expect(first).toContain(`## Context\n\n${BRIEF}\n\n**Constraints:**`)
    expect(first).not.toContain("If in doubt")
    expect(second).toContain(`## Context\n\n${BRIEF}\n\nComece por`)
    expect(second).toContain("**If in doubt, consult:**\n\n- `_work/30-plan/PLAN.md#tokens`: se a regra de expiração parecer ambígua")

    // A transition rewrites a ticket with the same brief, byte for byte.
    await tasksOk(repo, ["start", "T01"])
    expect(await ticketText(repo, id, "01-")).toContain(`## Context\n\n${BRIEF}\n\n`)

    // `context` shows the brief and where its one copy is.
    const shown = await tasksOk(repo, ["context"])
    expect(shown.text).toContain(BRIEF)
    expect((shown.data as { brief: string }).brief.endsWith("/brief.md")).toBe(true)

    // context --set with a new brief replaces the run's copy and rewrites the unfinished tickets.
    const next = join(outside, "brief2.md").replace(/\\/g, "/")
    writeFileSync(next, "Novo resumo comum.\n")
    const bad = await tasks(repo, ["context", "--set", "--lang", "en"], { json: { brief: join(outside, "nope.md") } })
    expect(bad.code).toBe(1)
    expect(bad.text).toContain("cannot read")
    expect(readFileSync(await runPath(repo, id, "brief.md"), "utf8")).toBe(`${BRIEF}\n`)
    await tasksOk(repo, ["context", "--set"], { json: { brief: next } })
    expect(readFileSync(await runPath(repo, id, "brief.md"), "utf8")).toBe("Novo resumo comum.\n")
    const rewritten = await ticketText(repo, id, "02-")
    expect(rewritten).toContain("## Context\n\nNovo resumo comum.\n\nComece por")
    expect(rewritten).not.toContain("Login por link mágico")

    // --unset removes the brief and its file.
    await tasksOk(repo, ["context", "--unset"])
    expect(existsSync(await runPath(repo, id, "brief.md"))).toBe(false)
    expect(await ticketText(repo, id, "02-")).toContain("## Context\n\nComece por")
  })

  test("in batches: the brief written in the draft's folder is the one copy and reaches the run", async () => {
    const repo = makeRepo()
    const opened = await tasksOk(repo, ["plan", "--draft", "--name", "lotes-brief"])
    const { draft: id, brief } = opened.data as { draft: string; brief: string }
    expect(opened.text).toContain(brief)
    writeFileSync(brief, BRIEF)
    const p = briefPlan(brief)
    await tasksOk(repo, ["plan", "--add"], { json: { context: p.context, tasks: [p.tasks[0]] } })
    await tasksOk(repo, ["plan", "--add"], { json: [p.tasks[1]] })
    await tasksOk(repo, ["plan", "--commit"])
    const dir = await runPath(repo, id)
    expect(readdirSync(dir).filter((n) => n.endsWith(".md"))).toEqual(["brief.md"])
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe(`${BRIEF}\n`)
    expect(await ticketText(repo, id, "01-")).toContain(`## Context\n\n${BRIEF}\n\n`)
    expect(await ticketText(repo, id, "02-")).toContain(`## Context\n\n${BRIEF}\n\nComece por`)
  })

  test("a 0.5 run context (summary, read, constraints) renders as before", () => {
    const old = { summary: "Resumo.", read: ["a.md"], constraints: ["c"] }
    expect(renderContext(old, undefined).join("\n")).toBe(["## Context", "", "Resumo.", "", "**Read first:**", "", "- `a.md`", "", "**Constraints:**", "", "- c", ""].join("\n"))
  })
})
