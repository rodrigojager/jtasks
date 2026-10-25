// Plan validation (section 3). Every message is meant for the model that wrote the plan: it says what is wrong
// and what to do. Same input, same errors, in the same order.

import { relConflicts } from "./keys.ts"
import { caseInsensitive, isAbsolute, normalize, slash } from "./paths.ts"
import { DEFAULT_PROFILES, type PlanInput, type PlanTask, type Profile, DURATION } from "./schema.ts"
import { tr } from "./i18n.ts"

const TASK_FIELDS = new Set(["id", "title", "what", "source", "dependsOn", "files", "acceptance", "profile", "boundary", "exclusive", "touchesShared"])
const PLAN_FIELDS = new Set(["feature", "objective", "source", "profiles", "serialize", "maxAttempts", "holdTtl", "keepalive", "branch", "shared", "sharedPolicy", "tasks"])
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
  if (p === "") return { error: tr("plan.empty_path") }
  if (isAbsolute(p)) return { error: tr("plan.absolute_path", { path: raw }) }
  while (p.startsWith("./")) p = p.slice(2)
  if (p.endsWith("/**")) p = p.slice(0, -3) || "."
  if (GLOB.test(p)) {
    const segments = p.split("/")
    const firstGlob = segments.findIndex((s) => GLOB.test(s))
    const folder = segments.slice(0, firstGlob).join("/")
    const hint = folder ? tr("plan.pattern_hint_folder", { folder }) : tr("plan.pattern_hint")
    return { error: tr("plan.pattern", { path: raw, hint }) }
  }
  const n = normalize(p).replace(/\/+$/, "")
  if (n === ".." || n.startsWith("../")) return { error: tr("plan.outside_repo", { path: raw }) }
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
  else return { plan: { tasks: [] }, errors: [tr("plan.shape")] }

  for (const key of Object.keys(obj)) if (!PLAN_FIELDS.has(key)) errors.push(tr("plan.unknown_field", { field: key }))
  const plan: PlanInput = { tasks: [] }
  if (obj.feature !== undefined) {
    if (typeof obj.feature === "string") plan.feature = obj.feature
    else errors.push(tr("plan.must_be_text", { field: "feature" }))
  }
  if (obj.objective !== undefined) {
    if (typeof obj.objective === "string") plan.objective = obj.objective
    else errors.push(tr("plan.must_be_text", { field: "objective" }))
  }
  if (obj.source !== undefined) {
    if (typeof obj.source === "string") plan.source = obj.source
    else errors.push(tr("plan.must_be_text", { field: "source" }))
  }
  if (obj.profiles !== undefined) {
    if (obj.profiles && typeof obj.profiles === "object" && !Array.isArray(obj.profiles)) {
      const profiles: Record<string, Profile> = {}
      for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) profiles[name] = value as Profile
        else errors.push(tr("plan.profile_object", { name }))
      }
      plan.profiles = profiles
    } else errors.push(tr("plan.profiles_object"))
  }
  if (obj.serialize !== undefined) {
    if (isStringList(obj.serialize)) plan.serialize = obj.serialize
    else errors.push(tr("plan.serialize_list"))
  }
  if (obj.maxAttempts !== undefined) {
    if (typeof obj.maxAttempts === "number" && Number.isInteger(obj.maxAttempts) && obj.maxAttempts >= 1)
      plan.maxAttempts = obj.maxAttempts
    else errors.push(tr("plan.max_attempts"))
  }
  if (obj.holdTtl !== undefined) {
    if (typeof obj.holdTtl === "string" && DURATION.test(obj.holdTtl)) plan.holdTtl = obj.holdTtl
    else errors.push(tr("plan.hold_ttl"))
  }
  if (obj.keepalive !== undefined) {
    if (typeof obj.keepalive === "boolean") plan.keepalive = obj.keepalive
    else errors.push(tr("plan.keepalive"))
  }
  if (obj.branch !== undefined) {
    if (obj.branch === "run" || obj.branch === "current") plan.branch = obj.branch
    else errors.push(tr("plan.branch"))
  }
  if (obj.shared !== undefined) {
    if (isStringList(obj.shared)) plan.shared = obj.shared
    else errors.push(tr("plan.shared_list"))
  }
  if (obj.sharedPolicy !== undefined) {
    if (obj.sharedPolicy === "warn" || obj.sharedPolicy === "serialize") plan.sharedPolicy = obj.sharedPolicy
    else errors.push(tr("plan.shared_policy"))
  }
  if (!Array.isArray(obj.tasks)) {
    errors.push(tr("plan.no_tasks"))
    return { plan, errors }
  }

  obj.tasks.forEach((raw, index) => {
    const name = label(raw, index)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(tr("plan.task_object", { name }))
      return
    }
    const t = raw as Record<string, unknown>
    const before = errors.length
    for (const key of Object.keys(t)) if (!TASK_FIELDS.has(key)) errors.push(tr("plan.task_unknown_field", { name, field: key }))
    if (typeof t.id !== "string" || !t.id.trim()) errors.push(tr("plan.task_missing", { name, field: "id" }))
    if (typeof t.title !== "string" || !t.title.trim()) errors.push(tr("plan.task_missing", { name, field: "title" }))
    if (t.what !== undefined && typeof t.what !== "string") errors.push(tr("plan.task_text", { name, field: "what" }))
    if (t.source !== undefined && typeof t.source !== "string") errors.push(tr("plan.task_text", { name, field: "source" }))
    if (t.dependsOn !== undefined && !isStringList(t.dependsOn)) errors.push(tr("plan.task_depends_list", { name }))
    if (t.files !== undefined && !isStringList(t.files)) errors.push(tr("plan.task_files_list", { name }))
    if (t.touchesShared !== undefined && !isStringList(t.touchesShared)) errors.push(tr("plan.task_touches_list", { name }))
    if (t.profile !== undefined && typeof t.profile !== "string") errors.push(tr("plan.task_text", { name, field: "profile" }))
    if (t.boundary !== undefined && typeof t.boundary !== "string") errors.push(tr("plan.task_text", { name, field: "boundary" }))
    if (t.exclusive !== undefined && typeof t.exclusive !== "boolean") errors.push(tr("plan.task_exclusive", { name }))
    if (t.acceptance !== undefined) {
      const ok =
        Array.isArray(t.acceptance) &&
        t.acceptance.every(
          (a) => typeof a === "string" || (a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string"),
        )
      if (!ok) errors.push(tr("plan.task_acceptance", { name }))
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
    if (seen.has(task.id)) errors.push(tr("plan.duplicate_id", { id: task.id }))
    seen.add(task.id)
    if (task.profile !== undefined && !(task.profile in profiles))
      errors.push(tr("plan.unknown_profile", { id: task.id, profile: task.profile, profiles: Object.keys(profiles).join(", ") }))
    const paths = (list: string[]) => {
      const out: string[] = []
      for (const raw of list) {
        const entry = normalizeFileEntry(raw)
        if (entry.error) errors.push(`${task.id}: ${entry.error}`)
        else if (entry.path && !out.includes(entry.path)) out.push(entry.path)
      }
      return out
    }
    const files = paths(task.files ?? [])
    if (task.dependsOn?.includes(task.id)) errors.push(tr("plan.self_dependency", { id: task.id }))
    const checked: PlanTask = { ...task, files }
    if (task.touchesShared) checked.touchesShared = paths(task.touchesShared)
    out.push(checked)
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
  /** What does not refuse the plan but deserves a look (rev. 5.6: shared files in parallel tasks). */
  warnings: string[]
}

/** The complete validation (`validate`, `plan`, `plan --commit`). */
export function validatePlan(raw: unknown, options: ValidateOptions = {}): FullResult {
  const read = readPlan(raw)
  const errors = [...read.errors]
  const profiles = { ...(read.plan.profiles ?? DEFAULT_PROFILES) }
  const batch = validateBatch(read.plan.tasks, { ...options, profiles })
  errors.push(...batch.errors)
  const plan: PlanInput = { ...read.plan, tasks: batch.tasks }
  if (plan.shared) {
    const shared: string[] = []
    for (const raw of plan.shared) {
      const entry = normalizeFileEntry(raw)
      if (entry.error) errors.push(`shared: ${entry.error}`)
      else if (entry.path && !shared.includes(entry.path)) shared.push(entry.path)
    }
    plan.shared = shared
  }
  errors.push(...validateGraph(plan.tasks, options))
  const insensitive = caseInsensitive(options.platform ?? "win32")
  for (const t of plan.tasks)
    for (const p of t.touchesShared ?? [])
      if (!(plan.shared ?? []).some((s) => relCovers(s, p, insensitive))) errors.push(tr("plan.touches_not_shared", { id: t.id, path: p }))
  return { plan, errors, warnings: sharedWarnings(plan, options) }
}

function relCovers(outer: string, inner: string, insensitive: boolean): boolean {
  const o = insensitive ? outer.toLowerCase() : outer
  const i = insensitive ? inner.toLowerCase() : inner
  return o === "." || o === i || i.startsWith(`${o}/`)
}

/** The `shared` entries a task touches: in `touchesShared`, or overlapping its `files` (claimed ones too, in a run). */
export function sharedTouched(shared: string[], task: Pick<PlanTask, "files" | "touchesShared"> & { claimed?: string[] }, insensitive: boolean): string[] {
  return shared.filter(
    (s) =>
      (task.touchesShared ?? []).some((p) => relConflicts(s, p, insensitive)) ||
      [...(task.files ?? []), ...(task.claimed ?? [])].some((f) => relConflicts(s, f, insensitive)),
  )
}

/**
 * Two tasks with no dependency path between them that touch the same `shared` file: a warning that says how to
 * order them. None with `sharedPolicy: "serialize"`, where the frontier keeps them apart; none for two that own it
 * in `files` (that is already an error).
 */
export function sharedWarnings(plan: PlanInput, options: ValidateOptions = {}): string[] {
  const shared = plan.shared ?? []
  if (!shared.length || plan.sharedPolicy === "serialize") return []
  const insensitive = caseInsensitive(options.platform ?? "win32")
  const anc = ancestors(plan.tasks)
  const related = (a: string, b: string) => anc.get(a)?.has(b) || anc.get(b)?.has(a)
  const out: string[] = []
  const touched = new Map(plan.tasks.map((t) => [t.id, t.exclusive ? [] : sharedTouched(shared, t, insensitive)]))
  for (let i = 0; i < plan.tasks.length; i++)
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]!
      const b = plan.tasks[j]!
      if (related(a.id, b.id)) continue
      for (const s of touched.get(a.id)!.filter((x) => touched.get(b.id)!.includes(x))) {
        if (sharedPath(a.files ?? [], b.files ?? [], insensitive)) continue
        out.push(tr("plan.shared_parallel", { a: a.id, b: b.id, path: s }))
      }
    }
  return out
}

/** Checks that need the whole set: dependencies, cycles, ownership shared by independent tasks. */
export function validateGraph(tasks: PlanTask[], options: ValidateOptions = {}): string[] {
  const errors: string[] = []
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks)
    for (const dep of t.dependsOn ?? [])
      if (!ids.has(dep)) errors.push(tr("plan.missing_dependency", { id: t.id, dep }))
  for (const cycle of findCycles(tasks)) errors.push(tr("plan.cycle", { cycle: cycle.join(" → ") }))

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
        const cover = hit.outer !== hit.inner ? ` ${tr("plan.covers", { outer: hit.outer, inner: hit.inner })}` : ""
        errors.push(tr("plan.shared", { a: a.id, b: b.id, path: hit.inner, cover }))
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
