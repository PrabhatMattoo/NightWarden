import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import {
  dockerServiceKey,
  type Platform,
  type RunnerManifest,
} from "@nightwarden/shared";
import { parseRunnerMessage } from "@nightwarden/shared/schemas";
import type { Dispatcher } from "../dispatcher.js";
import { createRunner } from "../fleet/runners-store.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import type { RunnerConnection } from "../fleet/connections.js";
import { resolveCommand } from "../fleet/transport.js";
import { buildServer } from "../server.js";
import { runningSessionIds } from "../session/status-store.js";
import { fakeModel, type FakeModel } from "./fake-model.js";
import {
  dockerService,
  kubernetesManifest,
  kubernetesWorkload,
  manifest,
} from "./manifest-helper.js";
import { issueTestSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

// It decides nothing: what a runner replies is the test's own, passed in as
// `answer`, so a test still reads as what it is asserting.

export interface Command {
  commandName: string;
  commandInput: Record<string, unknown>;
}

export interface RunnerSpec {
  platform?: Platform;
  // Also the runner's address in a `runner` argument and in the fleet summary.
  name?: string;
  // The runner row's id; a fresh one when the test needs no row behind it.
  id?: string;
  /* Docker target names, or "namespace/workload" for Kubernetes. Advertised
     exactly as the real manifest would, so a target key resolves. */
  services?: string[];
  // Advertised in place of the one `services` builds.
  manifest?: RunnerManifest;
  // What the fake socket sends back. Omitted answers every command with [].
  answer?: (command: Command) => unknown;
  // The error the runner reports instead of an answer, or null to answer.
  fail?: (command: Command) => string | null;
  // Records each command and never answers, as a runner that hung would.
  silent?: boolean;
}

export interface HarnessRunner {
  id: string;
  name: string;
  connection: RunnerConnection;
  // Every command this runner was sent, in order, so no test keeps its own array.
  commands: Command[];
  disconnect(): void;
}

export interface Harness {
  server: FastifyInstance;
  dispatcher: Dispatcher;
  // The model every run of this server reaches.
  model: FakeModel;
  port: number;
  // Ready to spread into a request: { headers: harness.headers }.
  headers: { cookie: string };
  session: string;
  runners: HarnessRunner[];
  runner: HarnessRunner;
  url(path: string): string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  runners?: RunnerSpec[];
  // A model the test keeps a handle on; a fresh one when omitted.
  model?: FakeModel;
  // Off for a test that only needs inject(), which needs no open port.
  listen?: boolean;
}

function manifestFor(
  spec: Required<Pick<RunnerSpec, "platform" | "name">> & RunnerSpec,
): RunnerManifest {
  const services = spec.services ?? [];
  const server = spec.name;
  if (spec.platform === "kubernetes") {
    return kubernetesManifest(
      server,
      services.map((service) => {
        const [namespace, workload] = service.split("/");
        return kubernetesWorkload(
          server,
          namespace ?? "default",
          workload ?? service,
        );
      }),
    );
  }
  /* "project/service" where a Compose pair matters, a bare name where it does
     not - which is the anonymous-container convention dockerService builds. */
  return manifest(
    server,
    services.map((service) => {
      if (!service.includes("/")) return dockerService(server, service);
      const [project, name] = service.split("/") as [string, string];
      const identity = { project, service: name };
      return {
        identity,
        target: dockerServiceKey(server, identity),
        status: "running",
      };
    }),
  );
}

// A connected runner on a fake socket, parsing what it is sent as a runner does.
export function fakeRunner(spec: RunnerSpec = {}): HarnessRunner {
  const platform = spec.platform ?? "docker";
  const name = spec.name ?? `test-runner-${randomUUID().slice(0, 8)}`;
  const id = spec.id ?? randomUUID();
  const commands: Command[] = [];
  const connection = registerRunner({
    runnerId: id,
    platform,
    serverName: name,
    send: (raw: string) => {
      // Parsed as the runner parses it, so a command the API built wrongly fails the test.
      const parsed = parseRunnerMessage(raw);
      if (!parsed.ok)
        throw new Error(`malformed runner message: ${parsed.reason}`);
      const msg = parsed.message;
      if (msg.type !== "command") return;
      const { payload } = msg;
      const command = {
        commandName: payload.commandName,
        commandInput: payload.commandInput,
      };
      commands.push(command);
      if (spec.silent === true) return;
      const error = spec.fail?.(command) ?? null;
      resolveCommand(
        error === null
          ? {
              correlationId: payload.correlationId,
              success: true,
              result: spec.answer ? spec.answer(command) : [],
            }
          : {
              correlationId: payload.correlationId,
              success: false,
              result: null,
              error,
            },
      );
    },
    close: () => {},
  });
  setRunnerManifest(
    id,
    spec.manifest ?? manifestFor({ ...spec, platform, name }),
  );
  return {
    id,
    name,
    connection,
    commands,
    disconnect: () => unregisterRunner(connection),
  };
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const cleanupDb = await useTempDb();
  const session = await issueTestSession();

  const runners: HarnessRunner[] = await Promise.all(
    (options.runners ?? []).map(async (spec, index) => {
      const platform = spec.platform ?? "docker";
      const name = spec.name ?? `test-runner-${index + 1}`;
      const id = (await createRunner(platform, name)).id;
      return fakeRunner({ ...spec, platform, name, id });
    }),
  );

  const model = options.model ?? fakeModel();
  const { server, dispatcher } = await buildServer({
    modelFor: model.modelFor,
  });
  let port = 0;
  if (options.listen === false) {
    await server.ready();
  } else {
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  }

  return {
    server,
    dispatcher,
    model,
    port,
    session,
    headers: { cookie: `${session}` },
    runners,
    // The common case is one, and naming it saves every test an index.
    get runner() {
      const only = runners[0];
      if (only === undefined) throw new Error("this harness has no runner");
      return only;
    },
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async close() {
      // A run left working would write into the next test's database.
      for (const id of await runningSessionIds()) dispatcher.stop(id);
      await waitFor(async () => (await runningSessionIds()).length === 0);
      for (const entry of runners) entry.disconnect();
      await server.close();
      cleanupDb();
    },
  };
}
