// Transient failures of the provider (plan rev. 5.7): a rate limit, a usage limit or quota, an overloaded or failing
// server, a dropped connection, a timeout, or the provider's own retries running out. The host that sees a subagent
// (or the orchestrator) die on one of them pauses the run instead of giving the task back: the task stays in
// progress with its locks, and on the way back (`unpause`, or the reset the host detects) the orchestrator is told to
// resume the same agent. Everything else (an invalid key, a bug, a refusal of the model, the context overflowing)
// goes on as before.
//
// This module is the classifier, the same in every host: tables of patterns over what the hosts can read of an error
// (Claude Code's StopFailure kind and text; OpenCode's structured error with its type, HTTP status and body, or the
// v1 APIError with statusCode and isRetryable), and the reset time the provider gave, when it gave one. Pure: the
// hosts call it, and the tests feed it the providers' real samples.

import { tr } from "./i18n.ts"
import type { AutoPause, PausedTask, RunFile, TransientKind } from "./schema.ts"

/** What a host read of one failure; every field is optional (each provider says some of it). */
export interface ProviderFailure {
  /**
   * The kind the host already gave it: Claude Code's StopFailure `error` (`rate_limit`, `overloaded`,
   * `authentication_failed`…), OpenCode's structured error `type` (`RateLimit`, `QuotaExceeded`, `Transport`…), or a
   * v1 error's `name` (`APIError`, `ProviderAuthError`…).
   */
  kind?: string
  /** The HTTP status, when the host has it (it is also looked for in the texts). */
  status?: number
  /** OpenCode v1's `APIError.isRetryable`. */
  retryable?: boolean
  /** The texts: the message, the details, the response body (OpenRouter's upstream error rides inside it). */
  texts?: (string | undefined | null)[]
  /** How long the provider asked to wait (OpenCode's `retryAfterMs`). */
  retryAfterMs?: number
  /** Response headers (`retry-after`, `x-ratelimit-reset`, `anthropic-ratelimit-unified-reset`). */
  headers?: Record<string, string | undefined>
}

export type Classification =
  | { transient: true; kind: TransientKind; detail: string; resetAt?: string }
  | { transient: false; why: string; detail: string }

type Verdict = TransientKind | "no"

/**
 * The kinds hosts give, lowercased: a transient kind, `no` (never transient), or absent (the texts decide).
 * Claude Code: StopFailure's `error`. OpenCode v2: the structured error's `type` (the AI error's tag). OpenCode v1:
 * the error's `name`.
 */
export const KIND_TABLE: Record<string, Verdict> = {
  // Claude Code (StopFailure `error`, the same word `turn.complete`'s API errors are classified with).
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  server_error: "server",
  billing_error: "quota",
  authentication_failed: "no",
  oauth_org_not_allowed: "no",
  account_on_hold: "no",
  verification_required: "no",
  invalid_request: "no",
  model_not_found: "no",
  max_output_tokens: "no",
  cloud_credential_error: "no",
  // OpenCode v2 (`AIError` reasons, as `session.execution.failed` and `session.retry.scheduled` carry them).
  ratelimit: "rate_limit",
  quotaexceeded: "quota",
  providerinternal: "server",
  transport: "network",
  timeout: "timeout",
  authentication: "no",
  contentpolicy: "no",
  invalidrequest: "no",
  unsupportedoperation: "no",
  noroute: "no",
  // OpenCode v1 (`session.error`'s error `name`).
  providerautherror: "no",
  messageoutputlengtherror: "no",
  contextoverflowerror: "no",
  messageabortederror: "no",
  structuredoutputerror: "no",
}

/** Never transient, whatever else the error says: the same error would come back. Checked first. */
export const PERMANENT: { why: string; re: RegExp }[] = [
  {
    why: "context",
    re: /prompt is too long|context[_\s-]?length[_\s-]?exceeded|maximum context length|context window (?:exceeds|limit)|exceeds? the context|model_context_window_exceeded|input is too long|request_too_large|request entity too large|payload too large/i,
  },
  {
    why: "auth",
    re: /invalid[_\s-]?(?:api[_\s-]?key|x-api-key|authentication)|incorrect api key|authentication[_\s-]?(?:error|failed)|\bunauthorized\b|permission[_\s-]?denied|oauth token (?:has )?(?:expired|been revoked)|please run \/login|no auth credentials|api[_\s-]?key (?:not valid|is invalid|expired)/i,
  },
  {
    why: "refusal",
    re: /content[_\s-]?(?:policy|filter|moderation)|usage policy|input was flagged|safety system|considered high risk|unsafe or sensitive/i,
  },
  { why: "model", re: /model[_\s-]?not[_\s-]?found|not_found_error|no such model|unknown model|model\b[^\n]{0,60}does not exist/i },
  { why: "output", re: /max_output_tokens|output token maximum|maximum output tokens/i },
]

