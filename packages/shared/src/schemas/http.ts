import { z } from "zod";
import { PLATFORMS } from "../runner.js";
import { STATUS_FILTERS } from "../sessions.js";

// Every refusal a route answers, whatever its status, so a client reads one field.
export const errorBodySchema = z.object({ error: z.string() });

// 5xx too: Fastify's own 500 body carries the thrown error's message, which this strips to `error`.
export function refusals<Body extends z.ZodType>(
  body: Body,
): {
  "4xx": Body;
  "5xx": Body;
};
export function refusals(): {
  "4xx": typeof errorBodySchema;
  "5xx": typeof errorBodySchema;
};
export function refusals(body: z.ZodType = errorBodySchema) {
  return { "4xx": body, "5xx": body };
}

// Text the agent will read, so an all-whitespace one is empty rather than short.
// Trimmed here, which keeps every route from repeating the check.
const said = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

const message = said("message");

// Minted by the sender before the request leaves, so the bubble it draws at once
// and the row saved later share one id.
const clientMessageId = z.uuid({ error: "clientMessageId must be a UUID" });

// Only a chat opens from a typed message: an investigation is a session with a
// falsifiable condition, and only an alert carries one.
export const chatRequestSchema = z.object({
  message,
  clientMessageId,
  kind: z
    .literal("chat", {
      error: "an investigation is opened by an alert, not by hand",
    })
    .optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const sessionMessageRequestSchema = z.object({
  message,
  clientMessageId,
});
export type SessionMessageRequest = z.infer<typeof sessionMessageRequestSchema>;

// The reason is the person's message into the reopened run, so it follows the same rules.
export const reopenRequestSchema = z.object({
  reason: said("reason"),
  clientMessageId,
});
export type ReopenRequest = z.infer<typeof reopenRequestSchema>;

/* Either half may stand alone: a decision with no comment settles a gate, and a
   comment with no decision answers a question. */
export const respondRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]).optional(),
  text: z.string().optional(),
});
export type RespondRequest = z.infer<typeof respondRequestSchema>;

// The name is only required to be a string here: serverNameError owns every
// rule about its content, so the route reports one voice rather than two.
export const mintTokenRequestSchema = z.object({
  platform: z.enum(PLATFORMS),
  serverName: z.string(),
});
export type MintTokenRequest = z.infer<typeof mintTokenRequestSchema>;

/* One message per bound, whatever the value failed on: a caller who sent "abc"
   needs to know what a limit is, not that coercing it produced NaN. */
const LIMIT = "limit must be a whole number from 1 to 200";
const OFFSET = "offset must be a whole number of 0 or more";
const QUERY = "q must be at most 200 characters";

export const sessionPageQuerySchema = z.object({
  kind: z.enum(["investigation", "chat"]),
  limit: z.coerce
    .number({ error: LIMIT })
    .int(LIMIT)
    .min(1, LIMIT)
    .max(200, LIMIT)
    .default(50),
  offset: z.coerce
    .number({ error: OFFSET })
    .int(OFFSET)
    .min(0, OFFSET)
    .default(0),
  status: z.enum(STATUS_FILTERS).optional(),
  // A title search. Blank is no search, so an emptied box lists everything again.
  q: z.string().trim().max(200, QUERY).optional(),
});
export type SessionPageQuery = z.infer<typeof sessionPageQuerySchema>;
