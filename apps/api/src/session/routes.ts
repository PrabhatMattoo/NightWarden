import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { SessionDetail, SessionReportResponse } from "@nightwarden/shared";
import {
  approvalResponseSchema,
  chatRequestSchema,
  refusals,
  reopenRequestSchema,
  respondRequestSchema,
  sessionAcceptedSchema,
  sessionDetailSchema,
  sessionListPageSchema,
  sessionMessageRequestSchema,
  sessionPageQuerySchema,
  sessionReportResponseSchema,
  sessionStoppedSchema,
} from "@nightwarden/shared/schemas";
import { gatedCalls, resolveEvidence, toolCallsIn } from "../agent/report.js";
import { hasPendingHumanInput } from "./gate-store.js";
import { getRecord } from "./record-store.js";
import { isReopenable } from "./reopen.js";
import {
  createSession,
  deleteSession,
  getSession,
  sessionExists,
} from "./store.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { listSessionPage } from "./list.js";
import { buildTranscript } from "./transcript.js";
import { signedInUser } from "../auth/authorize.js";
import { actorOf } from "../auth/session.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";
import { teardown } from "../sandbox/workspace.js";
import { HumanInputError, respondToPendingHumanInput } from "./human-input.js";
import type { Dispatcher } from "../dispatcher.js";
import { deriveStatus, isRunning } from "./status-store.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../config/readiness.js";

const params = z.object({ id: z.string() });

const accepted = { response: { 202: sessionAcceptedSchema, ...refusals() } };

