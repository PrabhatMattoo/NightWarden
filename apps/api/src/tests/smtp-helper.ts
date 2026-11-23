import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll } from "vitest";

export const SMTP_LOGIN = { username: "mailer", password: "s3cret" };
const SMTP_FROM = "nightwarden@example.test";

export interface TestSmtp {
  // Every message the server accepted, raw, in arrival order.
  delivered: string[];
  // Listening only once beforeAll has run.
  port(): number;
  // Settings the server accepts, ready for PUT /api/config/mail.
  settings(): Record<string, unknown>;
}

// The one network boundary of the mail tests: a real SMTP server that keeps every message it accepts.
export function useSmtpServer(): TestSmtp {
  const delivered: string[] = [];
  let smtp: SMTPServer;
  let smtpPort = 0;

  beforeAll(async () => {
    smtp = new SMTPServer({
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      onAuth(auth, _session, done) {
        if (
          auth.username === SMTP_LOGIN.username &&
          auth.password === SMTP_LOGIN.password
        ) {
          done(null, { user: auth.username });
          return;
        }
        done(new Error("Invalid login"));
      },
      onData(stream, _session, done) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          delivered.push(Buffer.concat(chunks).toString());
          done();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    // Listening on a TCP port, so the address is an AddressInfo and not a pipe name.
    smtpPort = (smtp.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => smtp.close(resolve));
  });

  return {
    delivered,
    port: () => smtpPort,
    settings: () => ({
      host: "127.0.0.1",
      port: smtpPort,
      security: "none",
      from: SMTP_FROM,
      ...SMTP_LOGIN,
    }),
  };
}

// Quoted-printable, which is how a long line with an equals sign arrives.
export function decodeBody(source: string): string {
  return source
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}
