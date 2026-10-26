// The classifier of provider failures (plan rev. 5.7): real samples of each provider, as Claude Code's StopFailure
// and OpenCode's session.execution.failed / session.error carry them, and the ones that must not pause the run.

import { describe, expect, test } from "bun:test"
import { classifyFailure, durationMs, resetOf, resumeAtOf, resumeText, MAX_AUTO_RESUMES, type ProviderFailure } from "../src/transient.ts"
import type { AutoPause, RunFile } from "../src/schema.ts"

/** Noon UTC: an epoch a few hours ahead stays ahead in every time zone the tests run in. */
const NOON = new Date(Date.UTC(2025, 9, 25, 12, 0, 0))

const kindOf = (f: ProviderFailure, now = NOON) => {
  const c = classifyFailure(f, now)
  return c.transient ? c.kind : `no:${c.why}`
}

describe("Claude Code (StopFailure: error, error_details, last_assistant_message)", () => {
  test("the session limit of the incident pauses as a quota, with the reset on the host's clock", () => {
    const now = new Date(2025, 9, 25, 21, 40)
    const c = classifyFailure({ kind: "rate_limit", texts: ["API Error: You've hit your session limit · resets 12:50am", "429"] }, now)
    expect(c.transient && c.kind).toBe("quota")
    expect(c.transient && c.resetAt).toBe(new Date(2025, 9, 26, 0, 50).toISOString())
  })

  test("the same text with only the words (no kind) is still a quota", () => {
    expect(kindOf({ texts: ["You've hit your session limit · resets 12:50am (rate_limit, HTTP 429)"] })).toBe("quota")
  })

  test("five-hour and weekly limits, with a day and a zone", () => {
    const now = new Date(2025, 9, 25, 10, 0)
    const five = classifyFailure({ kind: "rate_limit", texts: ["5-hour limit reached ∙ resets 3pm"] }, now)
    expect(five.transient && five.resetAt).toBe(new Date(2025, 9, 25, 15, 0).toISOString())
    const weekly = classifyFailure({ kind: "rate_limit", texts: ["Weekly limit reached · resets Oct 27, 9am (UTC)"] }, now)
    expect(weekly.transient && weekly.kind).toBe("quota")
    expect(weekly.transient && weekly.resetAt).toBe(new Date(Date.UTC(2025, 9, 27, 9, 0)).toISOString())
  })

  test("the older usage-limit text with an epoch", () => {
    const c = classifyFailure({ texts: ["Claude AI usage limit reached|1761436800"] }, NOON)
    expect(c.transient && c.kind).toBe("quota")
    expect(c.transient && c.resetAt).toBe("2025-10-26T00:00:00.000Z")
  })

  test("overloaded, server errors, timeouts and the connection", () => {
    expect(kindOf({ kind: "overloaded", texts: ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'] })).toBe("overloaded")
    expect(kindOf({ kind: "server_error", texts: ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'] })).toBe("server")
    expect(kindOf({ kind: "unknown", texts: ["API Error: Request timed out."] })).toBe("timeout")
    expect(kindOf({ kind: "unknown", texts: ["API Error: Connection error."] })).toBe("network")
    expect(kindOf({ kind: "unknown", texts: ["API Error: fetch failed (ECONNRESET)"] })).toBe("network")
  })

  test("what must not pause: login, context, refusal, output cap, a bug", () => {
    expect(kindOf({ kind: "authentication_failed", texts: ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login'] })).toBe("no:auth")
    expect(kindOf({ kind: "invalid_request", texts: ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'] })).toBe("no:context")
    expect(kindOf({ kind: "unknown", texts: ["API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy"] })).toBe("no:refusal")
    expect(kindOf({ kind: "max_output_tokens", texts: ["Claude's response exceeded the 32000 output token maximum."] })).toBe("no:output")
    expect(kindOf({ kind: "model_not_found", texts: ["API Error: 404 model: claude-x"] })).toBe("no:model_not_found")
    expect(kindOf({ kind: "unknown", texts: ["TypeError: Cannot read properties of undefined (reading 'map')"] })).toBe("no:unknown")
    expect(kindOf({ kind: "account_on_hold", texts: ["Your account is on hold"] })).toBe("no:account_on_hold")
  })
})

describe("OpenCode v2 (session.execution.failed: error.type, status, response.body, retryAfterMs)", () => {
  test("opencode/zen: the free usage limit and a gateway code label", () => {
    const zen = {
      kind: "QuotaExceeded",
      status: 429,
      texts: ["Free usage limit reached", '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}'],
    }
    expect(kindOf(zen)).toBe("quota")
    expect(kindOf({ kind: "ProviderInternal", status: 503, texts: ["Upstream error: [server_is_overloaded] The server is overloaded"] })).toBe("overloaded")
    expect(kindOf({ kind: "Authentication", status: 401, texts: ["Invalid API key."] })).toBe("no:auth")
  })

  test("OpenRouter: daily free limit with the reset in the echoed headers", () => {
    const body = '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1761436800000"}}}}'
    const c = classifyFailure({ kind: "RateLimit", status: 429, texts: ["Rate limit exceeded: free-models-per-day", body] }, NOON)
    expect(c.transient && c.kind).toBe("rate_limit")
    expect(c.transient && c.resetAt).toBe("2025-10-26T00:00:00.000Z")
  })

  test("OpenRouter: the upstream's error inside the body (no type, only the status in the body)", () => {
    const upstream = '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"moonshotai/kimi-k2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Chutes"}},"user_id":"user_2x"}'
    expect(kindOf({ texts: ["Provider returned error", upstream] })).toBe("rate_limit")
    const gateway = '{"error":{"message":"Provider returned error","code":502,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"upstream connect error or disconnect/reset before headers\\"}}","provider_name":"Moonshot AI"}}}'
    expect(kindOf({ texts: ["Provider returned error", gateway] })).toBe("server")
    expect(kindOf({ status: 402, texts: ['{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}'] })).toBe("quota")
    const flagged = '{"error":{"code":403,"message":"moonshotai/kimi-k2 requires moderation on OpenRouter. Your input was flagged for \\"harassment\\"","metadata":{"reasons":["harassment"]}}}'
    expect(kindOf({ status: 403, texts: [flagged] })).toBe("no:refusal")
    expect(kindOf({ status: 401, texts: ['{"error":{"message":"No auth credentials found","code":401}}'] })).toBe("no:auth")
  })

  test("Anthropic: rate limit with retry-after, overloaded at 529, context and key do not pause", () => {
    const c = classifyFailure(
      {
        kind: "RateLimit",
        status: 429,
        texts: ['{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}'],
        headers: { "retry-after": "17" },
      },
      NOON,
    )
    expect(c.transient && c.kind).toBe("rate_limit")
    expect(c.transient && c.resetAt).toBe(new Date(NOON.getTime() + 17_000).toISOString())
    expect(kindOf({ kind: "ProviderInternal", status: 529, texts: ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'] })).toBe("overloaded")
    expect(kindOf({ kind: "InvalidRequest", status: 400, texts: ["prompt is too long: 201234 tokens > 200000 maximum"] })).toBe("no:context")
    expect(kindOf({ kind: "Authentication", status: 401, texts: ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'] })).toBe("no:auth")
  })

  test("OpenAI: TPM limit with its wait, insufficient_quota, 503; key and context do not pause", () => {
    const tpm = classifyFailure(
      { kind: "RateLimit", status: 429, texts: ["Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2.5s. Visit https://platform.openai.com/account/rate-limits to learn more."] },
      NOON,
    )
    expect(tpm.transient && tpm.kind).toBe("rate_limit")
    expect(tpm.transient && tpm.resetAt).toBe(new Date(NOON.getTime() + 2500).toISOString())
    expect(kindOf({ kind: "QuotaExceeded", status: 429, texts: ["You exceeded your current quota, please check your plan and billing details."] })).toBe("quota")
    expect(kindOf({ kind: "ProviderInternal", status: 503, texts: ["The server is overloaded or not ready yet."] })).toBe("overloaded")
    expect(kindOf({ kind: "Authentication", status: 401, texts: ["Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys."] })).toBe("no:auth")
    expect(kindOf({ kind: "InvalidRequest", status: 400, texts: ["This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."] })).toBe("no:context")
  })

  test("Moonshot/Kimi: RPM limit, exceeded quota, engine overloaded; content filter and key do not pause", () => {
    const rpm = classifyFailure(
      { status: 429, texts: ['{"error":{"message":"Your account org-x<ak-y> request reached organization max RPM: 3, please try again after 1 seconds","type":"rate_limit_reached_error"}}'] },
      NOON,
    )
    expect(rpm.transient && rpm.kind).toBe("rate_limit")
    expect(rpm.transient && rpm.resetAt).toBe(new Date(NOON.getTime() + 1000).toISOString())
    expect(kindOf({ status: 429, texts: ['{"error":{"message":"Your account org-x<ak-y> is suspended, please check your plan and billing details","type":"exceeded_current_quota_error"}}'] })).toBe("quota")
    expect(kindOf({ status: 429, texts: ['{"error":{"message":"The engine is currently overloaded, please try again later","type":"engine_overloaded_error"}}'] })).toBe("overloaded")
    expect(kindOf({ status: 400, texts: ['{"error":{"message":"The request was rejected because it was considered high risk","type":"content_filter"}}'] })).toBe("no:refusal")
    expect(kindOf({ status: 401, texts: ['{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}'] })).toBe("no:auth")
  })

  test("OpenAI-compatible servers and the transport", () => {
    expect(kindOf({ status: 503, texts: ["Service Unavailable"] })).toBe("server")
    expect(kindOf({ status: 504, texts: ["Gateway Timeout"] })).toBe("timeout")
    expect(kindOf({ kind: "Transport", texts: ["fetch failed"] })).toBe("network")
    expect(kindOf({ texts: ["Unable to connect. Is the computer able to access the url?"] })).toBe("network")
    expect(kindOf({ texts: ["The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"] })).toBe("network")
    expect(kindOf({ texts: ["request to https://api.deepseek.com/chat/completions failed, reason: socket hang up"] })).toBe("network")
    expect(kindOf({ kind: "Timeout", texts: ["Request timed out after 600000ms"] })).toBe("timeout")
    expect(kindOf({ kind: "UnknownProvider", texts: ["Failed after 5 attempts. Last error: Internal Server Error"] })).toBe("server")
    expect(kindOf({ kind: "UnsupportedOperation", texts: ["tool calls are not supported by this model"] })).toBe("no:UnsupportedOperation")
    expect(kindOf({ kind: "ContentPolicy", status: 400, texts: ["blocked"] })).toBe("no:ContentPolicy")
  })
})

describe("OpenCode v1 (session.error: APIError with statusCode and isRetryable)", () => {
  test("by status, by isRetryable, and the errors that never pause", () => {
    expect(kindOf({ kind: "APIError", status: 529, retryable: true, texts: ["Overloaded"] })).toBe("overloaded")
    expect(kindOf({ kind: "APIError", status: 429, retryable: true, texts: ["Too Many Requests"] })).toBe("rate_limit")
    expect(kindOf({ kind: "APIError", retryable: true, texts: ["something odd happened"] })).toBe("retries")
    expect(kindOf({ kind: "APIError", status: 400, retryable: false, texts: ["Bad Request"] })).toBe("no:http-400")
    expect(kindOf({ kind: "ProviderAuthError", texts: ["Provider anthropic: no credentials"] })).toBe("no:ProviderAuthError")
    expect(kindOf({ kind: "ContextOverflowError", texts: ["context"] })).toBe("no:ContextOverflowError")
    expect(kindOf({ kind: "MessageAbortedError", texts: ["Aborted"] })).toBe("no:MessageAbortedError")
    expect(kindOf({ kind: "UnknownError", texts: ["ReferenceError: x is not defined"] })).toBe("no:UnknownError")
  })
})

describe("the reset and the way back", () => {
  test("durations and reset headers", () => {
    expect(durationMs("1m30s")).toBe(90_000)
    expect(durationMs("6m0s")).toBe(360_000)
    expect(durationMs("20 minutes")).toBe(1_200_000)
    expect(resetOf({ headers: { "anthropic-ratelimit-unified-reset": "1761436800" } }, NOON)).toBe("2025-10-26T00:00:00.000Z")
    expect(resetOf({ headers: { "x-ratelimit-reset-requests": "6m0s" } }, NOON)).toBe(new Date(NOON.getTime() + 360_000).toISOString())
    expect(resetOf({ retryAfterMs: 5000 }, NOON)).toBe(new Date(NOON.getTime() + 5000).toISOString())
    // A time far away is not believed; nothing said, nothing answered.
    expect(resetOf({ texts: ["Claude AI usage limit reached|1900000000"] }, NOON)).toBeUndefined()
    expect(resetOf({ texts: ["Overloaded"] }, NOON)).toBeUndefined()
  })

  test("the automatic resume: at the reset, else a backoff; none after the streak", () => {
    expect(resumeAtOf("2025-10-26T00:00:00.000Z", 0, NOON)).toBe("2025-10-26T00:00:30.000Z")
    expect(resumeAtOf(undefined, 0, NOON)).toBe(new Date(NOON.getTime() + 5 * 60_000).toISOString())
    expect(resumeAtOf(undefined, 2, NOON)).toBe(new Date(NOON.getTime() + 20 * 60_000).toISOString())
    expect(resumeAtOf(undefined, MAX_AUTO_RESUMES, NOON)).toBeUndefined()
  })

  test("the orchestrator is told to resume the same agent, in each host's words", () => {
    const run = { id: "r1" } as RunFile
    const pause: AutoPause = { kind: "quota", detail: "session limit", at: NOON.toISOString(), streak: 0, tasks: [{ id: "T13", owner: "claude:s/agent:a7", agent: "a7" }], by: "claude:s" }
    const claude = resumeText(run, pause, [{ id: "T13", owner: "claude:s/agent:a7" }], "claude")
    expect(claude).toContain("SendMessage to agent a7")
    expect(claude).toContain("Do not open a new subagent for T13")
    const opencode = resumeText(run, { ...pause, tasks: [{ id: "T13", owner: "opencode:root/agent:ses_9" }] }, [{ id: "T13", owner: "opencode:root/agent:ses_9" }], "opencode")
    expect(opencode).toContain("task_id ses_9")
  })
})
