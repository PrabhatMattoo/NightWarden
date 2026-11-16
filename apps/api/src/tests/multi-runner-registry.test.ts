import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { RunnerManifest, RunnerRecord } from "@nightwarden/shared";
import { generateRunnerToken } from "../fleet/runners-store.js";
import { harness, type Harness } from "./harness.js";
import { waitFor } from "./wait.js";
import { resolveCommand, sendCommand } from "../fleet/transport.js";
import { within } from "./dispatch-helper.js";
import { logger } from "../logger.js";
import { dockerService, manifest } from "./manifest-helper.js";
import { frameText } from "./wire-helper.js";

let nw: Harness;

async function getRunners(): Promise<RunnerRecord[]> {
  const res = await nw.server.inject({
    method: "GET",
    url: "/api/runners",
    headers: nw.headers,
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as RunnerRecord[];
}

async function openHarness(): Promise<number> {
  nw = await harness();
  return nw.port;
}

async function closeHarness(): Promise<void> {
  await nw.close();
  vi.unstubAllEnvs();
}

// The server name is the row's, assigned when the token is issued; the hostname is what the box
// calls itself. Keys are prefixed with the first, never the second.
function runnerManifest(
  server: string,
  hostname: string,
  containers: string[],
): RunnerManifest {
  return manifest(
    hostname,
    containers.map((name) => dockerService(server, name)),
  );
}

// Connect a fake runner, wait for the server's `connected` ack, then send its manifest.
// Liveness rides protocol ping/pong, which the ws client answers automatically.
async function connectRunner(
  port: number,
  token: string,
  m: RunnerManifest,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(frameText(raw)) as { type: string };
      if (msg.type === "connected") resolve();
    });
  });
  ws.send(JSON.stringify({ messageId: "m", type: "manifest", payload: m }));
  return ws;
}

describe("flat runner registry", () => {
  let port: number;

  beforeAll(async () => {
    port = await openHarness();
  });

  afterAll(closeHarness);

  it("lists two runners each on their own token with correct manifests", async () => {
    const { plaintext: tokenA, id: tokenAId } = await generateRunnerToken(
      "docker",
      "one-up-a",
    );
    const { plaintext: tokenB, id: tokenBId } = await generateRunnerToken(
      "docker",
      "one-up-b",
    );
    const a = await connectRunner(
      port,
      tokenA,
      runnerManifest("one-up-a", "web-01", ["nginx", "api"]),
    );
    const b = await connectRunner(
      port,
      tokenB,
      runnerManifest("one-up-b", "db-02", ["postgres"]),
    );

    const runners = await waitFor(async () => {
      const list = await getRunners();
      const mine = list.filter((r) => r.id === tokenAId || r.id === tokenBId);
      return mine.length === 2 && mine.every((r) => r.manifest !== null)
        ? mine
        : undefined;
    });

    const byId = new Map(runners.map((r) => [r.id, r]));
    const ra = byId.get(tokenAId);
    const rb = byId.get(tokenBId);
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();

    expect(ra?.hostname).toBe("web-01");
    expect(rb?.hostname).toBe("db-02");
    expect(ra?.manifest?.services).toEqual([
      dockerService("one-up-a", "nginx"),
      dockerService("one-up-a", "api"),
    ]);
    expect(rb?.manifest?.services).toEqual([
      dockerService("one-up-b", "postgres"),
    ]);
    expect(ra?.manifest).not.toHaveProperty("token");
    expect(rb?.manifest).not.toHaveProperty("token");

    expect(ra?.online).toBe(true);
    expect(rb?.online).toBe(true);

    a.close();
    b.close();
  });

  it("drops a runner from the fleet when its socket closes, leaving the other", async () => {
    const { plaintext: tokenA, id: tokenAId } = await generateRunnerToken(
      "docker",
      "close-one-a",
    );
    const { plaintext: tokenB, id: tokenBId } = await generateRunnerToken(
      "docker",
      "close-one-b",
    );
    const a = await connectRunner(
      port,
      tokenA,
      runnerManifest("close-one-a", "web-01", ["nginx"]),
    );
    const b = await connectRunner(
      port,
      tokenB,
      runnerManifest("close-one-b", "db-02", ["postgres"]),
    );
    await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => (r.id === tokenAId || r.id === tokenBId) && r.manifest !== null,
      );
      return live.length === 2 ? true : undefined;
    });

    a.close();

    const remaining = await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => (r.id === tokenAId || r.id === tokenBId) && r.online,
      );
      return live.length === 1 ? live : undefined;
    });
    expect(remaining[0].id).toBe(tokenBId);

    b.close();
  });

  it("a reconnect on the same token displaces the old socket and survives its late close", async () => {
    const { plaintext: token, id: tokenId } = await generateRunnerToken(
      "docker",
      "displace",
    );

    const a = await connectRunner(
      port,
      token,
      runnerManifest("displace", "displace-host", ["nginx"]),
    );
    await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => r.id === tokenId && r.online && r.manifest !== null,
      );
      return live.length === 1 ? true : undefined;
    });

    // A second connection on the same token displaces A: the server closes it.
    const aClosed = new Promise<void>((resolve) => {
      a.on("close", () => resolve());
    });
    const b = await connectRunner(
      port,
      token,
      runnerManifest("displace", "displace-host", ["nginx"]),
    );
    await aClosed;

    // Regression: A's late close event must not delete B's registration, so
    // the runner stays online through the displacement.
    await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => r.id === tokenId && r.online && r.manifest !== null,
      );
      return live.length === 1 ? true : undefined;
    });

    b.close();
    await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => r.id === tokenId && r.online,
      );
      return live.length === 0 ? true : undefined;
    });
  });

  describe("in-flight commands on socket close", () => {
    it("rejects an in-flight command promptly when the runner socket closes, and drops the late result", async () => {
      const { plaintext: token, id: tokenId } = await generateRunnerToken(
        "docker",
        "inflight",
      );
      const ws = await connectRunner(
        port,
        token,
        runnerManifest("inflight", "inflight-host", ["inflight-svc"]),
      );
      await waitFor(async () => {
        const live = (await getRunners()).filter(
          (r) => r.id === tokenId && r.manifest !== null,
        );
        return live.length === 1 ? true : undefined;
      });

      // Capture the command frame but never reply, simulating a runner that
      // dies mid-command.
      let correlationId: string | undefined;
      ws.on("message", (raw) => {
        const msg = JSON.parse(frameText(raw)) as {
          type: string;
          payload?: { correlationId?: string };
        };
        if (msg.type === "command") correlationId = msg.payload?.correlationId;
      });

      const settled = sendCommand(
        "GetDockerLogs",
        {
          target: "inflight/inflight-svc/inflight-svc",
        },
        within(),
      ).catch((err: unknown) => err);

      await waitFor(() => (correlationId ? true : undefined));
      ws.close();

      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        name: "CommandUnansweredError",
        reason: "disconnect",
      });

      // A result arriving after the rejection has nowhere to go: it must be
      // logged and dropped, never throw.
      const warn = vi.spyOn(logger, "warn");
      resolveCommand({
        correlationId: correlationId!,
        success: true,
        result: {},
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId }),
        expect.stringMatching(/late or unknown/i),
      );
      warn.mockRestore();
    });

    it("a displaced socket's in-flight command rejects while the replacement stays online", async () => {
      const { plaintext: token, id: tokenId } = await generateRunnerToken(
        "docker",
        "inflight-displace",
      );
      const a = await connectRunner(
        port,
        token,
        runnerManifest("inflight-displace", "inflight-d-host", [
          "displace-svc",
        ]),
      );
      await waitFor(async () => {
        const live = (await getRunners()).filter(
          (r) => r.id === tokenId && r.manifest !== null,
        );
        return live.length === 1 ? true : undefined;
      });

      let sawCommand = false;
      a.on("message", (raw) => {
        const msg = JSON.parse(frameText(raw)) as { type: string };
        if (msg.type === "command") sawCommand = true;
      });

      const settled = sendCommand(
        "GetDockerLogs",
        {
          target: "inflight-displace/displace-svc/displace-svc",
        },
        within(),
      ).catch((err: unknown) => err);
      await waitFor(() => (sawCommand ? true : undefined));

      const aClosed = new Promise<void>((resolve) => {
        a.on("close", () => resolve());
      });
      const b = await connectRunner(
        port,
        token,
        runnerManifest("inflight-displace", "inflight-d-host", [
          "displace-svc",
        ]),
      );
      await aClosed;

      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        name: "CommandUnansweredError",
        reason: "disconnect",
      });

      // The replacement connection is unaffected by A's close and rejection.
      await waitFor(async () => {
        const live = (await getRunners()).filter(
          (r) => r.id === tokenId && r.online && r.manifest !== null,
        );
        return live.length === 1 ? true : undefined;
      });
      b.close();
    });
  });
});

