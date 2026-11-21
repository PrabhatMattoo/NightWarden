import { createHash } from "node:crypto";
import { harness, type Harness } from "./harness.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { getFleetView } from "../fleet/connections.js";
import { getDb } from "../db.js";
import { runner } from "../fleet/schema.js";
import { sessions } from "../session/schema.js";
import { createRunner, touchLastUsed } from "../fleet/runners-store.js";
import { createSession } from "../session/store.js";
import { frameText } from "./wire-helper.js";

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// The row's last_used_at, or undefined once the row is gone.
function lastUsedAt(id: string): string | null | undefined {
  const row = getDb()
    .select({ lastUsedAt: runner.lastUsedAt })
    .from(runner)
    .where(eq(runner.id, id))
    .get();
  return row?.lastUsedAt;
}

// A socket error is a failure here, so a refusal is only ever read from the close code it sent.
function closeCodeOf(port: number, authorization?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
      headers:
        authorization === undefined ? {} : { Authorization: authorization },
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
}

describe("Runner token lifecycle", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness();
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  describe("POST /runners", () => {
    it("returns nwr_-prefixed plaintext with a UUID id", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-01" },
        headers: { cookie: `${SESSION}` },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { token: string; id: string };
      expect(body.token).toMatch(/^nwr_[A-Za-z0-9_-]{43}$/);
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores only the SHA-256 hash in the DB, never the plaintext", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-02" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(res.body) as {
        token: string;
        id: string;
      };
      const row = getDb()
        .select({ token: runner.token })
        .from(runner)
        .where(eq(runner.id, id))
        .get();
      expect(row).toBeDefined();
      expect(row!.token).toBe(sha256hex(token));
      expect(row!.token).not.toContain("nwr_");
    });

    // A runner that does not know what it is when its token is issued is the defect this
    // column exists to prevent, so there is no default to fall back on.
    it("refuses to issue one without a platform", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { serverName: "no-platform" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining("platform"),
      });
    });

    it("refuses a platform it does not recognise", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "nomad" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("stores the platform on the row and returns it", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "kubernetes", serverName: "prod-cluster" },
      });
      expect(res.statusCode).toBe(201);
      const { id, platform } = JSON.parse(res.body) as {
        id: string;
        platform: string;
      };
      expect(platform).toBe("kubernetes");
      const row = getDb()
        .select({ platform: runner.platform })
        .from(runner)
        .where(eq(runner.id, id))
        .get();
      expect(row?.platform).toBe("kubernetes");
    });

    it("stores and returns serverName when provided", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-01" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { serverName: string };
      expect(body.serverName).toBe("web-01");
    });

    // The name is the first segment of every key this runner will advertise, so
    // a nameless runner has nothing to address its services by.
    it("returns 400 when serverName is absent", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining("serverName"),
      });
    });

    it("returns 400 when serverName is empty", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "" },
      });
      expect(res.statusCode).toBe(400);
      // serverNameError owns every rule about the name, so the API and the
      // wizard refuse it in the same words.
      expect((JSON.parse(res.body) as { error: string }).error).toContain(
        "Server name is required",
      );
    });

    it("returns 400 when serverName contains a forward slash", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "prod/web-01" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("reclaims a server name whose runner never connected (abandoned setup)", async () => {
      const first = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "db-server-01" },
      });
      const { id: firstId } = JSON.parse(first.body) as { id: string };

      const second = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "db-server-01" },
      });
      expect(second.statusCode).toBe(201);

      // The abandoned orphan is gone; only the fresh reservation holds the name.
      const rows = getDb()
        .select({ id: runner.id })
        .from(runner)
        .where(eq(runner.serverName, "db-server-01"))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(firstId);
    });

    it("returns 409 when the server name belongs to a runner that has connected", async () => {
      const first = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-prod-01" },
      });
      const { id } = JSON.parse(first.body) as { id: string };
      // Simulate the runner manifesting (manifest handler sets last_used_at).
      touchLastUsed(id);

      const res = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-prod-01" },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("DELETE /runners/:id", () => {
    it("returns 204 and removes the token row entirely", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: {
          platform: "docker",
          label: "to-delete",
          serverName: "srv-05",
        },
      });
      const { id } = JSON.parse(issued.body) as { id: string };

      const del = await nw.server.inject({
        method: "DELETE",
        url: `/api/runners/${id}`,
        headers: { cookie: `${SESSION}` },
      });
      expect(del.statusCode).toBe(204);
      expect(lastUsedAt(id)).toBeUndefined();
    });

    it("returns 404 for unknown id", async () => {
      const res = await nw.server.inject({
        method: "DELETE",
        url: "/api/runners/00000000-0000-0000-0000-000000000000",
        headers: { cookie: `${SESSION}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("denies reconnect with the deleted token", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-07" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(issued.body) as {
        token: string;
        id: string;
      };

      await nw.server.inject({
        method: "DELETE",
        url: `/api/runners/${id}`,
        headers: { cookie: `${SESSION}` },
      });

      expect(await closeCodeOf(port, `Bearer ${token}`)).toBe(4003);
    });
  });

  describe("runner WS connect", () => {
    it("accepts a valid token and sends connected", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-08" },
        headers: { cookie: `${SESSION}` },
      });
      const { token } = JSON.parse(issued.body) as { token: string };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(frameText(raw)) as { type: string };
          if (msg.type === "connected") {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
      });
    });

    // A disagreement is a real user error, the Docker install line pasted into
    // a cluster, so it is refused rather than half-served.
    it("refuses a runner whose manifest contradicts its row", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "mismatch-host" },
        headers: { cookie: `${SESSION}` },
      });
      const { token } = JSON.parse(issued.body) as { token: string };

      const { code, reason } = await new Promise<{
        code: number;
        reason: string;
      }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              messageId: "m1",
              type: "manifest",
              payload: {
                platform: "kubernetes",
                hostname: "some-cluster",
                runnerVersion: "3.0.0",
                services: [],
              },
            }),
          );
        });
        ws.on("close", (c, r) => resolve({ code: c, reason: String(r) }));
        ws.on("error", () => resolve({ code: 0, reason: "" }));
      });

      expect(code).toBe(4004);
      expect(reason).toMatch(/docker/);
      expect(reason).toMatch(/kubernetes/);
    });

    // Its platform says kubernetes, so acting on it would close the socket as a mismatch.
    it("drops a manifest the protocol does not describe, and acts on none of it", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "malformed-host" },
        headers: { cookie: `${SESSION}` },
      });
      const { token } = JSON.parse(issued.body) as { token: string };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await new Promise((resolve) => ws.on("open", resolve));

      const manifest = (payload: Record<string, unknown>): string =>
        JSON.stringify({ messageId: "m1", type: "manifest", payload });
      ws.send(manifest({ platform: "kubernetes", hostname: "half-written" }));
      ws.send(
        manifest({
          platform: "docker",
          hostname: "whole",
          runnerVersion: "3.0.0",
          services: [],
        }),
      );

      await expect
        .poll(() =>
          getFleetView().find((r) => r.serverName === "malformed-host"),
        )
        .toMatchObject({ hostname: "whole" });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("closes with 4003 for an unknown token", async () => {
      expect(
        await closeCodeOf(
          port,
          "Bearer nwr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
      ).toBe(4003);
    });

    it("closes with 4001 when no Authorization header is sent", async () => {
      expect(await closeCodeOf(port)).toBe(4001);
    });

    it("disconnects live runner sockets immediately on token delete", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-09" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(issued.body) as {
        token: string;
        id: string;
      };

      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(frameText(raw)) as { type: string };
          if (msg.type === "connected") {
            nw.server
              .inject({
                method: "DELETE",
                url: `/api/runners/${id}`,
                headers: { cookie: `${SESSION}` },
              })
              .catch(reject);
          }
        });
        ws.on("close", (c) => resolve(c));
      });
      expect(closeCode).toBe(4003);
    });
  });

  describe("lastUsedAt", () => {
    it("is set after the runner sends its manifest", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-10" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(issued.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(frameText(raw)) as { type: string };
          if (msg.type === "connected") {
            ws.send(
              JSON.stringify({
                type: "manifest",
                payload: {
                  platform: "docker",
                  hostname: "test-host",
                  runnerVersion: "2.0.0",
                  services: [],
                },
              }),
            );
            // Give the server one event-loop tick to process the manifest before closing.
            setTimeout(() => {
              ws.close();
              resolve();
            }, 20);
          }
        });
        ws.on("error", reject);
      });

      expect(lastUsedAt(id)).toBeTruthy();
    });

    // A runner whose platform API is down authenticates but never manifests.
    it("is set when the runner authenticates, before any manifest arrives", async () => {
      const issued = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        payload: { platform: "docker", serverName: "srv-12" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(issued.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(frameText(raw)) as { type: string };
          // No manifest is ever sent: the daemon it would enumerate is down.
          if (msg.type === "connected") {
            setTimeout(() => {
              ws.close();
              resolve();
            }, 20);
          }
        });
        ws.on("error", reject);
      });

      expect(lastUsedAt(id)).toBeTruthy();

      // So its name is no longer free, and the live runner keeps its token.
      const second = await nw.server.inject({
        method: "POST",
        url: "/api/runners",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "srv-12" },
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("session history after token deletion", () => {
    it("session row survives hard-deleting its runner token", async () => {
      const { id: runnerId } = createRunner("docker", "history-test");
      createSession({
        sessionId: "sess-history-1",
        title: "history session",
        createdAt: new Date().toISOString(),
      });

      await nw.server.inject({
        method: "DELETE",
        url: `/api/runners/${runnerId}`,
        headers: { cookie: `${SESSION}` },
      });

      const row = getDb()
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(eq(sessions.sessionId, "sess-history-1"))
        .get();
      expect(row).toBeDefined();
    });
  });
});
