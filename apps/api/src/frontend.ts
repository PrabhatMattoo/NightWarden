import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import FastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "./logger.js";

// Beside the API bundle in the image; NIGHTWARDEN_FRONTEND_DIST overrides.
function frontendDist(): string {
  const explicit = process.env["NIGHTWARDEN_FRONTEND_DIST"];
  if (explicit) return resolve(explicit);
  return join(dirname(fileURLToPath(import.meta.url)), "frontend");
}

// Vite content-hashes everything under assets/, so a stale one is unreachable
// rather than wrong. index.html carries the hashes and must never stick.
function setCacheHeaders(reply: FastifyReply, path: string): void {
  const cacheable = path.includes(`${sep}assets${sep}`);
  reply.header(
    "cache-control",
    cacheable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

/* The page reaches this origin and nothing else. A script runs from here or is
   one index.html itself carries, by its hash; sonner writes its own <style>. */
export function contentSecurityPolicy(indexHtml: string): string {
  const inline = [
    ...indexHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ].map(
    ([, body]) =>
      `'sha256-${createHash("sha256")
        .update(body ?? "")
        .digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inline].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Same origin as the API, so the frontend's relative /api calls need no CORS.
// In dev Vite serves it instead, so a missing build is normal.
export async function registerFrontendRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const root = frontendDist();
  if (!existsSync(join(root, "index.html"))) {
    // The build embeds the frontend, so in production its absence is a broken
    // image or a mount over dist - serving API-only 404s every browser instead.
    if (process.env["NODE_ENV"] === "production") {
      logger.error(
        { root },
        "no frontend build at this path - refusing to boot",
      );
      process.exit(1);
    }
    logger.info("no frontend build found, serving API only");
    return;
  }

  const policy = contentSecurityPolicy(
    readFileSync(join(root, "index.html"), "utf8"),
  );
  fastify.addHook("onSend", async (_request, reply) => {
    if (String(reply.getHeader("content-type")).startsWith("text/html")) {
      reply.header("content-security-policy", policy);
    }
  });

  await fastify.register(FastifyStatic, {
    root,
    wildcard: false,
    // The build writes .br beside each text asset, so the megabyte of JS ships
    // compressed without spending CPU on it per request.
    preCompressed: true,
    setHeaders: setCacheHeaders,
  });

  // SPA routes have no file behind them: a deep link or refresh needs index.html.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });

  logger.info({ root }, "serving frontend");
}
