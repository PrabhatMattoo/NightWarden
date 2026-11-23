/* The session's `mfaRequired` is added server-side and `twoFactorEnabled` belongs to
   a plugin the client does not infer, so both are read off the payload with a guard. */
export function mfaRequiredOf(session: object | null): boolean {
  return (
    session !== null && "mfaRequired" in session && session.mfaRequired === true
  );
}

export function hasMfa(session: object | null): boolean {
  return (
    session !== null &&
    "user" in session &&
    typeof session.user === "object" &&
    session.user !== null &&
    "twoFactorEnabled" in session.user &&
    session.user.twoFactorEnabled === true
  );
}