// Let real socket IO complete while timers are faked - setImmediate is never
// in the toFake list, so these turns run on the real event loop.
async function flushIo(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("protocol ping/pong liveness", () => {
  let port: number;

  beforeAll(async () => {
    port = await openHarness();
  });

  afterAll(closeHarness);

  it("terminates a socket that stops answering pings and drops the runner offline", async () => {
    const { plaintext: token, id: tokenId } = await generateRunnerToken(
      "docker",
      "no-pong",
    );
    // Fake timers before connecting: the per-connection ping interval must be
    // created under fake timers to be advanceable. Date stays real.
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    try {
      const ws = await connectRunner(
        port,
        token,
        runnerManifest("no-pong", "no-pong-host", ["no-pong-svc"]),
      );
      // Dead-peer stand-in: suppress the client's automatic protocol pong.
      ws.pong = () => {};
      const closed = new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
      });

      await vi.advanceTimersByTimeAsync(30_000); // ping sent, isAlive cleared
      await flushIo();
      await vi.advanceTimersByTimeAsync(30_000); // missed pong: terminate
      vi.useRealTimers();

      await closed;
      await waitFor(async () => {
        const live = (await getRunners()).filter(
          (r) => r.id === tokenId && r.online,
        );
        return live.length === 0 ? true : undefined;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pongs keep the runner online past the liveness TTL", async () => {
    const { plaintext: token, id: tokenId } = await generateRunnerToken(
      "docker",
      "pong-live",
    );
    // Date is faked here so fake time can outrun the 120s TTL; pongs must be
    // what keeps lastSeen fresh.
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    try {
      const ws = await connectRunner(
        port,
        token,
        runnerManifest("pong-live", "pong-live-host", ["pong-live-svc"]),
      );
      await flushIo();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        // Let each ping/pong round-trip complete so lastSeen refreshes.
        await flushIo();
      }

      // 150s of fake time elapsed - past the TTL. Only pong-driven refreshes
      // can explain the runner still reading online.
      const live = (await getRunners()).filter(
        (r) => r.id === tokenId && r.online,
      );
      expect(live).toHaveLength(1);

      vi.useRealTimers();
      ws.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
