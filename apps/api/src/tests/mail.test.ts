import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { MailSettings } from "@nightwarden/shared";
import { initEnv } from "../config/env.js";
import { harness, type Harness } from "./harness.js";
import { waitFor } from "./wait.js";

const LOGIN = { username: "mailer", password: "s3cret" };
const FROM = "nightwarden@example.test";
const BROWSER_ORIGIN = "http://localhost";

// The one network boundary: a real SMTP server that keeps every message it accepts.
const delivered: string[] = [];
let smtp: SMTPServer;
let smtpPort = 0;

beforeAll(async () => {
  smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, done) {
      if (
        auth.username === LOGIN.username &&
        auth.password === LOGIN.password
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

// Quoted-printable, which is how a long line with an equals sign arrives.
function decodeBody(source: string): string {
  return source
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

describe("outgoing mail", () => {
  let nw: Harness;

  beforeEach(async () => {
    delivered.length = 0;
    nw = await harness({ listen: false });
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
    initEnv();
  });

  const goodSettings = () => ({
    host: "127.0.0.1",
    port: smtpPort,
    security: "none",
    from: FROM,
    ...LOGIN,
  });

  function putMail(payload: Record<string, unknown>) {
    return nw.server.inject({
      method: "PUT",
      url: "/api/config/mail",
      headers: nw.headers,
      payload,
    });
  }

  async function getMail(): Promise<MailSettings> {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config/mail",
      headers: nw.headers,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as MailSettings;
  }

  async function passwordResetAvailable(): Promise<boolean> {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/sign-in-options",
    });
    return (JSON.parse(res.body) as { passwordReset: boolean }).passwordReset;
  }

  it("saves settings the server accepts, never shows the password back, and keeps it when a later save omits it", async () => {
    expect(await getMail()).toMatchObject({ host: null, passwordSet: false });

    const saved = await putMail(goodSettings());
    expect(saved.statusCode).toBe(200);
    // Not the password, nor the tail of it, which a hint would show.
    expect(saved.body).not.toContain(LOGIN.password.slice(-4));

    const renamed = await putMail({ from: "ops@example.test" });

    expect(renamed.statusCode).toBe(200);
    expect(await getMail()).toMatchObject({
      host: "127.0.0.1",
      port: smtpPort,
      security: "none",
      username: LOGIN.username,
      passwordSet: true,
      from: "ops@example.test",
    });
  });

  it("answers 422 to credentials the server refuses and stores nothing", async () => {
    await putMail(goodSettings());

    const refused = await putMail({ password: "wrong-password" });

    expect(refused.statusCode).toBe(422);
    expect(await getMail()).toMatchObject({
      username: LOGIN.username,
      passwordSet: true,
    });
  });

  it("answers 422 to settings too incomplete to send from", async () => {
    const { from: _from, ...withoutFrom } = goodSettings();
    const incomplete = await putMail(withoutFrom);

    expect(incomplete.statusCode).toBe(422);
    expect((await getMail()).host).toBeNull();
  });

  it("refuses a change to a field the environment sets, naming the variable", async () => {
    vi.stubEnv("NIGHTWARDEN_SMTP_HOST", "127.0.0.1");
    initEnv();

    const refused = await putMail({ host: "mail.example.test" });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain("NIGHTWARDEN_SMTP_HOST");
    expect(await getMail()).toMatchObject({
      host: "127.0.0.1",
      locked: { host: "NIGHTWARDEN_SMTP_HOST" },
    });
  });

  it("offers a password reset only once mail is configured", async () => {
    expect(await passwordResetAvailable()).toBe(false);

    await putMail(goodSettings());

    expect(await passwordResetAvailable()).toBe(true);
  });

  it("emails a link that resets the password and ends the sessions of the old one", async () => {
    await putMail(goodSettings());

    const asked = await nw.server.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      headers: { origin: BROWSER_ORIGIN },
      payload: { email: "owner@example.test", redirectTo: "/reset-password" },
    });
    expect(asked.statusCode).toBe(200);

    const message = decodeBody(await waitFor(() => delivered[0]));
    const link = message.match(/http\S+\/reset-password\/\S+/)?.[0];
    expect(link).toBeDefined();
    const followed = await nw.server.inject({
      method: "GET",
      url: new URL(link ?? "").pathname + new URL(link ?? "").search,
      headers: { origin: BROWSER_ORIGIN },
    });
    const token = new URL(followed.headers.location ?? "").searchParams.get(
      "token",
    );
    expect(token).not.toBeNull();

    const reset = await nw.server.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      headers: { origin: BROWSER_ORIGIN },
      payload: { token, newPassword: "a-new-long-password" },
    });
    expect(reset.statusCode).toBe(200);

    const signIn = (password: string) =>
      nw.server.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: BROWSER_ORIGIN },
        payload: { email: "owner@example.test", password },
      });
    expect((await signIn("a-new-long-password")).statusCode).toBe(200);
    expect((await signIn("a-long-enough-password")).statusCode).toBe(401);
    const stale = await nw.server.inject({
      method: "GET",
      url: "/api/config/mail",
      headers: nw.headers,
    });
    expect(stale.statusCode).toBe(401);
  });
});
