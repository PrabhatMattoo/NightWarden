import "dotenv/config";
import { initSecrets } from "./secrets.js";
import { initDb } from "./db.js";
import { prepareSetup } from "./auth/setup-token.js";
import { buildServer } from "./server.js";
import {
  RECONCILE_TICK_MS,
  reconcileRecovery,
} from "./verification/reconciler.js";
import { initEnv } from "./config/env.js";
import { checkSecretKey } from "./config/store.js";
import { seedIntegrationsFromEnv } from "./integrations/seed.js";
import { recoverDeadRuns } from "./session/recover.js";
import { registerFrontendRoutes } from "./frontend.js";
import { buildAuthHeader } from "./integrations/github.js";
import { reapOrphans } from "./sandbox/docker.js";
import { salvageWorkspaces } from "./sandbox/salvage.js";
import { releaseContainers } from "./sandbox/workspace.js";
import { COMMIT_AUTHOR } from "./agent/tools/repo.js";
import { getGitHubIntegration } from "./integrations/store.js";
import { nightwardenDir, stateDirIsEphemeral, workspacesDir } from "./paths.js";
import { logger } from "./logger.js";

// Resolve the state directory first so a relative NIGHTWARDEN_DIR fails here with
// a clear message, not lazily mid-request.
try {
  const dir = nightwardenDir();
  if (stateDirIsEphemeral(dir)) {
    logger.error(
      { dir },
      "state directory is on the container's writable layer, so the database and secret key would be lost on restart - mount a volume at this path",
    );
    process.exit(1);
  }
  logger.info({ dir }, "state directory");
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Before anything that encrypts, signs or reads a stored credential.
initSecrets();
// Before the first setting is read, so a bad value refuses the boot here.
initEnv();

const isDev = process.env["NODE_ENV"] !== "production";

const { server: fastify, dispatcher } = await buildServer({
  logger: isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : true,
});

// Last, so it can never shadow an API route.
await registerFrontendRoutes(fastify);

const start = async (): Promise<void> => {
  try {
    initDb();
    fastify.log.info("SQLite ready");
    // Before the seed below, which encrypts with the key this decides on.
    checkSecretKey();
    prepareSetup();
    // First boot only, so a fresh install can come up with its evidence
    // integrations connected without anyone opening a browser.
    seedIntegrationsFromEnv();
    // Containers first, killing any still-running writer, then salvage: orphaned
    // work is pushed here before listen() lets a session provision over it.
    try {
      const reaped = await reapOrphans();
      if (reaped > 0) {
        fastify.log.info(`reaped ${reaped} orphaned sandbox containers`);
      }
    } catch {
      // Docker unreachable - salvage below still works, it is host-side git.
    }
    const salvaged = await salvageWorkspaces({
      workspacesDir: workspacesDir(),
      authHeader: async () => {
        const row = getGitHubIntegration();
        if (row === null) {
          return Promise.reject(
            new Error("GitHub integration is not configured"),
          );
        }
        return Promise.resolve(buildAuthHeader(row.token));
      },
      commitAuthor: COMMIT_AUTHOR,
      log: logger,
    });
    if (salvaged.pushed > 0 || salvaged.kept > 0) {
      fastify.log.info(
        `workspace salvage: ${salvaged.pushed} pushed, ${salvaged.kept} kept for manual recovery`,
      );
    }
    // Before listen(), so no dispatch can claim a session this is still failing.
    const recovered = recoverDeadRuns();
    if (recovered > 0) {
      fastify.log.info(`interrupted runs: ${recovered} marked failed`);
    }
    // An alert usually clears minutes after the run that fixed it ended, so
    // something has to keep asking. Unref'd: the server holds the loop open.
    setInterval(() => {
      void reconcileRecovery(dispatcher).catch((err: unknown) => {
        fastify.log.warn({ err }, "recovery reconciler pass failed");
      });
    }, RECONCILE_TICK_MS).unref();

    const port = parseInt(process.env["NIGHTWARDEN_PORT"] ?? "3000", 10);
    const host = process.env["NIGHTWARDEN_HOST"] ?? "127.0.0.1";
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();

// Without handlers the open SSE and WS connections keep the loop alive on
// Ctrl+C. Exit 0, so pnpm does not report a failed script.
function shutdown(signal: NodeJS.Signals): void {
  fastify.log.info({ signal }, "shutting down");
  const failsafe = setTimeout(() => process.exit(1), 5000);
  failsafe.unref();
  // Without this they run until the next boot reaps them, holding their
  // reservations. The checkouts stay for boot salvage to push.
  releaseContainers()
    .catch((err: unknown) => fastify.log.error(err))
    .finally(() => {
      fastify.close().then(
        () => process.exit(0),
        (err: unknown) => {
          fastify.log.error(err);
          process.exit(1);
        },
      );
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
