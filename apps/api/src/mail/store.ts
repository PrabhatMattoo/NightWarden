import { eq } from "drizzle-orm";
import {
  DEFAULT_SMTP_SECURITY,
  type MailPatch,
  type MailSettings,
  type SmtpSecurity,
} from "@nightwarden/shared";
import { envConfig, refuseLocked } from "../config/env.js";
import { getDb } from "../db.js";
import { decrypt, encrypt } from "../secrets.js";
import { mailServerConfig } from "./schema.js";

const MAIL_ID = "mail";

// What the mail server is told to do, with the password in the clear.
export interface MailServer {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  from: string;
}

type ResolvedMail = { [F in keyof MailServer]: MailServer[F] | null };

function readRow(): typeof mailServerConfig.$inferSelect | undefined {
  return getDb()
    .select()
    .from(mailServerConfig)
    .where(eq(mailServerConfig.id, MAIL_ID))
    .get();
}

// Each field is the environment's, else the saved value; null is a field nobody set.
function resolveMail(): ResolvedMail {
  const row = readRow();
  const { mail } = envConfig();
  return {
    host: mail.host ?? row?.host ?? null,
    port: mail.port ?? row?.port ?? null,
    security: mail.security ?? row?.security ?? null,
    username: mail.username ?? row?.username ?? null,
    password:
      mail.password ??
      (row?.passwordEncrypted ? decrypt(row.passwordEncrypted) : null),
    from: mail.from ?? row?.from ?? null,
  };
}

function toMailServer(mail: ResolvedMail): MailServer | null {
  const { host, port, from } = mail;
  if (host === null || port === null || from === null) return null;
  return {
    host,
    port,
    security: mail.security ?? DEFAULT_SMTP_SECURITY,
    username: mail.username,
    password: mail.password,
    from,
  };
}

export function loadMailSettings(): MailSettings {
  const { password, ...rest } = resolveMail();
  return {
    ...rest,
    passwordSet: password !== null,
    locked: envConfig().locked.mail,
  };
}

// Null until a host, a port and a sender are all set: mail cannot go out without them.
export function mailServer(): MailServer | null {
  return toMailServer(resolveMail());
}

// A login-less server has no password to keep, so removing the username removes it too.
function passwordAfter(
  patch: MailPatch,
  current: string | null,
): string | null {
  if (patch.username === null) return null;
  return patch.password ?? current;
}

// What the settings would be once the patch is saved, so it can be checked before it is.
export function mailServerWith(patch: MailPatch): MailServer | null {
  refuseLocked(envConfig().locked.mail, patch);
  const current = resolveMail();
  return toMailServer({
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
    security: patch.security ?? current.security,
    username: patch.username === undefined ? current.username : patch.username,
    password: passwordAfter(patch, current.password),
    from: patch.from ?? current.from,
  });
}

export function updateMailSettings(patch: MailPatch): MailSettings {
  refuseLocked(envConfig().locked.mail, patch);
  const values = {
    ...(patch.host !== undefined && { host: patch.host }),
    ...(patch.port !== undefined && { port: patch.port }),
    ...(patch.security !== undefined && { security: patch.security }),
    ...(patch.username !== undefined && { username: patch.username }),
    ...(patch.from !== undefined && { from: patch.from }),
    ...(patch.password !== undefined && {
      passwordEncrypted: encrypt(patch.password),
    }),
    ...(patch.username === null && { passwordEncrypted: null }),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .insert(mailServerConfig)
    .values({ id: MAIL_ID, ...values })
    .onConflictDoUpdate({ target: mailServerConfig.id, set: values })
    .run();
  return loadMailSettings();
}