export async function registerSessionRoutes(
  fastify: FastifyInstance,
  { dispatcher }: { dispatcher: Dispatcher },
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Paginated rather than capped, and one kind at a time: the list is served by
  // one index, and a cap makes the hundredth session the last one reachable.
  app.get(
    "/sessions",
    {
      config: { permission: { session: ["read"] } },
      schema: {
        querystring: sessionPageQuerySchema,
        response: { 200: sessionListPageSchema, ...refusals() },
      },
    },
    async (request) => {
      const { limit, offset, kind, status, q } = request.query;
      return listSessionPage(limit, offset, kind, {
        ...(status !== undefined && { status }),
        ...(q !== undefined && { q }),
      });
    },
  );

  // The session answers what it is. A bare transcript returned `200 []` for an
  // unknown id, which the frontend drew as a real but empty session.
  app.get(
    "/sessions/:id",
    {
      config: { permission: { session: ["read"] } },
      schema: {
        params,
        response: { 200: sessionDetailSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      const response: SessionDetail = {
        sessionId: session.sessionId,
        title: session.title,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        investigation: session.investigation,
        running: isRunning(request.params.id),
        reopenable: session.investigation && isReopenable(request.params.id),
        alerts: session.alerts,
        transcript: buildTranscript(request.params.id),
      };
      return response;
    },
  );

  app.get(
    "/sessions/:id/report",
    {
      config: { permission: { session: ["read"] } },
      schema: {
        params,
        response: { 200: sessionReportResponseSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      const record = getRecord(request.params.id);
      if (record === undefined) {
        return reply.code(404).send({ error: "no report for session" });
      }
      // Everything beside `record` is joined rather than stored, so what the
      // model wrote cannot disagree with what ran. One walk serves both joins.
      const calls = toolCallsIn(request.params.id);
      const response: SessionReportResponse = {
        record,
        decisions: gatedCalls(calls),
        evidence: resolveEvidence(calls, record),
      };
      return response;
    },
  );

  app.delete(
    "/sessions/:id",
    {
      config: { permission: { session: ["delete"] } },
      schema: { params, response: { 204: z.undefined(), ...refusals() } },
    },
    async (request, reply) => {
      const sessionId = request.params.id;
      if (isRunning(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is running: stop it before deleting" });
      }
      // Awaited, because a truthful 204 beats a fast one. Left behind, the idle
      // sweep would push work for a session the user asked to remove.
      await teardown(sessionId, "deleted");
      deleteSession(sessionId);
      return reply.code(204).send();
    },
  );

  app.post(
    "/sessions/:id/stop",
    {
      config: { permission: { session: ["run"] } },
      schema: {
        params,
        response: { 200: sessionStoppedSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      const stopped = dispatcher.stop(request.params.id);
      if (!stopped) {
        return reply.code(409).send({ error: "session is not running" });
      }
      return reply.code(200).send({ stopped: true });
    },
  );

  app.post(
    "/sessions/:id/respond",
    {
      config: { permission: { session: ["approve"] } },
      schema: {
        params,
        // Either half may stand alone, so a missing body is an empty answer.
        body: respondRequestSchema.prefault({}),
        response: { 200: approvalResponseSchema, ...refusals() },
      },
    },
    async (request, reply) => {
      // A decision resumes a run, so it needs a model as a chat does.
      const readiness = await checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      try {
        const response = respondToPendingHumanInput(
          dispatcher,
          request.params.id,
          request.body,
          actorOf(signedInUser(request)),
        );
        return reply.code(200).send(response);
      } catch (error) {
        if (!(error instanceof HumanInputError)) throw error;
        return await reply
          .code(error.statusCode)
          .send({ error: error.message });
      }
    },
  );

  // The schema admits only kind "chat": an investigation is a session with a
  // falsifiable condition attached, and only an alert carries one.
  app.post(
    "/chat",
    {
      config: { permission: { session: ["run"] } },
      schema: { body: chatRequestSchema, ...accepted },
    },
    async (request, reply) => {
      const { message, clientMessageId } = request.body;
      const readiness = await checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      const sessionId = randomUUID();
      // The row exists before its id is handed out, so a 202 never names a
      // session the next request cannot fetch. The run's own call is idempotent.
      createSession(buildSessionMeta(sessionId, null, message), false);
      dispatcher.dispatch({
        sessionId,
        userMessage: message,
        clientMessageId,
        investigation: false,
      });
      logger.info({ sessionId }, "session started");
      return reply.code(202).send({ sessionId });
    },
  );

  app.post(
    "/sessions/:id/messages",
    {
      config: { permission: { session: ["run"] } },
      schema: {
        params,
        body: sessionMessageRequestSchema,
        ...accepted,
      },
    },
    async (request, reply) => {
      const sessionId = request.params.id;
      const { message, clientMessageId } = request.body;
      if (!sessionExists(sessionId)) {
        return reply.code(404).send({ error: "unknown session" });
      }
      // Parked on a human rather than racing: the answer comes from the respond
      // route, so this is refused before anything tries to claim the session.
      if (hasPendingHumanInput(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is busy: awaiting approval" });
      }
      const seed = buildSeed(sessionId);
      // The claim inside dispatch decides it, not a check up here: the loser is
      // told rather than colliding on the transcript's primary key.
      if (
        !dispatcher.dispatch({
          sessionId,
          seed,
          userMessage: message,
          clientMessageId,
        })
      ) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );

  // A person starting what the hourly limit held, on the alerts its session holds.
  app.post(
    "/sessions/:id/start",
    {
      config: { permission: { session: ["run"] } },
      schema: { params, ...accepted },
    },
    async (request, reply) => {
      const sessionId = request.params.id;
      if (!sessionExists(sessionId)) {
        return reply.code(404).send({ error: "unknown session" });
      }
      if (deriveStatus(sessionId) !== "not_started") {
        return reply
          .code(409)
          .send({ error: "the investigation has already started" });
      }
      const readiness = await checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      if (!dispatcher.dispatch({ sessionId })) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId }, "held investigation started by a person");
      return reply.code(202).send({ sessionId });
    },
  );

  // The person's call alone, since reopening judges the write-up rather than the
  // world: the investigation returns to testing with its record intact.
  app.post(
    "/sessions/:id/reopen",
    {
      config: { permission: { session: ["run"] } },
      schema: {
        params,
        body: reopenRequestSchema,
        ...accepted,
      },
    },
    async (request, reply) => {
      const sessionId = request.params.id;
      const { reason, clientMessageId } = request.body;
      const session = getSession(sessionId);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      if (!session.investigation) {
        return reply
          .code(400)
          .send({ error: "a chat has no investigation to reopen" });
      }
      if (!isReopenable(sessionId)) {
        return reply
          .code(409)
          .send({ error: "the investigation is not closed, or is busy" });
      }
      const seed = buildSeed(sessionId);
      if (
        !dispatcher.dispatch({
          sessionId,
          seed,
          userMessage: reason,
          clientMessageId,
          reopen: true,
        })
      ) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId }, "investigation reopened");
      return reply.code(202).send({ sessionId });
    },
  );
}
