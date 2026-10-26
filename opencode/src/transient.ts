// Transient failures in OpenCode (plan rev. 5.7). What a session's failure looks like depends on the provider and
// the model, so this module only reads what OpenCode itself publishes and hands it to the core's classifier:
// - v2 `session.execution.failed` (the execution's end): `data.error` is the structured error, `type` (the AI error's
//   tag: `RateLimit`, `QuotaExceeded`, `ProviderInternal`, `Transport`, `Timeout`, `Authentication`, `ContentPolicy`,
//   `InvalidRequest`, `UnknownProvider`…), `message`, `status`, `response.body` (where OpenRouter puts the upstream's
//   own error) and `retryAfterMs`;
// - v2 `session.retry.scheduled` and `session.status` with `status.type: "retry"` (`message`, `next`): OpenCode is
//   retrying; their words count when the execution fails after them (the retries ran out);
// - v1 `session.error` (`properties` or `data`): `error.name` (`APIError`, `ProviderAuthError`…) with `data.message`,
//   `statusCode`, `isRetryable`, `responseBody`, `responseHeaders`.
// The last failure of each session is kept until the session's end decides (a child's idle, the root's idle).

import { classifyFailure, type Classification, type ProviderFailure } from "../core/core.js"

type Json = Record<string, unknown>

const isObject = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x)
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x : undefined)
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined)

/** A v2 structured error (`SessionStructuredError`) as a failure for the classifier. */
export function fromStructured(error: unknown): ProviderFailure | undefined {
  if (!isObject(error)) return undefined
  const response = isObject(error.response) ? error.response : undefined
  const failure: ProviderFailure = { texts: [str(error.message), str(response?.body)] }
  const kind = str(error.type)
  if (kind) failure.kind = kind
  const status = num(error.status)
  if (status !== undefined) failure.status = status
  const wait = num(error.retryAfterMs)
  if (wait !== undefined) failure.retryAfterMs = wait
  return failure
}

/** A v1 error (`{ name, data: { message, statusCode, isRetryable, responseBody, responseHeaders } }`). */
export function fromV1(error: unknown): ProviderFailure | undefined {
  if (!isObject(error)) return undefined
  const data = isObject(error.data) ? error.data : {}
  const failure: ProviderFailure = { texts: [str(data.message), str(data.responseBody), str(error.message)] }
  const kind = str(error.name)
  if (kind) failure.kind = kind
  const status = num(data.statusCode)
  if (status !== undefined) failure.status = status
  if (typeof data.isRetryable === "boolean") failure.retryable = data.isRetryable
  if (isObject(data.responseHeaders)) failure.headers = Object.fromEntries(Object.entries(data.responseHeaders).filter(([, v]) => typeof v === "string")) as Record<string, string>
  return failure
}

interface Retry {
  message?: string
  /** When OpenCode tries again (epoch ms). */
  next?: number
  failure?: ProviderFailure
}

export class SessionFailures {
  private readonly failed = new Map<string, ProviderFailure>()
  private readonly retrying = new Map<string, Retry>()

  constructor(private readonly now: () => Date) {}

  /** One event of OpenCode's stream (`data` is the event's `data`, or a v1 event's `properties`). */
  onEvent(type: string, data: unknown): void {
    if (!isObject(data)) return
    const sessionID = str(data.sessionID)
    if (!sessionID) return
    if (type === "session.execution.started") {
      this.failed.delete(sessionID)
      this.retrying.delete(sessionID)
      return
    }
    if (type === "session.execution.failed") {
      const failure = fromStructured(data.error)
      if (failure) this.failed.set(sessionID, failure)
      return
    }
    if (type === "session.error") {
      const failure = fromV1(data.error) ?? fromStructured(data.error)
      if (failure) this.failed.set(sessionID, failure)
      return
    }
    if (type === "session.retry.scheduled") {
      const failure = fromStructured(data.error)
      this.retrying.set(sessionID, { ...this.retrying.get(sessionID), ...(failure ? { failure } : {}) })
      return
    }
    if (type === "session.status" && isObject(data.status)) {
      const status = data.status
      if (status.type === "retry") {
        const retry: Retry = { ...this.retrying.get(sessionID) }
        const message = str(status.message)
        if (message) retry.message = message
        const next = num(status.next)
        if (next !== undefined) retry.next = next
        this.retrying.set(sessionID, retry)
      } else if (status.type === "busy") this.retrying.delete(sessionID)
    }
  }

  /** Whether the session's last execution failed (and the failure is still kept). */
  has(sessionID: string): boolean {
    return this.failed.has(sessionID)
  }

  /**
   * The session's last failure, classified, and forgotten; undefined when it did not fail. The retries OpenCode made
   * before giving up add their words and their next attempt's time.
   */
  take(sessionID: string): Classification | undefined {
    const failure = this.failed.get(sessionID)
    const retry = this.retrying.get(sessionID)
    this.failed.delete(sessionID)
    this.retrying.delete(sessionID)
    if (!failure) return undefined
    const merged: ProviderFailure = { ...retry?.failure, ...failure, texts: [...(failure.texts ?? []), ...(retry?.failure?.texts ?? []), retry?.message] }
    if (merged.kind === undefined && retry?.failure?.kind) merged.kind = retry.failure.kind
    if (merged.retryAfterMs === undefined && retry?.next !== undefined) {
      const wait = retry.next - this.now().getTime()
      if (wait > 0) merged.retryAfterMs = wait
    }
    return classifyFailure(merged, this.now())
  }
}