/** Transient, by the words, in this order (the first that matches names the kind). */
export const TRANSIENT: { kind: TransientKind; re: RegExp }[] = [
  {
    kind: "quota",
    re: /usage limit|session limit|weekly limit|(?:hour|daily|monthly|weekly|session|usage) limit (?:reached|hit)|hit your (?:\w+ )?limit|out of (?:extra )?usage|insufficient[_\s-]?(?:quota|balance|credits?)|quota[_\s-]?exceeded|exceeded (?:your )?current quota|exceeded_current_quota|credit balance is too low|creditlimitexceeded|freeusagelimit|gousagelimit|usage_not_included|budget exceeded|\bquota\b/i,
  },
  { kind: "rate_limit", re: /rate[_\s-]?limit|too many requests|throttl|rate increased too quickly|requests per minute|max (?:rpm|tpm)\b|max rpm/i },
  { kind: "overloaded", re: /overloaded|at capacity|server (?:is )?busy/i },
  {
    kind: "network",
    re: /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+|fetch failed|socket hang up|network (?:error|is unreachable|connection)|connection (?:error|reset|refused|closed|lost)|socket connection was closed|unable to connect|other side closed|premature close/i,
  },
  { kind: "timeout", re: /timed out|\btimeout\b|deadline exceeded/i },
  {
    kind: "server",
    re: /internal server error|service[_\s-]?unavailable|temporarily unavailable|bad gateway|upstream (?:connect|error|request)|provider returned error|server_error|\bapi_error\b|internal_error|resource[_\s-]?exhausted|try again later/i,
  },
  { kind: "retries", re: /retries exhausted|exhausted (?:all )?retries|max(?:imum)? retries|after \d+ (?:retries|attempts)|retry limit/i },
]

