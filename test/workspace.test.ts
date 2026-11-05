// Where run data lives (src/workspace.ts): the legacy `<repo>/.scratch/jtasks`, a jproject container's
// `jtasks_data` (cwd = the container, or inside product/), JTASKS_SCRATCH and the saved setting. Outside the legacy
// mode nothing is written inside the repository: no `.scratch`, no line in `.git/info/exclude`, `git status` clean.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Host } from "../src/host.ts"
import { findContainer, parseFrontMatter, readConfig, resolvePaths } from "../src/workspace.ts"
import { cleanupTemp, host, sh, tasks, tasksOk, tempDir, writeFiles } from "./helpers.ts"

afterAll(cleanupTemp)

const plan = { tasks: [{ id: "T01", title: "Base", files: ["src/a.ts"] }, { id: "T02", title: "Next", files: ["src/b.ts"], dependsOn: ["T01"] }] }

const slash = (p: string) => p.replace(/\\/g, "/")
const same = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase()

/** The node host with some variables replaced (the core reads them through the host). */
function withEnv(vars: Record<string, string>): Host {
  return { ...host, env: (name) => (name in vars ? vars[name] : host.env(name)) }
}

function frontMatter(extra: Record<string, string> = {}): string {
  const keys = { jproject: "1", project: "demo", product_dir: "product", work_dir: "_work", secrets_dir: "_secrets", jtasks_data: "_work/30-plan/jtasks", ...extra }
  return `---\n${Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Workspace map: demo\n`
}

/** A jproject container: `<work>/WORKSPACE.md` with the front matter, and `product/` a git repository with one commit. */
function makeContainer(options: { work?: string; product?: string; fm?: Record<string, string> } = {}) {
  const work = options.work ?? "_work"
  const product = options.product ?? "product"
  const root = slash(tempDir("container"))
  writeFiles(root, { [`${work}/WORKSPACE.md`]: frontMatter({ work_dir: work, product_dir: product, ...options.fm }), "CLAUDE.md": "# Container\n" })
  const repo = `${root}/${product}`
  mkdirSync(repo, { recursive: true })
  sh(repo, "git", "init", "-q", "-b", "main")
  sh(repo, "git", "config", "user.email", "test@example.test")
  sh(repo, "git", "config", "user.name", "Test")
  sh(repo, "git", "config", "commit.gpgsign", "false")
  sh(repo, "git", "config", "core.autocrlf", "false")
  writeFiles(repo, { "README.md": "# product\n", "src/keep.txt": "x\n" })
  sh(repo, "git", "add", "-A")
  sh(repo, "git", "commit", "-q", "-m", "init")
  return { root, repo, exclude: readFileSync(join(repo, ".git/info/exclude"), "utf8") }
}

/** Nothing of jtasks inside the repository. */
function expectRepoUntouched(repo: string, exclude: string) {
  expect(existsSync(join(repo, ".scratch"))).toBe(false)
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toBe(exclude)
  expect(sh(repo, "git", "status", "--porcelain", "--untracked-files=all")).toBe("")
}

