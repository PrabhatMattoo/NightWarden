import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunnerManifest, NormalizedAlert } from "@nightwarden/shared";
import { createRunner } from "../fleet/runners-store.js";
import { dispatcherFor } from "../server.js";
import { isRunning } from "../session/status-store.js";
import { fakeModel, messagesSentTo, type ScriptedTurn } from "./fake-model.js";
import { fakeRunner, type HarnessRunner } from "./harness.js";
import { dockerService, manifest } from "./manifest-helper.js";
import { dispatchAlertSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

// The two servers this file connects, named once so keys and addresses agree.
const SERVER_A = "web-01";
const SERVER_B = "db-02";

const FINISH: ScriptedTurn = { toolUses: [], text: "Investigation complete." };

const scripted = fakeModel([FINISH]);
const dispatcher = dispatcherFor(scripted.modelFor);

function dockerManifest(
  server: string,
  serviceNames: string[],
): RunnerManifest {
  return manifest(
    `${server}.internal`,
    serviceNames.map((name) => dockerService(server, name)),
  );
}

function makeAlert(service: string): NormalizedAlert {
  return {
    sourceAlertId: `alert-${randomUUID()}`,
    // The labels are the whole record of what the alert named; the Compose pair
    // is what the manifest fixtures below advertise.
    labels: {
      alertname: "HighCPU",
      "com.docker.compose.project": service,
      "com.docker.compose.service": service,
    },
    alertType: "HighCPU",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

// The opening turn an alert run sends, read off the wire.
async function openingTurn(): Promise<string> {
  const sessionId = randomUUID();
  const before = scripted.requests.length;
  dispatchAlertSession(dispatcher, sessionId, [makeAlert("nginx")]);
  await waitFor(() => !isRunning(sessionId));
  return messagesSentTo(scripted, before)[0]?.texts.join("\n") ?? "";
}

describe("fleet summary injection", () => {
  let cleanupDb: () => void;
  const runners: HarnessRunner[] = [];

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => cleanupDb());

  afterEach(() => {
    for (const runner of runners.splice(0)) runner.disconnect();
  });

  it("names every server, its platform and each service's key, and none of the raw manifest", async () => {
    for (const [server, services] of [
      [SERVER_A, ["nginx", "api"]],
      [SERVER_B, ["nginx", "postgres"]],
    ] as const) {
      runners.push(
        fakeRunner({
          id: createRunner("docker", server).id,
          name: server,
          manifest: dockerManifest(server, [...services]),
        }),
      );
    }

    const msg = await openingTurn();

    expect(msg).toContain("<servers>");
    expect(msg).toContain(`${SERVER_A} (Docker host):`);
    // The same service on two servers is two keys, each naming its own server.
    expect(msg).toContain(`${SERVER_A}/nginx/nginx`);
    expect(msg).toContain(`${SERVER_A}/api/api`);
    expect(msg).toContain(`${SERVER_B}/nginx/nginx`);
    expect(msg).toContain(`${SERVER_B}/postgres/postgres`);
    expect(msg).not.toContain("hostMetrics");
    expect(msg).not.toContain("fileRead");
    expect(msg).not.toContain("runnerVersion");
  });

  it("sends no servers block while no runner is connected", async () => {
    expect(await openingTurn()).not.toContain("<servers>");
  });
});
