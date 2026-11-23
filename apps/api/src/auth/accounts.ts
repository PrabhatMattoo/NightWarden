import { userIdByEmail } from "./account-store.js";
import { getAuth } from "./instance.js";

// Its message is a sentence a person can act on.
export class AccountExistsError extends Error {}

export interface NewAccount {
  name: string;
  email: string;
  password: string;
}

/* In-process only: sign-up is closed over HTTP, and with autoSignIn off this
   creates no session. Returns the new account's id. */
export async function createAccount(input: NewAccount): Promise<string> {
  // With autoSignIn off Better Auth answers a taken email with an invented user, not an error.
  if (userIdByEmail(input.email) !== undefined) {
    throw new AccountExistsError("An account with this email already exists.");
  }
  const { user } = await getAuth().api.signUpEmail({ body: input });
  return user.id;
}
