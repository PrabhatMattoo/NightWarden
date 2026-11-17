import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ModelCheck } from "@nightwarden/shared";
import { checkLLMReadiness } from "../config/readiness.js";
import { updateConfig, updateProvider } from "../config/store.js";
import { catalogFor, fetchCatalog, forgetCatalog } from "../llm/catalog.js";
import { forgetCapabilities } from "../llm/model-capabilities.js";
import { fakeOpenAICompatible } from "./fake-openai-compatible.js";
import { harness, type Harness } from "./harness.js";
import { clearTestLLM, configureTestLLM } from "./temp-db.js";
import { requestHeaders, requestUrl } from "./wire-helper.js";

// A server run by the operator: no address of ours, and often no key.
describe("an OpenAI-compatible server", () => {
  let nw: Harness;
  // Flipped by one case to make the server vanish from the network.
  let serverDown = false;
  // The credential each request carried, which the fake's own record leaves out.
  const bearers: Array<string | null> = [];

  beforeAll(async () => {
    const fake = fakeOpenAICompatible();
    nw = await harness({
      provider: "openai-compatible",
      model: {
        ...fake,
        fetch: (input, init) => {
          bearers.push(new Headers(init?.headers).get("authorization"));
          return serverDown
            ? Promise.reject(new TypeError("fetch failed"))
            : fake.fetch(input, init);
        },
      },
    });
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    nw.model.script([]);
    await configureTestLLM("openai-compatible");
  });

  // A block the patch schema does not name is stripped without an error.
  it("keeps the block a person saves for it", async () => {
    const res = await nw.server.inject({
      method: "PATCH",
      url: "/api/config",
      headers: nw.headers,
      payload: {
        providers: {
          "openai-compatible": {
            model: "qwen3:8b",
            baseUrl: "http://gateway.internal/v1",
          },
        },
      },
    });

    expect(JSON.parse(res.body)).toMatchObject({
      providers: {
        "openai-compatible": {
          model: "qwen3:8b",
          baseUrl: "http://gateway.internal/v1",
        },
      },
    });
  });

  describe("readiness", () => {
    it("asks for a base URL, since the provider has none of its own", async () => {
      await clearTestLLM();
      await updateProvider("openai-compatible", { model: "llama3.1:8b" });
      await updateConfig({ provider: "openai-compatible" });

      expect(await checkLLMReadiness()).toEqual({
        ready: false,
        missing: ["base URL"],
      });
    });

    it("runs with no key, which a local server often does not take", async () => {
      await clearTestLLM();
      await updateProvider("openai-compatible", {
        model: "llama3.1:8b",
        baseUrl: "http://localhost:11434/v1",
      });
      await updateConfig({ provider: "openai-compatible" });

      expect(await checkLLMReadiness()).toMatchObject({
        ready: true,
        apiKey: "",
      });
    });
  });

  describe("listing models", () => {
    function stubList(): { urls: string[]; auth: Array<string | null> } {
      forgetCapabilities();
      forgetCatalog();
      const seen: { urls: string[]; auth: Array<string | null> } = {
        urls: [],
        auth: [],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);
          if (url.startsWith("https://models.dev")) {
            return Promise.resolve(new Response("{}", { status: 200 }));
          }
          seen.urls.push(url);
          seen.auth.push(requestHeaders(input, init).get("Authorization"));
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "llama3.1:8b" }] }), {
              status: 200,
            }),
          );
        }),
      );
      return seen;
    }

    it("sends a bearer only when a key is set, and joins a trailing slash cleanly", async () => {
      const seen = stubList();

      await fetchCatalog("openai-compatible", "http://localhost:11434/v1/", "");
      await fetchCatalog(
        "openai-compatible",
        "http://localhost:11434/v1",
        "sk-gateway",
      );

      expect(seen.urls).toEqual([
        "http://localhost:11434/v1/models?limit=1000",
        "http://localhost:11434/v1/models?limit=1000",
      ]);
      expect(seen.auth).toEqual([null, "Bearer sk-gateway"]);
    });

    it("asks for a URL instead of dialling nothing", async () => {
      const seen = stubList();

      expect(await fetchCatalog("openai-compatible", undefined, "")).toEqual({
        ok: false,
        error: "needs_url",
      });
      expect(seen.urls).toEqual([]);
    });

    // One provider name fronts whichever server its address names.
    it("remembers each address's own list, so a new address is not served the old one", async () => {
      forgetCapabilities();
      forgetCatalog();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request) => {
          const url = requestUrl(input);
          const id = url.includes("server-b") ? "qwen3:32b" : "llama3.1:8b";
          return Promise.resolve(
            new Response(
              url.startsWith("https://models.dev")
                ? "{}"
                : JSON.stringify({ data: [{ id }] }),
              { status: 200 },
            ),
          );
        }),
      );
      const ids = async (baseUrl: string) =>
        (await catalogFor("openai-compatible", baseUrl, "")).map((m) => m.id);

      expect(await ids("http://server-a:11434/v1")).toEqual(["llama3.1:8b"]);
      expect(await ids("http://server-b:8000/v1")).toEqual(["qwen3:32b"]);
    });
  });

  describe("checking a model calls a tool", () => {
    const ping = { toolCallId: "call-1", name: "Ping", input: {} };

    async function check(body: object): Promise<ModelCheck> {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/config/model-check",
        headers: nw.headers,
        payload: {
          provider: "openai-compatible",
          model: "llama3.1:8b",
          ...body,
        },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as ModelCheck;
    }

    it("passes a model that calls the tool", async () => {
      nw.model.script([{ toolUses: [ping], text: "" }]);

      expect(await check({})).toEqual({ ok: true });
      expect(nw.model.tools(nw.model.requests.length - 1)).toEqual(["Ping"]);
    });

    it("sends the key typed in the form, and otherwise the stored one", async () => {
      nw.model.script([{ toolUses: [ping], text: "" }]);
      bearers.length = 0;

      await check({});
      await check({ apiKey: "sk-typed" });

      expect(bearers).toEqual(["Bearer test-api-key", "Bearer sk-typed"]);
    });

    it("fails a model that answers in words", async () => {
      nw.model.script([{ toolUses: [], text: "I am ready." }]);

      expect(await check({})).toEqual({ ok: false, reason: "no_tool_call" });
    });

    it("says a rejected key is the key, and a refused request is the server's own word", async () => {
      nw.model.script([{ status: 401 }]);
      expect(await check({ apiKey: "sk-wrong" })).toEqual({
        ok: false,
        reason: "bad_key",
      });

      nw.model.script([{ status: 404 }]);
      expect(await check({ model: "no-such-model" })).toMatchObject({
        ok: false,
        reason: "refused",
        detail: "scripted refusal",
      });
    });

    it("says a server that never answered is unreachable", async () => {
      serverDown = true;
      try {
        expect(await check({})).toMatchObject({
          ok: false,
          reason: "unreachable",
        });
      } finally {
        serverDown = false;
      }
    });

    it("asks for the base URL when neither the form nor the install has one", async () => {
      await clearTestLLM();

      expect(await check({})).toEqual({ ok: false, reason: "needs_url" });
    });
  });
});
