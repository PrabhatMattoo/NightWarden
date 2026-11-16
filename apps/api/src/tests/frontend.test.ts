import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerFrontendRoutes } from "../frontend.js";
import { createTempFolder } from "./temp-folder.js";

const compress = promisify(brotliCompress);

// The one inline script index.html carries: the theme painted before first load.
const THEME_SCRIPT = `document.documentElement.dataset.theme = "dark";`;

// What the frontend build lays down: hashed files under assets/, verbatim public
// files beside them, and a .br for anything worth compressing.
async function buildFixture(): Promise<string> {
  const root = createTempFolder();
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "logos"), { recursive: true });

  const script = `console.log("app");${" ".repeat(2000)}`;
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><script>${THEME_SCRIPT}</script><div id=root><script type="module" src="/assets/index-AbCdEfGh.js"></script>`,
  );
  await writeFile(join(root, "assets/index-AbCdEfGh.js"), script);
  await writeFile(
    join(root, "assets/index-AbCdEfGh.js.br"),
    await compress(script),
  );
  await writeFile(join(root, "logos/docker.svg"), "<svg />");
  return root;
}

describe("frontend static serving", () => {
  let server: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = await buildFixture();
    vi.stubEnv("NIGHTWARDEN_FRONTEND_DIST", root);
    server = Fastify();
    // Registered under a prefix in index.ts, so the guard has something to hit.
    await server.register(
      async (api) => {
        api.get("/sessions/:id", async () => ({ ok: true }));
      },
      { prefix: "/api" },
    );
    await registerFrontendRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllEnvs();
  });

  describe("caching", () => {
    it("lets a hashed asset be kept forever, because its name changes when it does", async () => {
      const res = await server.inject("/assets/index-AbCdEfGh.js");

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    it("keeps index.html revalidating, because it names the hashed assets", async () => {
      const res = await server.inject("/index.html");

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });
  });

  describe("SPA routing", () => {
    it("answers a deep link with the app rather than a 404", async () => {
      const res = await server.inject("/sessions/abc123");

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<div id=root>");
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("leaves an unknown API path as JSON, so a fetch never parses HTML", async () => {
      const res = await server.inject("/api/nope");

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
    });

    it("does not answer a non-GET with the app", async () => {
      const res = await server.inject({ method: "POST", url: "/sessions" });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("content security policy", () => {
    it("lets the app reach only this origin, and run only its own scripts", async () => {
      const res = await server.inject("/sessions/abc123");
      const policy = String(res.headers["content-security-policy"]);
      const hash = createHash("sha256").update(THEME_SCRIPT).digest("base64");

      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain(`script-src 'self' 'sha256-${hash}'`);
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it("sends the same policy with index.html asked for by name", async () => {
      const deepLink = await server.inject("/sessions/abc123");
      const direct = await server.inject("/index.html");

      expect(direct.headers["content-security-policy"]).toBe(
        deepLink.headers["content-security-policy"],
      );
    });
  });

  describe("a missing build", () => {
    afterEach(() => {
      vi.stubEnv("NIGHTWARDEN_FRONTEND_DIST", root);
      vi.stubEnv("NODE_ENV", "test");
    });

    // process.exit never returns, so a stub that does needs the cast.
    function stubExit() {
      return vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
    }

    it("serves the API alone in development, where Vite is serving the frontend", async () => {
      vi.stubEnv("NIGHTWARDEN_FRONTEND_DIST", join(root, "absent"));
      const exit = stubExit();
      const bare = Fastify();

      await registerFrontendRoutes(bare);
      await bare.ready();

      expect(exit).not.toHaveBeenCalled();
      expect((await bare.inject("/")).statusCode).toBe(404);
      exit.mockRestore();
      await bare.close();
    });

    it("refuses to boot in production, where the image always carries the frontend", async () => {
      vi.stubEnv("NIGHTWARDEN_FRONTEND_DIST", join(root, "absent"));
      vi.stubEnv("NODE_ENV", "production");
      const exit = stubExit();
      const bare = Fastify();

      await registerFrontendRoutes(bare);

      expect(exit).toHaveBeenCalledWith(1);
      exit.mockRestore();
      await bare.close();
    });
  });
});