describe("front matter and container discovery", () => {
  test("parseFrontMatter reads key: value lines, quotes and comments; none without the fences", () => {
    expect(parseFrontMatter(frontMatter())).toMatchObject({ jproject: "1", product_dir: "product", jtasks_data: "_work/30-plan/jtasks" })
    expect(parseFrontMatter('---\njproject: 1 # map\njtasks_data: "my data/x"\n---\n')).toEqual({ jproject: "1", jtasks_data: "my data/x" })
    expect(parseFrontMatter("# no front matter\njproject: 1\n")).toBeUndefined()
    expect(parseFrontMatter("---\njproject: 1\n")).toBeUndefined()
  })

  test("found from the container, from inside product/, and with another work_dir name", async () => {
    const { root, repo } = makeContainer()
    const fromRoot = (await findContainer(host, root))!
    expect(same(fromRoot.root, root)).toBe(true)
    expect(same(fromRoot.product, repo)).toBe(true)
    expect(same(fromRoot.jtasksData!, `${root}/_work/30-plan/jtasks`)).toBe(true)
    mkdirSync(join(repo, "src/deep"), { recursive: true })
    expect(same((await findContainer(host, `${repo}/src/deep`))!.root, root)).toBe(true)
    const other = makeContainer({ work: "_ai", product: "code" })
    const found = (await findContainer(host, other.root))!
    expect(same(found.work, `${other.root}/_ai`)).toBe(true)
    expect(same(found.product, other.repo)).toBe(true)
  })

  test("a WORKSPACE.md without jproject: 1 is not a container", async () => {
    const dir = slash(tempDir("not-container"))
    writeFiles(dir, { "_work/WORKSPACE.md": "---\nproject: x\n---\n" })
    expect(await findContainer(host, dir)).toBeUndefined()
    expect(await resolvePaths(host, dir)).toBeUndefined()
  })
})

describe("resolvePaths", () => {
  test("a plain repository keeps the legacy .scratch/jtasks", async () => {
    const repo = slash(tempDir("plain"))
    sh(repo, "git", "init", "-q", "-b", "main")
    const p = (await resolvePaths(host, repo))!
    expect(p.source).toBe("legacy")
    expect(same(p.dataDir, `${repo}/.scratch/jtasks`)).toBe(true)
    expect(p.inRepo).toBe(".scratch/jtasks")
    expect(p.container).toBeUndefined()
  })

  test("cwd = the container, or inside product/: repository = product, data = jtasks_data", async () => {
    const { root, repo } = makeContainer()
    for (const cwd of [root, repo, `${repo}/src`]) {
      const p = (await resolvePaths(host, cwd))!
      expect(same(p.repoRoot, repo)).toBe(true)
      expect(same(p.dataDir, `${root}/_work/30-plan/jtasks`)).toBe(true)
      expect(p.source).toBe("workspace")
      expect(p.inRepo).toBeUndefined()
    }
  })

  test("jtasks_data of the front matter: relative to the container, or absolute; missing: the default", async () => {
    const own = makeContainer({ fm: { jtasks_data: "_work/plans/runs-data" } })
    expect(same((await resolvePaths(host, own.root))!.dataDir, `${own.root}/_work/plans/runs-data`)).toBe(true)
    const abs = slash(tempDir("abs-data"))
    const absolute = makeContainer({ fm: { jtasks_data: abs } })
    expect(same((await resolvePaths(host, absolute.root))!.dataDir, abs)).toBe(true)
    const none = makeContainer({ fm: { jtasks_data: "" } })
    expect(same((await resolvePaths(host, none.root))!.dataDir, `${none.root}/_work/30-plan/jtasks`)).toBe(true)
  })

  test("JTASKS_SCRATCH wins: relative to the container (or the repository), or absolute (shared)", async () => {
    const { root } = makeContainer()
    const rel = (await resolvePaths(withEnv({ JTASKS_SCRATCH: "_work/elsewhere" }), root))!
    expect(rel.source).toBe("env")
    expect(same(rel.dataDir, `${root}/_work/elsewhere`)).toBe(true)
    expect(rel.shared).toBe(false)
    const abs = slash(tempDir("env-data"))
    const absolute = (await resolvePaths(withEnv({ JTASKS_SCRATCH: abs }), root))!
    expect(same(absolute.dataDir, abs)).toBe(true)
    expect(absolute.shared).toBe(true)
  })

  test("the saved setting comes after the variable and before the front matter; relative only in a container", async () => {
    const home = slash(tempDir("cfg-home"))
    const h = withEnv({ JTASKS_HOME: home })
    const { root, repo } = makeContainer()
    await tasksOk(root, ["config", "data-dir", "_work/from-config"], { host: h })
    expect(await readConfig(h)).toEqual({ dataDir: "_work/from-config" })
    const p = (await resolvePaths(h, root))!
    expect(p.source).toBe("config")
    expect(same(p.dataDir, `${root}/_work/from-config`)).toBe(true)
    expect(same((await resolvePaths(withEnv({ JTASKS_HOME: home, JTASKS_SCRATCH: "x" }), repo))!.dataDir, `${root}/x`)).toBe(true)
    // A plain repository ignores a relative setting (it is meant for containers): legacy.
    const plain = slash(tempDir("plain-cfg"))
    sh(plain, "git", "init", "-q", "-b", "main")
    expect((await resolvePaths(h, plain))!.source).toBe("legacy")
    await tasksOk(root, ["config", "data-dir", "--unset"], { host: h })
    expect(await readConfig(h)).toEqual({})
    expect((await resolvePaths(h, root))!.source).toBe("workspace")
  })
})

