import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert, SessionListPage } from "@nightwarden/shared";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { user } from "../auth/schema.js";
import { getDb } from "../db.js";
import { getSession } from "../session/store.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";
import { harness, type Harness } from "./harness.js";
import {
  accountId,
  issueTestSession,
  TEST_MEMBER,
  TEST_OWNER,
  seedAlertSession,
  seedChatSession,
} from "./session-helper.js";
import { waitFor } from "./wait.js";

const ALERT: NormalizedAlert = {
  sourceAlertId: "privacy-alert",
  labels: {},
  alertName: "ContainerDown",
  firedAt: new Date().toISOString(),
  annotations: {},
  generatorURL: null,
  values: {},
};

// A chat is its creator's alone, an administrator's included. An investigation
// belongs to whoever may read investigations.
describe("who may reach a session", () => {
  let nw: Harness;
  let admin: string;
  let member: string;
  let memberId: string;

  beforeAll(async () => {
    nw = await harness();
    admin = nw.session;
    member = await issueTestSession("member");
    memberId = accountId(TEST_MEMBER.email);
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  const send = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    await fetch(nw.url(`/api${path}`), {
      method,
      headers: {
        Cookie: cookie,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  function investigation(): string {
    const id = randomUUID();
    seedAlertSession(buildSessionMeta(id, ALERT, undefined), [
      { ...ALERT, sourceAlertId: randomUUID() },
    ]);
    return id;
  }

  it("answers someone else's chat as it answers an id that does not exist", async () => {
    const chat = randomUUID();
    seedChatSession(chat, "mine", memberId);
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", ""],
      ["GET", "/report"],
      ["DELETE", ""],
      ["POST", "/stop", {}],
      ["POST", "/respond", { decision: "approve" }],
      ["POST", "/start", {}],
      ["POST", "/reopen", { reason: "again", clientMessageId: randomUUID() }],
      [
        "POST",
        "/messages",
        { message: "hello", clientMessageId: randomUUID() },
      ],
    ];
    for (const [method, suffix, body] of attempts) {
      const route = `${method} /sessions/:id${suffix}`;
      const stranger = await send(
        admin,
        method,
        `/sessions/${chat}${suffix}`,
        body,
      );
      const unknown = await send(
        admin,
        method,
        `/sessions/${randomUUID()}${suffix}`,
        body,
      );
      expect(stranger.status, route).toBe(404);
      expect(await stranger.json(), route).toEqual(await unknown.json());
    }
    // The creator reaches the same chat, so the refusals above were its owner's rule.
    expect((await send(member, "GET", `/sessions/${chat}`)).status).toBe(200);
    expect(getSession(chat)).toBeDefined();
  });

  it("streams a chat's events to its creator alone", async () => {
    const watcher = await connectFrontendEvents(nw.port, admin);
    const creator = await connectFrontendEvents(nw.port, member);
    try {
      const started = await send(member, "POST", "/chat", {
        message: "private question",
        clientMessageId: randomUUID(),
      });
      const { sessionId } = (await started.json()) as { sessionId: string };
      await waitFor(() =>
        creator.events.some(
          (e) =>
            e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
        ),
      );
      // The watcher's own chat finishing after proves its stream was live while
      // the creator's chat ran, so the silence about the other is a decision.
      const own = await send(admin, "POST", "/chat", {
        message: "my own question",
        clientMessageId: randomUUID(),
      });
      const { sessionId: ownId } = (await own.json()) as { sessionId: string };
      await waitFor(() =>
        watcher.events.some(
          (e) => e.type === "RUN_FINISHED" && e.payload["sessionId"] === ownId,
        ),
      );
      expect(
        watcher.events.filter((e) => e.payload["sessionId"] === sessionId),
      ).toEqual([]);
    } finally {
      watcher.close();
      creator.close();
    }
  });

  it("lists a person's own chats and every investigation", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    seedChatSession(mine, "from the member", memberId);
    seedChatSession(theirs, "from the admin", accountId(TEST_OWNER.email));
    const shared = investigation();

    const list = async (cookie: string, kind: string) =>
      (
        (await (
          await send(cookie, "GET", `/sessions?kind=${kind}&limit=200`)
        ).json()) as SessionListPage
      ).rows.map((row) => row.sessionId);

    const chats = await list(member, "chat");
    expect(chats).toContain(mine);
    expect(chats).not.toContain(theirs);
    expect(await list(member, "investigation")).toContain(shared);
    expect(await list(admin, "investigation")).toContain(shared);
    expect((await send(member, "GET", `/sessions/${shared}`)).status).toBe(200);
  });

  it("lets a person delete their own chat, and only an admin an investigation", async () => {
    const chat = randomUUID();
    seedChatSession(chat, "to delete", memberId);
    expect((await send(member, "DELETE", `/sessions/${chat}`)).status).toBe(
      204,
    );
    expect(getSession(chat)).toBeUndefined();

    const shared = investigation();
    expect((await send(member, "DELETE", `/sessions/${shared}`)).status).toBe(
      403,
    );
    expect(getSession(shared)).toBeDefined();
    expect((await send(admin, "DELETE", `/sessions/${shared}`)).status).toBe(
      204,
    );
    expect(getSession(shared)).toBeUndefined();
  });

  it("erases a deleted person's chats and leaves everything else", () => {
    const leaving = randomUUID();
    seedChatSession(leaving, "leaves with its owner", memberId);
    const stays = randomUUID();
    seedChatSession(stays, "stays", accountId(TEST_OWNER.email));
    const shared = investigation();

    getDb().delete(user).where(eq(user.id, memberId)).run();

    expect(getSession(leaving)).toBeUndefined();
    expect(getSession(stays)).toBeDefined();
    expect(getSession(shared)).toBeDefined();
  });
});
