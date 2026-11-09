import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { writeFileSync } from "node:fs"
import { createNodeHost } from "../src/node-host.ts"
import { runTool } from "../src/tool.ts"
import { normalizeFileEntry, validatePlan } from "../src/validate.ts"
import { cleanupTemp, tempDir } from "./helpers.ts"

// Real git and jlock processes: a busy machine needs more than the default 5 s.
setDefaultTimeout(60_000)

afterAll(cleanupTemp)

const errorsOf = (plan: unknown) => validatePlan(plan, { platform: "win32" }).errors

const good = {
  objective: "Integrar o gerador",
  tasks: [
    { id: "T01", title: "Base", files: ["src/humanizer/trajectory.ts", "tests/humanizer/**"], acceptance: ["passa"] },
    { id: "T02", title: "Gerador", dependsOn: ["T01"], files: ["src/recorder/**"] },
    { id: "T03", title: "Paridade", dependsOn: ["T01"], files: ["src/humanizer/parity"], profile: "execute-deep" },
    { id: "T04", title: "Integração", dependsOn: ["T02", "T03"], exclusive: true, profile: "review" },
  ],
}

describe("validatePlan", () => {
  test("a good plan passes and normalizes files", () => {
    const { plan, errors } = validatePlan(good, { platform: "win32" })
    expect(errors).toEqual([])
    expect(plan.tasks[0]!.files).toEqual(["src/humanizer/trajectory.ts", "tests/humanizer"])
    expect(plan.tasks[1]!.files).toEqual(["src/recorder"])
  })

  test("an array of tasks is a plan too", () => {
    expect(errorsOf(good.tasks)).toEqual([])
  })

  test("schema errors name the task and the field", () => {
    expect(errorsOf({ tasks: [{ title: "sem id" }] })).toEqual([`tarefa #1: falta "id"`])
    expect(errorsOf({ tasks: [{ id: "T01" }] })).toEqual([`T01: falta "title"`])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", dependsOn: "T02" }] })).toEqual([`T01: "dependsOn" deve ser uma lista de ids`])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", file: ["a"] }] })).toEqual([`T01: campo desconhecido "file"`])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", exclusive: "yes" }] })).toEqual([`T01: "exclusive" deve ser "project", "machine", true (= "project") ou false`])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: [{ resource: "desktop", mode: "both" }] }] })).toEqual([
      `T01: "uses" deve ser uma lista de nomes de recursos ("desktop", "port:8080") ou de { "resource": "<nome>", "mode": "shared" | "exclusive" }`,
    ])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", acceptance: [1] }] })).toEqual([`T01: "acceptance" deve ser uma lista de critérios (texto)`])
    expect(errorsOf(42)).toEqual([`o plano deve ser uma lista de tarefas ou um objeto com "tasks"`])
    expect(errorsOf({ maxAttempts: 0, tasks: [] })).toEqual([`"maxAttempts" deve ser um inteiro maior que zero`])
  })

  test("repeated id, missing dependency, unknown profile", () => {
    expect(
      errorsOf([
        { id: "T01", title: "a" },
        { id: "T01", title: "b", dependsOn: ["T09"], profile: "fast" },
      ]),
    ).toEqual([
      "id repetido: T01",
      `T01: perfil desconhecido "fast" (perfis: execute, execute-deep, review)`,
      "T01 depende de T09, que não existe",
    ])
  })

  test("a plan's own profiles replace the defaults", () => {
    const plan = { profiles: { fast: { claude: { model: "haiku" } } }, tasks: [{ id: "T01", title: "a", profile: "execute" }] }
    expect(errorsOf(plan)).toEqual([`T01: perfil desconhecido "execute" (perfis: fast)`])
  })

  test("cycles come with their path", () => {
    expect(
      errorsOf([
        { id: "T01", title: "a", dependsOn: ["T02"] },
        { id: "T02", title: "b", dependsOn: ["T01"] },
        { id: "T03", title: "c", dependsOn: ["T03"] },
      ]),
    ).toEqual(["T03 depende de si mesma", "ciclo: T01 → T02 → T01"])
  })

  test("patterns are refused, dir/** becomes the folder", () => {
    expect(errorsOf([{ id: "T01", title: "a", files: ["src/*.ts"] }])).toEqual([
      "T01: src/*.ts: o jlock trava arquivos e pastas, não padrões; liste os arquivos ou use a pasta src",
    ])
    expect(normalizeFileEntry("src/**")).toEqual({ path: "src" })
    expect(normalizeFileEntry("./src/")).toEqual({ path: "src" })
    expect(normalizeFileEntry("src\\a.ts")).toEqual({ path: "src/a.ts" })
    expect(normalizeFileEntry("*.md").error).toBe(
      "*.md: o jlock trava arquivos e pastas, não padrões; liste os arquivos, use uma pasta ou marque a tarefa como exclusive",
    )
  })

  test("absolute paths and paths outside the repository are refused", () => {
    expect(errorsOf([{ id: "T01", title: "a", files: ["D:/x/a.ts", "../b.ts"] }])).toEqual([
      "T01: D:/x/a.ts: use caminhos relativos ao repositório",
      "T01: ../b.ts: sai do repositório",
    ])
  })

  test("ownership shared by independent tasks", () => {
    expect(
      errorsOf([
        { id: "T04", title: "a", files: ["src/humanizer/move.ts"] },
        { id: "T05", title: "b", files: ["src/humanizer/move.ts"] },
      ]),
    ).toEqual(["T04 e T05 tocam src/humanizer/move.ts e podem rodar juntas: adicione uma dependência ou separe o arquivo"])
    expect(
      errorsOf([
        { id: "T04", title: "a", files: ["src"] },
        { id: "T05", title: "b", files: ["SRC/a.ts"] },
      ]),
    ).toEqual(["T04 e T05 tocam SRC/a.ts (src cobre SRC/a.ts) e podem rodar juntas: adicione uma dependência ou separe o arquivo"])
  })

  test("shared ownership is fine through a dependency, even an indirect one, and for exclusive tasks", () => {
    expect(
      errorsOf([
        { id: "T01", title: "a", files: ["src/a.ts"] },
        { id: "T02", title: "b", dependsOn: ["T01"] },
        { id: "T03", title: "c", dependsOn: ["T02"], files: ["src"] },
        { id: "T04", title: "d", exclusive: true, files: ["src"] },
      ]),
    ).toEqual([])
  })

  test("same input, same errors in the same order", () => {
    const bad = [
      { id: "B", title: "b", files: ["x/*"], dependsOn: ["Z"] },
      { id: "A", title: "a", files: ["y"] },
      { id: "C", title: "c", files: ["y/z"] },
    ]
    expect(errorsOf(bad)).toEqual(errorsOf(structuredClone(bad)))
  })
})