describe("a run in a jproject container", () => {
  for (const where of ["the container", "product/src"] as const) {
    test(`from ${where}: data in _work/30-plan/jtasks, nothing in product/`, async () => {
      const { root, repo, exclude } = makeContainer()
      const cwd = where === "the container" ? root : `${repo}/src`
      const r = await tasksOk(cwd, ["plan", "--name", "demo"], { json: plan })
      const run = r.bind!
      expect(same(r.bindPaths!.root, repo)).toBe(true)
      expect(same(r.bindPaths!.data, `${root}/_work/30-plan/jtasks`)).toBe(true)
      const dir = join(root, "_work/30-plan/jtasks/runs", run)
      expect(readdirSync(dir).sort()).toEqual(expect.arrayContaining(["ledger.jsonl", "log.jsonl", "run.json", "tasks.json", "tickets"]))
      // The run's branch is in product/ (git), nothing else is.
      expect(sh(repo, "git", "branch", "--show-current").trim()).toBe(`gt/${run}`)
      expectRepoUntouched(repo, exclude)
      expect((await tasksOk(cwd, ["runs"])).text).toContain(run)
      expect((await tasksOk(cwd, ["next"])).text).toContain("T01")
      // The ledger has no exclude effect; undo of the whole run touches no exclude either.
      const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf8")
      expect(ledger).not.toContain('"exclude"')
      await tasksOk(cwd, ["undo", "--run", run])
      expectRepoUntouched(repo, exclude)
    })
  }

  test("a draft in batches stays out of the repository too; gc sees the run by the resolved data folder", async () => {
    const { root, repo, exclude } = makeContainer()
    await tasksOk(root, ["plan", "--draft", "--name", "lote"])
    await tasksOk(root, ["plan", "--add"], { json: plan })
    const r = await tasksOk(root, ["plan", "--commit"])
    expect(existsSync(join(root, "_work/30-plan/jtasks/runs", r.bind!, "run.json"))).toBe(true)
    expectRepoUntouched(repo, exclude)
    const gc = await tasksOk(root, ["gc", "--scan", join(root, "_work")])
    expect((gc.data as { findings: { type: string }[] }).findings.map((f) => f.type)).toEqual(["run"])
  })

  test("clean --all removes the data folder's runs, never product/", async () => {
    const { root, repo, exclude } = makeContainer()
    await tasksOk(root, ["plan", "--name", "a"], { json: { ...plan, branch: "current" } })
    await tasksOk(root, ["clean", "--all", "--yes"])
    expect(existsSync(join(root, "_work/30-plan/jtasks/runs"))).toBe(false)
    expectRepoUntouched(repo, exclude)
  })

  test("outside a repository and outside a container: refused, nothing written", async () => {
    const dir = slash(tempDir("nothing"))
    const r = await tasks(dir, ["plan"], { json: plan })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("container jproject")
    expect(readdirSync(dir)).toEqual([])
  })
})

