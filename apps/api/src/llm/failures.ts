import { APICallError, RetryError, StreamProviderError } from "ai";

type ProviderFailure = APICallError | StreamProviderError;

// What the provider reported, unwrapped from any retries the SDK already spent.
function providerFailure(err: unknown): ProviderFailure | null {
  const last = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(last) || StreamProviderError.isInstance(last)
    ? last
    : null;
}

// The SDK's stall timeout: the provider went quiet, which a later attempt can outlast.
function isStall(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

/* The SDK's own verdict on whether trying again could work. Auth, model and
   request errors say no, since retrying them cannot succeed. */
export function isRetryableLLMError(err: unknown): boolean {
  return providerFailure(err)?.isRetryable === true || isStall(err);
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  err: unknown;
}

export function retrySummary(notice: RetryNotice): string {
  const status = providerFailure(notice.err)?.statusCode;
  const cause =
    status === undefined ? "Provider error" : `Provider error (${status})`;
  return `${cause}. Retrying - attempt ${notice.attempt} of ${notice.maxAttempts}.`;
}

// OpenRouter nests the upstream host's name in error.metadata; surface it so
// "who actually failed" is readable without server logs.
function upstreamProvider(body: unknown): string | null {
  return metadataField(body, "provider_name");
}

// OpenRouter's canonical error code, which distinguishes "the model's upstream
// host is down" from "your key is bad" - very different things to act on.
function errorType(body: unknown): string | null {
  return metadataField(body, "error_type");
}

// Every provider wraps its fault the same way, in an object under `error`.
function errorBody(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null) return null;
  const body = (data as Record<string, unknown>)["error"];
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : null;
}

function metadataField(data: unknown, field: string): string | null {
  const metadata = errorBody(data)?.["metadata"];
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function bodyMessage(data: unknown): string {
  const message = errorBody(data)?.["message"];
  return typeof message === "string" ? message : "";
}

// OpenRouter types this condition; Anthropic only words it, so both are read.
const CONTEXT_OVERFLOW_WORDING = [
  "prompt is too long",
  "context window",
  "context length",
];

function isContextOverflow(err: ProviderFailure): boolean {
  if (errorType(err.data) === "context_length_exceeded") return true;
  const said = `${err.message} ${bodyMessage(err.data)}`.toLowerCase();
  return CONTEXT_OVERFLOW_WORDING.some((wording) => said.includes(wording));
}

/* Last resort, so a failure with no message still names its shape rather than
   the word every unlabelled object prints as. */
function describeUnknown(err: unknown): string {
  return err === null || err === undefined
    ? "the provider gave no reason"
    : `the provider returned ${typeof err} with no message`;
}

// Plain-language failure text persisted into the transcript. One or two
// sentences a non-expert can act on, with the raw status in parentheses.
export function describeLLMError(err: unknown, maxRetries: number): string {
  const attempts = maxRetries + 1;
  const failure = providerFailure(err);
  if (failure === null) {
    if (isStall(err)) {
      return "The model provider stopped sending its reply part way and never resumed. This is upstream, not your setup; send a message to try again.";
    }
    const message = err instanceof Error ? err.message : describeUnknown(err);
    return `The run failed unexpectedly: ${message}`;
  }
  const status = failure.statusCode;
  if (status === undefined) {
    return APICallError.isInstance(failure)
      ? "Could not reach the model provider - the connection failed. Check the Base URL in Settings and your network, then send a message to try again."
      : `The model provider failed part way through its reply: ${failure.message}. NightWarden tried ${attempts} times before giving up.`;
  }
  const from = upstreamProvider(failure.data);
  const detail = ` (HTTP ${status}${from === null ? "" : ` from ${from}`})`;
  // The host actually serving the model is down, which is neither your key nor
  // your model being wrong: another model routes around it.
  if (errorType(failure.data) === "provider_unavailable") {
    return `The provider behind this model returned nothing usable, which means it is having an outage rather than anything being wrong with your setup. Try another model in Settings, or wait for it to recover${detail}.`;
  }
  if (status === 401 || status === 403) {
    return `The provider rejected the API key. Check the key under Settings, Provider${detail}.`;
  }
  if (status === 402) {
    return `The provider account is out of credits. Top up, or pick a model that costs less, in Settings${detail}.`;
  }
  if (status === 404) {
    return `The provider has no such model. It may have been renamed, retired, or moved behind a paid plan. Pick a different model in Settings${detail}.`;
  }
  // Checked before the generic 400 it arrives as: the user changed nothing,
  // so naming their model and reasoning level points at the wrong screen.
  if (isContextOverflow(failure)) {
    return `This conversation grew past the model's context window, so the provider refused it. Continuing this session would hit the same limit: start a new one, or pick a model with a larger context window under Settings, Provider${detail}.`;
  }
  if (status === 400) {
    return `The provider rejected the request as malformed. If you have just changed the model or its reasoning level, check them under Settings, Provider${detail}.`;
  }
  if (status === 429) {
    return `The provider rate-limited the request, or a quota on the chosen model ran out. NightWarden tried ${attempts} times before giving up; this usually clears on its own${detail}.`;
  }
  if (status >= 500) {
    return `The model provider had a server problem - this is upstream, not your setup. NightWarden tried ${attempts} times before giving up${detail}.`;
  }
  return `The provider returned an unexpected error${detail}.`;
}
