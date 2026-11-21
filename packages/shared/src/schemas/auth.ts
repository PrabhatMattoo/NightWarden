import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "../auth.js";

export const setupStatusSchema = z.object({ required: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupRequestSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;
