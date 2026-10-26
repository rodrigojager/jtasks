// What the plugin reads of a session's failure from OpenCode's events (rev. 5.7): v2 structured errors, the retry
// status, and v1 APIError; the core's classifier decides (its own tests hold the providers' samples).

import { describe, expect, test } from "bun:test"
import { fromStructured, fromV1, SessionFailures } from "../src/transient.ts"

const NOW = new Date(Date.UTC(2025, 9, 25, 12, 0, 0))

describe("SessionFailures", () => {
  test("v2 session.execution.failed with the structured error", () => {
    const f = new SessionFailures(() => NOW)
    f.onEvent("session.execution.failed", { sessionID: "c1", error: { type: "QuotaExceeded", message: "You exceeded your current quota", status: 429, retryAfterMs: 30_000 } })
    const c = f.take("c1")
    expect(c).toMatchObject({ transient: true, kind: "quota", resetAt: new Date(NOW.getTime() + 30_000).toISOString() })
    expect(f.take("c1")).toBeUndefined()
  })

  test("the retries OpenCode made before giving up add their words and their next attempt", () => {
    const f = new SessionFailures(() => NOW)
    f.onEvent("session.status", { sessionID: "c1", status: { type: "retry", attempt: 5, message: "Too Many Requests", next: NOW.getTime() + 90_000 } })
    f.onEvent("session.execution.failed", { sessionID: "c1", error: { type: "UnknownProvider", message: "Failed after 5 attempts" } })
    expect(f.take("c1")).toMatchObject({ transient: true, kind: "rate_limit", resetAt: new Date(NOW.getTime() + 90_000).toISOString() })
  })

  test("a new execution forgets the old failure; a failure that is not transient says so", () => {
    const f = new SessionFailures(() => NOW)
    f.onEvent("session.execution.failed", { sessionID: "c1", error: { type: "RateLimit", message: "slow down", status: 429 } })
    f.onEvent("session.execution.started", { sessionID: "c1" })
    expect(f.has("c1")).toBe(false)
    f.onEvent("session.execution.failed", { sessionID: "c1", error: { type: "ContentPolicy", message: "flagged", status: 400 } })
    expect(f.take("c1")).toMatchObject({ transient: false })
  })

  test("v1 session.error with APIError", () => {
    const f = new SessionFailures(() => NOW)
    f.onEvent("session.error", { sessionID: "s1", error: { name: "APIError", data: { message: "Service Unavailable", statusCode: 503, isRetryable: true, responseHeaders: { "retry-after": "20" } } } })
    expect(f.take("s1")).toMatchObject({ transient: true, kind: "server", resetAt: new Date(NOW.getTime() + 20_000).toISOString() })
    expect(fromV1({ name: "ProviderAuthError", data: { message: "no key" } })).toMatchObject({ kind: "ProviderAuthError" })
    expect(fromStructured("nope")).toBeUndefined()
  })
})