/** An HTTP status inside a text: `API Error: 529 {…}`, `HTTP 429`, `"code": 429`, `status code 503`. */
const STATUS_IN_TEXT = [/^\s*(?:API Error:\s*)?([45]\d\d)\b/, /\bHTTP[ /]?(?:\d(?:\.\d)? )?([45]\d\d)\b/i, /"(?:code|status|statusCode)"\s*:\s*"?([45]\d\d)\b/, /\bstatus(?: code)?[:=\s]+([45]\d\d)\b/i]

export function httpStatusOf(failure: ProviderFailure): number | undefined {
  if (typeof failure.status === "number" && failure.status >= 400) return failure.status
  for (const text of failure.texts ?? []) {
    if (!text) continue
    for (const re of STATUS_IN_TEXT) {
      const m = re.exec(text)
      if (m) return Number(m[1])
    }
  }
  return undefined
}

function texts(failure: ProviderFailure): string[] {
  return (failure.texts ?? []).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
}

/** The strings of a JSON body that say why (`raw` first: OpenRouter's upstream error), unescaped. */
function inner(text: string): string[] {
  if (!/^\s*[{[]/.test(text)) return []
  const out: string[] = []
  for (const key of ["raw", "message", "detail", "error"])
    for (const m of text.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g"))) out.push(m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
  return out.flatMap((t) => [...inner(t), t])
}

/**
 * The provider's words, short: the text (or the string inside a JSON body) that says why, the one that names `want`
 * first (a pattern of that kind, or of the permanent reason).
 */
export function detailOf(failure: ProviderFailure, want?: RegExp, max = 240): string {
  const all = texts(failure)
  const candidates = all.flatMap((t) => [...inner(t), t])
  const any = [...TRANSIENT, ...PERMANENT]
  const pick =
    (want && candidates.find((t) => want.test(t) && !/^\s*[{[]/.test(t))) ??
    candidates.find((t) => any.some((p) => p.re.test(t)) && !/^\s*[{[]/.test(t)) ??
    candidates.find((t) => !/^\s*[{[]/.test(t)) ??
    all[0] ??
    failure.kind ??
    ""
  const flat = pick.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Transient or not, and what kind; with the reset time the provider gave, when it gave one. */
export function classifyFailure(failure: ProviderFailure, now: Date): Classification {
  const all = texts(failure)
  const text = all.join("\n")
  const status = httpStatusOf(failure)
  const permanent = PERMANENT.find((p) => p.re.test(text))
  if (permanent) return { transient: false, why: permanent.why, detail: detailOf(failure, permanent.re) }
  const detail = detailOf(failure)
  const byText = TRANSIENT.find((p) => p.re.test(text))?.kind
  const verdict = failure.kind ? KIND_TABLE[failure.kind.toLowerCase().replace(/[\s-]/g, "")] : undefined
  let kind: TransientKind | undefined
  if (verdict === "no") return { transient: false, why: failure.kind!, detail }
  // The words refine the kind a host gave (a 429 of a usage limit is a quota; a server error that says "overloaded" is one).
  if (verdict) kind = (verdict === "rate_limit" || verdict === "server") && (byText === "quota" || byText === "overloaded") ? byText : verdict
  else if (status === 429) kind = byText === "quota" || byText === "overloaded" ? byText : "rate_limit"
  else if (status === 529) kind = "overloaded"
  else if (status === 503) kind = byText === "overloaded" ? "overloaded" : "server"
  else if (status === 504 || status === 408) kind = "timeout"
  else if (status !== undefined && status >= 500) kind = byText === "overloaded" ? "overloaded" : "server"
  else if (status !== undefined && status >= 400) {
    // A request the provider rejected: transient only when it says so (Anthropic's credit balance comes as a 400).
    if (byText === "quota" || byText === "rate_limit") kind = byText
    else return { transient: false, why: `http-${status}`, detail }
  } else kind = byText ?? (failure.retryable === true ? "retries" : undefined)
  if (!kind) return { transient: false, why: failure.kind ?? "unknown", detail }
  const resetAt = resetOf(failure, now)
  const said = detailOf(failure, TRANSIENT.find((p) => p.kind === kind)?.re)
  return resetAt ? { transient: true, kind, detail: said, resetAt } : { transient: true, kind, detail: said }
}

// ── The reset time ────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
/** A reset farther than this is not believed (a parse of something else). */
const MAX_AHEAD_MS = 8 * 86_400_000

/** `2s`, `1m30s`, `7.5s`, `6m0s`, `2h`, `20 minutes`, `1 seconds` in milliseconds, or undefined. */
export function durationMs(text: string): number | undefined {
  let total = 0
  let any = false
  const re = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(?![a-z])/gi
  for (const m of text.matchAll(re)) {
    any = true
    const n = Number(m[1])
    const u = m[2]!.toLowerCase()
    total += u.startsWith("ms") || u.startsWith("milli") ? n : u.startsWith("s") ? n * 1000 : u.startsWith("m") ? n * 60_000 : u.startsWith("h") ? n * 3_600_000 : n * 86_400_000
  }
  return any ? Math.round(total) : undefined
}

/** The offset of an IANA zone from UTC at `at`, in minutes, or undefined (no Intl, unknown zone). */
function zoneOffset(zone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"))
    return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000)
  } catch {
    return undefined
  }
}

/**
 * `resets 12:50am`, `resets 3pm (Europe/Lisbon)`, `resets Oct 27, 9am`, `reset at 17:00`: the next such moment after
 * `now`, on the host's clock, or in the zone in parentheses when the runtime knows it.
 */
function clockReset(text: string, now: Date): number | undefined {
  const m = /\bresets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_\/+-]+|UTC)\))?/i.exec(text)
    ?? /\bresets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_\/+-]+|UTC)\))?/i.exec(text)
  if (!m) return undefined
  let month: number | undefined, day: number | undefined, hour: number, minute: number, zone: string | undefined
  if (m.length === 7) {
    month = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : undefined
    if (month === -1) month = undefined
    day = m[2] ? Number(m[2]) : undefined
    hour = Number(m[3]) % 12 + (m[5]!.toLowerCase() === "p" ? 12 : 0)
    minute = m[4] ? Number(m[4]) : 0
    zone = m[6]
  } else {
    hour = Number(m[1])
    minute = Number(m[2])
    zone = m[3]
  }
  if (hour > 23 || minute > 59) return undefined
  const shift = zone ? zoneOffset(zone === "UTC" ? "UTC" : zone, now) : undefined
  // The wall clock of the zone (or the host's) at `now`, as if it were UTC: the arithmetic below stays in one frame.
  const wall = shift !== undefined ? new Date(now.getTime() + shift * 60_000) : now
  const get = shift !== undefined
    ? { y: wall.getUTCFullYear(), mo: wall.getUTCMonth(), d: wall.getUTCDate() }
    : { y: wall.getFullYear(), mo: wall.getMonth(), d: wall.getDate() }
  const make = (y: number, mo: number, d: number) =>
    shift !== undefined ? Date.UTC(y, mo, d, hour, minute) - shift * 60_000 : new Date(y, mo, d, hour, minute).getTime()
  const slack = 60_000
  if (month !== undefined && day !== undefined) {
    let at = make(get.y, month, day)
    if (at < now.getTime() - 86_400_000) at = make(get.y + 1, month, day)
    return at
  }
  let at = make(get.y, get.mo, get.d)
  if (at <= now.getTime() - slack) at = make(get.y, get.mo, get.d + 1)
  return at
}

/** An epoch in seconds or milliseconds, as a time. */
function epoch(n: number): number {
  return n > 1e12 ? n : n * 1000
}

/** When the limit resets, as the provider said it (ISO), or undefined. The latest of what it said wins. */
export function resetOf(failure: ProviderFailure, now: Date): string | undefined {
  const at: number[] = []
  const t = now.getTime()
  if (typeof failure.retryAfterMs === "number" && failure.retryAfterMs > 0) at.push(t + failure.retryAfterMs)
  const headers = Object.fromEntries(Object.entries(failure.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const retryAfter = headers["retry-after"]
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter.trim())) at.push(t + Number(retryAfter) * 1000)
    else if (Number.isFinite(Date.parse(retryAfter))) at.push(Date.parse(retryAfter))
  }
  for (const name of ["anthropic-ratelimit-unified-reset", "x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const v = headers[name]?.trim()
    if (!v) continue
    if (/^\d{9,13}$/.test(v)) at.push(epoch(Number(v)))
    else if (/^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))) at.push(Date.parse(v))
    else {
      const d = durationMs(v)
      if (d !== undefined) at.push(t + d)
    }
  }
  for (const text of texts(failure)) {
    // Claude's older usage-limit text: `Claude AI usage limit reached|<epoch seconds>`.
    const pipe = /limit reached\|(\d{9,13})/i.exec(text)
    if (pipe) at.push(epoch(Number(pipe[1])))
    // A reset header echoed in a body (OpenRouter puts the upstream's headers in `metadata.headers`).
    const echoed = /"x-ratelimit-reset"\s*:\s*"?(\d{9,13})/i.exec(text)
    if (echoed) at.push(epoch(Number(echoed[1])))
    const iso = /\breset[^\n]{0,40}?(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/i.exec(text)
    if (iso && Number.isFinite(Date.parse(iso[1]!))) at.push(Date.parse(iso[1]!))
    const clock = clockReset(text, now)
    if (clock !== undefined) at.push(clock)
    const wait = /\b(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?){1,3})/i.exec(text)
    if (wait) {
      const d = durationMs(wait[1]!)
      if (d !== undefined) at.push(t + d)
    }
  }
  const good = at.filter((x) => Number.isFinite(x) && x > t - 60_000 && x < t + MAX_AHEAD_MS)
  return good.length ? new Date(Math.max(...good)).toISOString() : undefined
}

