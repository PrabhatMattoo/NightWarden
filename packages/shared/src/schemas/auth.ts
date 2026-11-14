import { z } from "zod";
import { PLATFORMS } from "../runner.js";
import { themePreferenceSchema } from "./config.js";

// `ownerExists` is the one question Better Auth cannot answer: it knows whether
// this request is signed in, never whether the install has been set up.
export const authStatusResponseSchema = z.union([
  z.object({ ownerExists: z.literal(false) }),
  z.object({ ownerExists: z.literal(true), authenticated: z.literal(false) }),
  z.object({
    ownerExists: z.literal(true),
    authenticated: z.literal(true),
    email: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    theme: themePreferenceSchema,
  }),
]);
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

// The plaintext nwr_... token is returned exactly once, here, and never stored.
export const mintedTokenSchema = z.object({
  id: z.string(),
  token: z.string(),
  platform: z.enum(PLATFORMS),
  serverName: z.string(),
  createdAt: z.string(),
});
export type MintedToken = z.infer<typeof mintedTokenSchema>;
