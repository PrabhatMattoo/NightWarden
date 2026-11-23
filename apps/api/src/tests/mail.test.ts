import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSettings } from "@nightwarden/shared";
import { initEnv } from "../config/env.js";
import { harness, type Harness } from "./harness.js";
import { call, signIn } from "./session-helper.js";
import { decodeBody, SMTP_LOGIN, useSmtpServer } from "./smtp-helper.js";
import { waitFor } from "./wait.js";

const BROWSER_ORIGIN = "http://localhost";

const smtp = useSmtpServer();

describe("outgoing mail", () => {
  let nw: Harness;

  beforeEach(async () => {
    smtp.delivered.length = 0;
    nw = await harness({ listen: false });
  });

  afterEach(async () => {
    await nw.close();
    vi.unstubAllEnvs();
    initEnv();
  });

  const goodSettings = () => smtp.settings();

  const putMail = (payload: Record<string, unknown>) =>
    call(nw.server, "PUT", "/api/config/mail", nw.session, payload);

  async function getMail(): Promise<MailSettings> {
    const res = await call(nw.server, "GET", "/api/config/mail", nw.session);
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
    expect(saved.body).not.toContain(SMTP_LOGIN.password.slice(-4));

    const renamed = await putMail({ from: "ops@example.test" });

    expect(renamed.statusCode).toBe(200);
    const read = await call(nw.server, "GET", "/api/config/mail", nw.session);
    expect(read.body).not.toContain(SMTP_LOGIN.password.slice(-4));
    expect(await getMail()).toMatchObject({
      host: "127.0.0.1",
      port: smtp.port(),
      security: "none",
      username: SMTP_LOGIN.username,
      passwordSet: true,
      from: "ops@example.test",
    });
  });

  it("answers 422 to credentials the server refuses and stores nothing", async () => {
    await putMail(goodSettings());

    const refused = await putMail({ password: "wrong-password" });

    expect(refused.statusCode).toBe(422);
    expect(await getMail()).toMatchObject({
      username: SMTP_LOGIN.username,
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

    const message = decodeBody(await waitFor(() => smtp.delivered[0]));
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

    const signInWith = (password: string) =>
      signIn(nw.server, { email: "owner@example.test", password });
    expect((await signInWith("a-new-long-password")).statusCode).toBe(200);
    expect((await signInWith("a-long-enough-password")).statusCode).toBe(401);
    const stale = await call(nw.server, "GET", "/api/config/mail", nw.session);
    expect(stale.statusCode).toBe(401);
  });
});