// ── The pause and the way back ────────────────────────────────────────────────────────────────────────────────

/** Automatic resumes in a row, at the same progress, before the host stops resuming by itself (the person decides). */
export const MAX_AUTO_RESUMES = 3
/** The wait of the first automatic resume when the provider gave no reset time; it doubles each time, up to an hour. */
export const BACKOFF_MS = 5 * 60_000
const BACKOFF_CAP_MS = 60 * 60_000
/** A reset is believed a little late: the provider's clock and ours differ. */
export const RESET_MARGIN_MS = 30_000

/** When the host resumes the run by itself, or undefined (it waits for `unpause`). */
export function resumeAtOf(resetAt: string | undefined, streak: number, now: Date): string | undefined {
  if (streak >= MAX_AUTO_RESUMES) return undefined
  if (resetAt) return new Date(Date.parse(resetAt) + RESET_MARGIN_MS).toISOString()
  return new Date(now.getTime() + Math.min(BACKOFF_MS * 2 ** streak, BACKOFF_CAP_MS)).toISOString()
}

/** The agent an owner names: `claude:<session>/agent:<id>` → `<id>`. */
export function agentOfOwner(owner: string | null | undefined): string | undefined {
  return owner ? /\/agent:([^/]+)$/.exec(owner)?.[1] : undefined
}