describe("jtasks validate", () => {
  const host = createNodeHost()

  test("prints every error and exits 1; a good plan says ok", async () => {
    const dir = tempDir("validate")
    writeFileSync(`${dir}/bad.json`, JSON.stringify([{ id: "T01", title: "a", files: ["src/*.ts"] }]))
    writeFileSync(`${dir}/good.json`, JSON.stringify(good))
    const bad = await runTool({ host, cwd: dir, tool: "cli" }, ["validate", "@bad.json"])
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe(1)
    expect(bad.text).toContain("o jlock trava arquivos e pastas, não padrões")
    const ok = await runTool({ host, cwd: dir, tool: "cli" }, ["validate", "@good.json"])
    expect(ok).toMatchObject({ ok: true, code: 0, text: "ok: 4 tarefa(s), nenhum erro" })
  })

  test("the CLI process exits with the code", () => {
    const dir = tempDir("validate-cli")
    writeFileSync(`${dir}/bad.json`, "[{}]")
    const proc = Bun.spawnSync(["bun", `${import.meta.dir}/../cli/jtasks.ts`, "validate", "@bad.json"], { cwd: dir })
    expect(proc.exitCode).toBe(1)
    expect(proc.stderr.toString()).toContain(`tarefa #1: falta "id"`)
  })

  test("unknown action is a usage error", async () => {
    const r = await runTool({ host, cwd: ".", tool: "cli" }, ["frobnicate"])
    expect(r).toMatchObject({ ok: false, code: 2 })
  })
})

