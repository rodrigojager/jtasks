// Plan validation (section 3). Every message is meant for the model that wrote the plan: it says what is wrong
// and what to do. Same input, same errors, in the same order.

import { relConflicts } from "./keys.ts"
import { caseInsensitive, isAbsolute, normalize, slash } from "./paths.ts"
import { DEFAULT_PROFILES, type PlanInput, type PlanTask, type Profile, DURATION } from "./schema.ts"

const TASK_FIELDS = new Set(["id", "title", "what", "dependsOn", "files", "acceptance", "profile", "boundary", "exclusive"])
const PLAN_FIELDS = new Set(["feature", "objective", "profiles", "serialize", "maxAttempts", "holdTtl", "branch", "tasks"])
const GLOB = /[*?[\]{}]/

export interface ValidateOptions {
  platform?: string
}

export interface FileEntry {
  path?: string
  error?: string
}

/** One ownership entry: relative, `/`, no `./` and no trailing `/`; `dir/**` becomes `dir`; patterns refused. */
export function normalizeFileEntry(raw: string): FileEntry {
  let p = slash(raw.trim())
  if (p === "") return { error: `caminho vazio em "files"` }
  if (isAbsolute(p)) return { error: `${raw}: use caminhos relativos ao repositório` }
  while (p.startsWith("./")) p = p.slice(2)
  if (p.endsWith("/**")) p = p.slice(0, -3) || "."
  if (GLOB.test(p)) {
    const segments = p.split("/")
    const firstGlob = segments.findIndex((s) => GLOB.test(s))
    const folder = segments.slice(0, firstGlob).join("/")
    const hint = folder
      ? `liste os arquivos ou use a pasta ${folder}`
      : `liste os arquivos, use uma pasta ou marque a tarefa como exclusive`
    return { error: `${raw}: o jlock trava arquivos e pastas, não padrões; ${hint}` }
  }
  const n = normalize(p).replace(/\/+$/, "")
  if (n === ".." || n.startsWith("../")) return { error: `${raw}: sai do repositório` }
  return { path: n || "." }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

function label(task: unknown, index: number): string {
  const id = (task as { id?: unknown })?.id
  return typeof id === "string" && id.trim() ? id : `tarefa #${index + 1}`
}

export interface ReadPlanResult {
  plan: PlanInput
  errors: string[]
}

/** Schema check of a whole plan or of one batch: an array of tasks, or an object with `tasks`. */
export function readPlan(raw: unknown): ReadPlanResult {
  const errors: string[] = []
  let obj: Record<string, unknown>
  if (Array.isArray(raw)) obj = { tasks: raw }
  else if (raw && typeof raw === "object") obj = raw as Record<string, unknown>
  else return { plan: { tasks: [] }, errors: ["o plano deve ser uma lista de tarefas ou um objeto com \"tasks\""] }

  for (const key of Object.keys(obj)) if (!PLAN_FIELDS.has(key)) errors.push(`campo desconhecido no plano: "${key}"`)
  const plan: PlanInput = { tasks: [] }
  if (obj.feature !== undefined) {
    if (typeof obj.feature === "string") plan.feature = obj.feature
    else errors.push(`"feature" deve ser texto`)
  }
  if (obj.objective !== undefined) {
    if (typeof obj.objective === "string") plan.objective = obj.objective
    else errors.push(`"objective" deve ser texto`)
  }
  if (obj.profiles !== undefined) {
    if (obj.profiles && typeof obj.profiles === "object" && !Array.isArray(obj.profiles)) {
      const profiles: Record<string, Profile> = {}
      for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) profiles[name] = value as Profile
        else errors.push(`perfil "${name}" deve ser um objeto ({ claude, opencode })`)
      }
      plan.profiles = profiles
    } else errors.push(`"profiles" deve ser um objeto`)
  }
  if (obj.serialize !== undefined) {
    if (isStringList(obj.serialize)) plan.serialize = obj.serialize
    else errors.push(`"serialize" deve ser uma lista de comandos`)
  }
  if (obj.maxAttempts !== undefined) {
    if (typeof obj.maxAttempts === "number" && Number.isInteger(obj.maxAttempts) && obj.maxAttempts >= 1)
      plan.maxAttempts = obj.maxAttempts
    else errors.push(`"maxAttempts" deve ser um inteiro maior que zero`)
  }
  if (obj.holdTtl !== undefined) {
    if (typeof obj.holdTtl === "string" && DURATION.test(obj.holdTtl)) plan.holdTtl = obj.holdTtl
    else errors.push(`"holdTtl" deve ser uma duração como 30m, 2h ou 1d`)
  }
  if (obj.branch !== undefined) {
    if (obj.branch === "run" || obj.branch === "current") plan.branch = obj.branch
    else errors.push(`"branch" deve ser "run" ou "current"`)
  }
  if (!Array.isArray(obj.tasks)) {
    errors.push(`falta "tasks": a lista de tarefas`)
    return { plan, errors }
  }

  obj.tasks.forEach((raw, index) => {
    const name = label(raw, index)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${name}: cada tarefa deve ser um objeto`)
      return
    }
    const t = raw as Record<string, unknown>
    const before = errors.length
    for (const key of Object.keys(t)) if (!TASK_FIELDS.has(key)) errors.push(`${name}: campo desconhecido "${key}"`)
    if (typeof t.id !== "string" || !t.id.trim()) errors.push(`${name}: falta "id"`)
    if (typeof t.title !== "string" || !t.title.trim()) errors.push(`${name}: falta "title"`)
    if (t.what !== undefined && typeof t.what !== "string") errors.push(`${name}: "what" deve ser texto`)
    if (t.dependsOn !== undefined && !isStringList(t.dependsOn)) errors.push(`${name}: "dependsOn" deve ser uma lista de ids`)
    if (t.files !== undefined && !isStringList(t.files)) errors.push(`${name}: "files" deve ser uma lista de caminhos`)
    if (t.profile !== undefined && typeof t.profile !== "string") errors.push(`${name}: "profile" deve ser texto`)
    if (t.boundary !== undefined && typeof t.boundary !== "string") errors.push(`${name}: "boundary" deve ser texto`)
    if (t.exclusive !== undefined && typeof t.exclusive !== "boolean") errors.push(`${name}: "exclusive" deve ser true ou false`)
    if (t.acceptance !== undefined) {
      const ok =
        Array.isArray(t.acceptance) &&
        t.acceptance.every(
          (a) => typeof a === "string" || (a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string"),
        )
      if (!ok) errors.push(`${name}: "acceptance" deve ser uma lista de critérios (texto)`)
    }
    if (errors.length === before) plan.tasks.push(t as unknown as PlanTask)
  })
  return { plan, errors }
}

export interface BatchContext extends ValidateOptions {
  /** Profiles known to the run (the plan's own, or the defaults). */
  profiles?: Record<string, Profile>
  /** Ids already in the draft (for `plan --add`). */
  existingIds?: Iterable<string>
}

/** What can be checked inside one batch: repeated ids, unknown profiles, patterns in `files`. */
export function validateBatch(tasks: PlanTask[], ctx: BatchContext = {}): { tasks: PlanTask[]; errors: string[] } {
  const errors: string[] = []
  const profiles = ctx.profiles ?? DEFAULT_PROFILES
  const seen = new Set(ctx.existingIds ?? [])
  const out: PlanTask[] = []
  for (const task of tasks) {
    if (seen.has(task.id)) errors.push(`id repetido: ${task.id}`)
    seen.add(task.id)
    if (task.profile !== undefined && !(task.profile in profiles))
      errors.push(`${task.id}: perfil desconhecido "${task.profile}" (perfis: ${Object.keys(profiles).join(", ")})`)
    const files: string[] = []
    for (const raw of task.files ?? []) {
      const entry = normalizeFileEntry(raw)
      if (entry.error) errors.push(`${task.id}: ${entry.error}`)
      else if (entry.path && !files.includes(entry.path)) files.push(entry.path)
    }
    if (task.dependsOn?.includes(task.id)) errors.push(`${task.id} depende de si mesma`)
    out.push({ ...task, files })
  }
  return { tasks: out, errors }
}

function findCycles(tasks: PlanTask[]): string[][] {
  const deps = new Map(tasks.map((t) => [t.id, (t.dependsOn ?? []).filter((d) => d !== t.id)]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seenSets = new Set<string>()
  const visit = (id: string) => {
    state.set(id, 1)
    stack.push(id)
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue
      const s = state.get(dep) ?? 0
      if (s === 0) visit(dep)
      else if (s === 1) {
        const cycle = stack.slice(stack.indexOf(dep))
        const signature = [...cycle].sort().join(",")
        if (!seenSets.has(signature)) {
          seenSets.add(signature)
          cycles.push([...cycle, dep])
        }
      }
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const t of tasks) if ((state.get(t.id) ?? 0) === 0) visit(t.id)
  return cycles
}

/** Every task each task depends on, directly or not. */
export function ancestors(tasks: PlanTask[]): Map<string, Set<string>> {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn ?? []]))
  const memo = new Map<string, Set<string>>()
  const walk = (id: string, path: Set<string>): Set<string> => {
    const cached = memo.get(id)
    if (cached) return cached
    const acc = new Set<string>()
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep) || path.has(dep)) continue
      acc.add(dep)
      path.add(dep)
      for (const a of walk(dep, path)) acc.add(a)
      path.delete(dep)
    }
    memo.set(id, acc)
    return acc
  }
  for (const id of deps.keys()) walk(id, new Set([id]))
  return memo
}

export interface FullResult {
  plan: PlanInput
  errors: string[]
}

/** The complete validation (`validate`, `plan`, `plan --commit`). */
export function validatePlan(raw: unknown, options: ValidateOptions = {}): FullResult {
  const read = readPlan(raw)
  const errors = [...read.errors]
  const profiles = { ...(read.plan.profiles ?? DEFAULT_PROFILES) }
  const batch = validateBatch(read.plan.tasks, { ...options, profiles })
  errors.push(...batch.errors)
  const plan: PlanInput = { ...read.plan, tasks: batch.tasks }
  errors.push(...validateGraph(plan.tasks, options))
  return { plan, errors }
}

/** Checks that need the whole set: dependencies, cycles, ownership shared by independent tasks. */
export function validateGraph(tasks: PlanTask[], options: ValidateOptions = {}): string[] {
  const errors: string[] = []
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks)
    for (const dep of t.dependsOn ?? [])
      if (!ids.has(dep)) errors.push(`${t.id} depende de ${dep}, que não existe`)
  for (const cycle of findCycles(tasks)) errors.push(`ciclo: ${cycle.join(" → ")}`)

  const insensitive = caseInsensitive(options.platform ?? "win32")
  const anc = ancestors(tasks)
  const related = (a: string, b: string) => anc.get(a)?.has(b) || anc.get(b)?.has(a)
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!
    if (a.exclusive) continue
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j]!
      if (b.exclusive || a.id === b.id || related(a.id, b.id)) continue
      const hit = sharedPath(a.files ?? [], b.files ?? [], insensitive)
      if (hit) {
        const cover = hit.outer !== hit.inner ? ` (${hit.outer} cobre ${hit.inner})` : ""
        errors.push(
          `${a.id} e ${b.id} tocam ${hit.inner}${cover} e podem rodar juntas: adicione uma dependência ou separe o arquivo`,
        )
      }
    }
  }
  return errors
}

function sharedPath(a: string[], b: string[], insensitive: boolean): { inner: string; outer: string } | undefined {
  for (const x of a)
    for (const y of b)
      if (relConflicts(x, y, insensitive)) {
        const xInY = x.length >= y.length
        return { inner: xInY ? x : y, outer: xInY ? y : x }
      }
  return undefined
}