/** How the orchestrator resumes a subagent in each host (the model reads it: English). */
const RESUME_HOW: Record<string, (agent: string) => string> = {
  claude: (agent) => `SendMessage to agent ${agent}`,
  opencode: (agent) => `the task tool with task_id ${agent} (its session)`,
}

export function resumeHow(tool: string | undefined, agent: string): string {
  return (RESUME_HOW[tool ?? ""] ?? ((a: string) => `the same subagent (${a})`))(agent)
}

/** The line of the protocol while the run is paused by a transient failure: wait, keep the tasks. */
export function pauseProtocolLine(pause: AutoPause): string {
  const when = pause.resumeAt ? `the host resumes it at ${pause.resumeAt}` : "the person resumes it with jtasks unpause"
  const kept = pause.tasks.length ? ` ${pause.tasks.map((t) => t.id).join(", ")} stay in progress with their locks: do not release them and do not open new subagents for them.` : ""
  return `The run is paused by a transient failure of the provider (${pause.kind}: ${pause.detail}); ${when}.${kept} Do not call next or start until it is active again.`
}

/**
 * What the orchestrator reads when the run is active again: the tasks kept in progress, each with the agent to
 * resume (English, for the model).
 */
export function resumeText(run: RunFile, pause: AutoPause, inProgress: { id: string; owner?: string | null }[], tool: string | undefined, lost: Record<string, string[]> = {}): string {
  const head = `jtasks: run ${run.id} is active again after a pause for a transient failure of the provider (${pause.kind}: ${pause.detail}).`
  const lines = [head]
  for (const t of inProgress) {
    const agent = pause.tasks.find((p) => p.id === t.id)?.agent ?? agentOfOwner(t.owner)
    const gone = lost[t.id]?.length ? ` Its lock on ${lost[t.id]!.join(", ")} was taken by someone else meanwhile: the subagent claims it again when it needs it.` : ""
    lines.push(
      agent
        ? `${t.id} is still in progress with its locks and claims. Resume the same subagent (${resumeHow(tool, agent)}) and tell it to go on from where it stopped: it must not call jtasks start ${t.id} again, nor claim what it already holds. Do not open a new subagent for ${t.id}.${gone}`
        : `${t.id} is still in progress with its locks and claims: continue it where it stopped.${gone}`,
    )
  }
  lines.push("If that subagent no longer exists, continue the task yourself, or call jtasks release <id> and open a new one. Then go on with the protocol (jtasks next).")
  return lines.join("\n")
}

/** The tasks a pause keeps: every task in progress, with the agent of its owner (or the one the host named). */
export function pausedTasks(inProgress: { id: string; owner?: string | null }[], named?: { task: string; agent?: string }): PausedTask[] {
  return inProgress.map((t) => {
    const agent = named?.task === t.id && named.agent ? named.agent : agentOfOwner(t.owner)
    const owner = t.owner ?? null
    return agent ? { id: t.id, owner, agent } : { id: t.id, owner }
  })
}

// ── What the person reads ─────────────────────────────────────────────────────────────────────────────────────

/** The kind in the person's language. */
export function kindLabel(kind: TransientKind): string {
  return tr(`transient.${kind}`)
}

/** `HH:MM` on the host's clock (today), or `YYYY-MM-DD HH:MM` (another day). */
export function formatWhen(iso: string, now: Date): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const same = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return same ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
}

/** The line the host shows (toast, sidebar, answer) when it paused the run. */
export function pauseNotice(run: string, pause: AutoPause, now: Date): string {
  const kept = pause.tasks.length ? tr("pause.kept", { list: pause.tasks.map((t) => t.id).join(", ") }) : tr("pause.kept_none")
  const when = pause.resumeAt ? tr("pause.when_at", { at: formatWhen(pause.resumeAt, now) }) : tr("pause.when_person")
  return tr("pause.auto", { run, kind: kindLabel(pause.kind), detail: pause.detail, kept, when })
}

/** The sidebar's short line while the run is in a transient pause. */
export function pauseViewNotice(pause: AutoPause, now: Date): string {
  const when = pause.resumeAt ? tr("pause.when_at", { at: formatWhen(pause.resumeAt, now) }) : tr("pause.when_person")
  return tr("view.auto_paused", { kind: kindLabel(pause.kind), when })
}