describe("an external data folder for a plain repository", () => {
  test("JTASKS_SCRATCH absolute: nothing in the repository, and runs lists only this repository's runs", async () => {
    const data = slash(tempDir("shared-data"))
    const h = withEnv({ JTASKS_SCRATCH: data })
    const mk = (name: string) => {
      const repo = slash(tempDir(name))
      sh(repo, "git", "init", "-q", "-b", "main")
      sh(repo, "git", "config", "user.email", "test@example.test")
      sh(repo, "git", "config", "user.name", "Test")
      sh(repo, "git", "config", "commit.gpgsign", "false")
      writeFiles(repo, { "README.md": "# r\n" })
      sh(repo, "git", "add", "-A")
      sh(repo, "git", "commit", "-q", "-m", "init")
      return { repo, exclude: existsSync(join(repo, ".git/info/exclude")) ? readFileSync(join(repo, ".git/info/exclude"), "utf8") : "" }
    }
    const a = mk("ext-a")
    const b = mk("ext-b")
    const ra = await tasksOk(a.repo, ["plan", "--name", "aaa"], { json: { ...plan, branch: "current" }, host: h })
    const rb = await tasksOk(b.repo, ["plan", "--name", "bbb"], { json: { ...plan, branch: "current" }, host: h })
    expect(existsSync(join(data, "runs", ra.bind!, "tasks.json"))).toBe(true)
    expect(existsSync(join(data, "runs", rb.bind!, "tasks.json"))).toBe(true)
    for (const x of [a, b]) {
      expect(existsSync(join(x.repo, ".scratch"))).toBe(false)
      expect(existsSync(join(x.repo, ".git/info/exclude")) ? readFileSync(join(x.repo, ".git/info/exclude"), "utf8") : "").toBe(x.exclude)
      expect(sh(x.repo, "git", "status", "--porcelain", "--untracked-files=all")).toBe("")
    }
    const runsA = (await tasksOk(a.repo, ["runs"], { host: h })).text
    expect(runsA).toContain(ra.bind!)
    expect(runsA).not.toContain(rb.bind!)
    // With one run of its own, `status` needs no --run even though the folder holds two.
    expect((await tasksOk(b.repo, ["status"], { host: h })).text).toContain("0/2")
  })
})

describe("doctor and config", () => {
  test("doctor says where run data goes here; --fix --yes --data-dir saves it", async () => {
    const home = slash(tempDir("doc-home"))
    const userHome = slash(tempDir("doc-user"))
    const h = withEnv({ JTASKS_HOME: home, JTASKS_USER_HOME: userHome })
    const { root } = makeContainer()
    const r = await tasks(root, ["doctor", "--lang", "en"], { host: h, packageRoot: "." })
    const data = (r.data as { checks: { name: string; status: string; detail: string; fix?: string }[] }).checks.find((c) => c.name === "data")!
    expect(data.status).toBe("ok")
    expect(data.detail).toContain("_work/30-plan/jtasks (the container's WORKSPACE.md)")
    expect(data.fix).toContain("jtasks config data-dir <path>")
    const fix = await tasksOk(root, ["doctor", "--fix", "--yes", "--data-dir", "_work/30-plan/jtasks", "--lang", "en"], { host: h, packageRoot: "." })
    expect(fix.text).toContain("data folder saved: _work/30-plan/jtasks")
    expect(await readConfig(h)).toEqual({ dataDir: "_work/30-plan/jtasks" })
  })

  test("doctor --fix without an answer and without a terminal asks nothing and shows the question", async () => {
    const home = slash(tempDir("doc-home2"))
    const h = withEnv({ JTASKS_HOME: home, JTASKS_USER_HOME: slash(tempDir("doc-user2")) })
    const { root } = makeContainer()
    const r = await tasksOk(root, ["doctor", "--fix", "--lang", "en"], { host: h, packageRoot: "." })
    expect(r.text).toContain("Where should jtasks store run data (tasks, tickets, ledger)?")
    expect(await readConfig(h)).toEqual({})
  })
})
