import { describe, expect, it } from "vitest";
import { APICallError, StreamProviderError } from "ai";
import { describeLLMError, retrySummary } from "../llm/failures.js";

// One shape for every provider: the SDK reports each fault as an APICallError
// carrying the status and the body it was given.
function providerError(status: number, data?: unknown): APICallError {
  return new APICallError({
    message: "boom",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    statusCode: status,
    ...(data !== undefined && { data }),
  });
}

// A request that never reached a server, which carries no status.
function connectionError(): APICallError {
  return new APICallError({
    message: "down",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
  });
}

describe("describeLLMError", () => {
  it("names the upstream host on a 5xx, from OpenRouter's error metadata", () => {
    // Shape mirrors a real OpenRouter 502: the failing host rides in metadata.
    const err = providerError(502, {
      error: {
        message: "Provider returned error",
        metadata: { provider_name: "Poolside", is_byok: false },
      },
    });
    const text = describeLLMError(err, 3);
    expect(text).toContain("server problem");
    expect(text).toContain("(HTTP 502 from Poolside)");
    // The configured retries, plus the first attempt.
    expect(text).toContain("tried 4 times");
  });

  it.each([
    [400, "malformed"],
    [401, "rejected the API key"],
    [402, "out of credits"],
    [404, "no such model"],
    [429, "rate-limited"],
  ])("maps HTTP %d to actionable words", (status, phrase) => {
    expect(describeLLMError(providerError(status), 3)).toContain(phrase);
  });

  it("reads provider_unavailable as an upstream outage rather than a setup problem", () => {
    // OpenRouter returns this when the host behind a model answers with nothing
    // usable: a different condition from a bad key, and it reads differently.
    const err = providerError(502, {
      error: {
        message: "Provider returned error",
        metadata: {
          provider_name: "Poolside",
          error_type: "provider_unavailable",
        },
      },
    });

    const text = describeLLMError(err, 3);

    expect(text).toContain("outage");
    expect(text).not.toContain("server problem");
  });

  // A context-length overflow is a 400, and the generic 400 wording points at a
  // model and reasoning level the user never touched.
  it("tells a context-length overflow apart from a malformed request", () => {
    const err = providerError(400, {
      error: {
        message: "This endpoint's maximum context length is 128000 tokens",
        metadata: {
          error_type: "context_length_exceeded",
          provider_code: "string_above_max_length",
        },
      },
    });

    const text = describeLLMError(err, 3);

    expect(text).toContain("context window");
    expect(text).not.toContain("malformed");
    expect(text).not.toContain("reasoning level");
  });

  // Anthropic publishes no typed code for it, so the message is the only signal.
  it("recognises the same overflow when only the message says so", () => {
    const err = providerError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 235433 tokens > 200000 maximum",
      },
    });

    const text = describeLLMError(err, 3);

    expect(text).toContain("context window");
    expect(text).not.toContain("malformed");
  });

  it("explains connection failures without a status code", () => {
    const text = describeLLMError(connectionError(), 3);
    expect(text).toContain("Could not reach the model provider");
    expect(text).not.toContain("HTTP");
  });

  it("falls back to the raw message for non-provider errors", () => {
    const text = describeLLMError(new Error("db locked"), 3);
    expect(text).toContain("failed unexpectedly");
    expect(text).toContain("db locked");
  });
});

describe("retrySummary", () => {
  it("names the HTTP status and the attempt starting", () => {
    const text = retrySummary({
      attempt: 2,
      maxAttempts: 4,
      err: providerError(529),
    });
    expect(text).toContain("529");
    expect(text).toContain("attempt 2 of 4");
  });

  it("invents no status for a stream failure that stated none", () => {
    const text = retrySummary({
      attempt: 4,
      maxAttempts: 4,
      err: new StreamProviderError({ message: "stream broke" }),
    });
    expect(text).not.toMatch(/\(\d+\)/);
    expect(text).toContain("attempt 4 of 4");
  });
});