describe("exclusive scopes and uses (0.7.0)", () => {
  test("exclusive true is project; uses become { resource, mode } with the catalogue's default, normalized and merged", () => {
    const { plan, errors } = validatePlan(
      {
        tasks: [
          { id: "T01", title: "a", exclusive: true },
          { id: "T02", title: "b", exclusive: "machine" },
          { id: "T03", title: "c", files: ["x"], uses: ["Desktop", "resource:port:08080", { resource: "machine", mode: "shared" }, { resource: "desktop", mode: "shared" }] },
        ],
      },
      { platform: "win32" },
    )
    expect(errors).toEqual([])
    expect(plan.tasks.map((t) => t.exclusive)).toEqual(["project", "machine", undefined])
    expect(plan.tasks[2]!.uses).toEqual([
      { resource: "desktop", mode: "exclusive" },
      { resource: "machine", mode: "shared" },
      { resource: "port:8080", mode: "exclusive" },
    ])
  })

  test("an unknown resource is refused at validation with the closest name; arguments are checked", async () => {
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: ["desktp"] }] })).toEqual([
      `T01: recurso desconhecido "desktp"; você quis dizer "desktop"? (jlock resources lista todos)`,
    ])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: ["zzzzzz"] }] })[0]).toContain("jlock resources lista os nomes")
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: ["port"] }] })).toEqual([
      `T01: o recurso "port" precisa de um argumento: port:<n> (por exemplo port:8080)`,
    ])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: ["desktop:2"] }] })).toEqual([`T01: o recurso "desktop" não aceita argumento`])
    expect(errorsOf({ tasks: [{ id: "T01", title: "x", uses: ["port:70000"] }] })).toEqual([`T01: "70000" não é uma porta (1 a 65535)`])
    // The same through the tool, which asks jlock for its catalogue.
    const dir = tempDir("validate-uses")
    const r = await runTool({ host: createNodeHost(), cwd: dir, tool: "cli", json: { tasks: [{ id: "T01", title: "x", uses: ["clipbord"] }] } }, ["validate"])
    expect(r.ok).toBe(false)
    expect(r.text).toContain(`você quis dizer "clipboard"?`)
  })

  test("a task that talks about the mouse, the clipboard, a fixed port or measurements without uses gets a warning", () => {
    const { warnings, errors } = validatePlan(
      {
        tasks: [
          { id: "T01", title: "Clica com o mouse no botão real", files: ["a"] },
          { id: "T02", title: "Cola da área de transferência", files: ["b"] },
          { id: "T03", title: "Sobe o servidor", what: "abre http://localhost:3000 e confere", files: ["c"] },
          { id: "T04", title: "Benchmark do parser", files: ["d"] },
          { id: "T05", title: "Clica com o mouse", files: ["e"], uses: ["desktop"] },
          { id: "T06", title: "Benchmark do parser", files: ["f"], exclusive: "machine" },
          { id: "T07", title: "Refatora o parser", files: ["g"] },
        ],
      },
      { platform: "win32" },
    )
    expect(errors).toEqual([])
    const ids = warnings.map((w) => w.split(" ")[0])
    expect(ids).toEqual(["T01", "T02", "T03", "T04"])
    expect(warnings[0]).toContain(`"uses": ["desktop"]`)
    expect(warnings[1]).toContain(`"uses": ["clipboard"]`)
    expect(warnings[2]).toContain(`"uses": ["port:3000"]`)
    expect(warnings[3]).toContain(`"exclusive": "machine"`)
  })

  test("two independent tasks using one exclusive resource are warned they will run one at a time", () => {
    const { warnings } = validatePlan(
      {
        tasks: [
          { id: "T01", title: "a", files: ["a"], uses: ["gpu"] },
          { id: "T02", title: "b", files: ["b"], uses: ["gpu"] },
          { id: "T03", title: "c", files: ["c"], dependsOn: ["T01"], uses: ["gpu"] },
          { id: "T04", title: "d", files: ["d"], uses: [{ resource: "network", mode: "shared" }] },
          { id: "T05", title: "e", files: ["e"], uses: [{ resource: "network", mode: "shared" }] },
        ],
      },
      { platform: "win32" },
    )
    expect(warnings).toEqual([
      "T01 e T02 usam gpu de forma exclusiva e não dependem uma da outra: vão rodar uma de cada vez",
      "T02 e T03 usam gpu de forma exclusiva e não dependem uma da outra: vão rodar uma de cada vez",
    ])
  })
})
