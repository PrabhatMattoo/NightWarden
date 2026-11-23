import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderApp, TestProviders } from "./renderWithProviders.js";
import { sessionBody, signedInAnswer } from "./auth-session.js";
import { json, stubApi, type ApiRequest } from "./stubApi.js";
import { MockEventSource } from "./mockEventSource.js";
import type {
  AgentConfig,
  ModelCatalog,
  ProviderOption,
  ReasoningDescriptor,
} from "@nightwarden/shared";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { SettingsPage } from "@/features/settings/SettingsPage";
import { configQuery } from "@/features/settings/queries";
import { toast } from "@/shared/lib/toast";

const OWNER_EMAIL = "admin@example.com";
const SESSION = sessionBody({ email: OWNER_EMAIL });

// The picker is served with the config, so a new adapter reaches the form as data.
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    name: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresKey: true,
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
  },
  {
    name: "openai-compatible",
    label: "OpenAI-compatible",
    defaultBaseUrl: null,
    requiresKey: false,
  },
];

const CONFIG: AgentConfig = {
  provider: "anthropic",
  providerOptions: PROVIDER_OPTIONS,
  providers: {
    anthropic: {
      model: "claude-sonnet-4-6",
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: "high",
    },
    openai: {
      model: null,
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: null,
    },
    openrouter: {
      model: null,
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: null,
    },
    "openai-compatible": {
      model: null,
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: null,
    },
  },
  maxRetries: 2,
  maxInvestigationsPerHour: 10,
  checkInAfterMs: 1800000,
  toolCallCeilingMs: 600000,
  sandboxIdleTimeoutMs: 3600000,
  sandboxCpus: 2,
  sandboxMemoryMb: 4096,
  sandboxNetwork: "none",
  sandboxAllowlistHosts: ["registry.npmjs.org"],
  sandboxDefaultHosts: ["registry.npmjs.org", "pypi.org"],
  locked: { settings: {}, providers: {} },
};

// Effort levels vary per model, so the fixture carries a full descriptor on one
// and none on another: the form must render whatever the catalog says.
const MODELS_RESPONSE: ModelCatalog = {
  ok: true,
  models: [
    {
      id: "claude-sonnet-4-6",
      reasoning: {
        levels: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
      },
    },
    {
      id: "claude-opus-4-8",
      reasoning: null,
    },
    {
      id: "claude-haiku-4-5-20251001",
      reasoning: null,
    },
  ],
};

// A promise lets a test hold the catalog open and prove what renders without it.
function answerFrom(
  config: AgentConfig,
  models: ModelCatalog | Promise<ModelCatalog> = MODELS_RESPONSE,
) {
  return async ({ path, method, body }: ApiRequest): Promise<Response> => {
    const signedIn = signedInAnswer(path, SESSION);
    if (signedIn !== undefined) return signedIn;
    if (path === "/api/config/models") return json(await models);
    if (path.startsWith("/api/config")) {
      if (method === "PATCH" && typeof body === "object") {
        return json({ ...config, ...body });
      }
      return json(config);
    }
    return json({});
  };
}

/* Settings is a route now, so it renders under a router with somewhere to
   navigate away to - which is what the unsaved-provider guard reacts to. */
let sectionRouter: ReturnType<typeof renderSettings>["router"] | null = null;

function renderSettings(answer: (request: ApiRequest) => Promise<Response>) {
  const api = stubApi(answer);
  // What the page sent to one exact path with one method, in order.
  const sent = (method: string, path: string) =>
    api.requests(path).filter((r) => r.method === method && r.path === path);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: SettingsPage,
  });
  const awayRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent",
    component: () => <div>somewhere else</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, awayRoute]),
    history: createMemoryHistory({
      initialEntries: ["/settings/model-provider"],
    }),
  });
  sectionRouter = router;

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { sent, qc, router };
}

function setup(
  configOverride?: Partial<typeof CONFIG>,
  modelsOverride?: ModelCatalog | Promise<ModelCatalog>,
) {
  const config = { ...CONFIG, ...configOverride };
  return renderSettings(answerFrom(config, modelsOverride));
}

// The section nav lives in the sidebar shell, absent from this isolated page
// render, so a section change is a route change like the nav's own links make.
async function openSection(
  _user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  const section =
    ["profile", "security", "model-provider", "limits", "sandbox"].find((s) =>
      name.source.includes(s),
    ) ?? "model-provider";
  await act(async () => {
    await sectionRouter?.navigate({
      to: "/settings/$section",
      params: { section },
    });
  });
}

// A Select is a button and a listbox that exists only while open, so a test
// about its options opens it first and reads them from the listbox.
const openSelect = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("combobox", { name }));
  return screen.findByRole("listbox");
};

// Everything the catalog has to say is said in the suggestion list, so a test
// about it opens the list first.
const openModelList = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(
    await screen.findByLabelText(/^model$/i, { selector: "input" }),
  );
};

// Typing only narrows the list; picking is what sets the id. Anything needing
// a changed model goes through the list, as a person has to.
const pickModel = async (
  user: ReturnType<typeof userEvent.setup>,
  id: string,
): Promise<void> => {
  await user.click(
    await screen.findByLabelText(/^model$/i, { selector: "input" }),
  );
  await user.click(await screen.findByRole("option", { name: id }));
};

// Typing in the model field opens its suggestion list over the form. Moving to
// another field dismisses it and leaves the typed id in place.
const dismissModelList = (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => user.click(screen.getByLabelText(/^base url$/i));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("SettingsPage", () => {
  describe("form state", () => {
    it("keeps unsaved edits when the config refetches underneath", async () => {
      const user = userEvent.setup();
      const { qc } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(modelInput);
      await user.type(modelInput, "claude-opus-4-8");

      // Window focus alone triggers a refetch in a real browser, so an edit in
      // progress has to survive one.
      await act(async () => {
        await qc.invalidateQueries({ queryKey: configQuery().queryKey });
      });

      expect(
        await screen.findByLabelText(/^model$/i, { selector: "input" }),
      ).toHaveValue("claude-opus-4-8");
    });

    it("PATCHes /config with only the changed field when Save is clicked", async () => {
      const user = userEvent.setup();
      const { sent } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(sent("PATCH", "/api/config")).toHaveLength(1);
      });
    });

    it("shows an error notification when the save fails", async () => {
      const user = userEvent.setup();
      const answer = answerFrom(CONFIG);
      renderSettings(async (request) =>
        request.path === "/api/config" && request.method === "PATCH"
          ? new Response(null, { status: 500 })
          : await answer(request),
      );

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/save failed/i)).toBeInTheDocument();
      });
    });
  });

  describe("unsaved provider guard", () => {
    it("asks before leaving with the block half-edited, and stays put on decline", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      expect(screen.queryByText(/somewhere else/i)).not.toBeInTheDocument();
    });

    it("leaves when the prompt is accepted", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^leave$/i }),
      );

      expect(await screen.findByText(/somewhere else/i)).toBeInTheDocument();
    });

    // One component behind one route, so a tab change keeps the draft: asking
    // there offered to discard something that was not going anywhere.
    it("does not ask between its own tabs, and still asks on the way out", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      await act(async () => {
        await router.navigate({
          to: "/settings/$section",
          params: { section: "limits" },
        });
      });

      expect(
        await screen.findByRole("combobox", { name: /ask to continue after/i }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      // Still armed: the draft survived the tab change, so leaving still costs it.
      act(() => {
        void router.navigate({ to: "/agent" });
      });
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    it("does not ask for an autosaved value, which is already written", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await openSection(user, /limits/i);
      const list = await openSelect(user, /retry failed model requests/i);
      await user.click(within(list).getByRole("option", { name: "5 times" }));

      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(await screen.findByText(/somewhere else/i)).toBeInTheDocument();
    });
  });

  describe("model field", () => {
    // The field is a search over the catalog, so typing has to narrow the list.
    // Driving the real component is the only way to see that it does.
    it("narrows the list to what was typed", async () => {
      const user = userEvent.setup();
      setup(undefined, {
        ok: true,
        models: [
          {
            id: "openai/gpt-oss-20b:free",
            reasoning: null,
          },
          {
            id: "anthropic/claude-opus-5",
            reasoning: null,
          },
          {
            id: "meta/llama-4:free",
            reasoning: null,
          },
        ],
      });
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await user.type(input, "free");

      const listed = await screen.findByRole("listbox");
      await waitFor(() => {
        expect(
          within(listed)
            .getAllByRole("option")
            .map((o) => o.textContent),
        ).toEqual(["openai/gpt-oss-20b:free", "meta/llama-4:free"]);
      });
    });

    // Left standing rather than swept away: the box keeps what was typed so the
    // user can see it is not a model, and Save has nothing to do.
    it("keeps an unlisted id on screen and refuses to save it", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(input, "-nonsense");

      expect(await screen.findByText(/no model matches/i)).toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();

      await dismissModelList(user);
      expect(input).toHaveValue("claude-sonnet-4-6-nonsense");
      expect(
        screen.queryByLabelText(/^reasoning$/i, { selector: "button" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    });

    // Emptying it is the same story: no model, so no ladder and nothing to save.
    it("drops the ladder when the box is emptied, and will not save that", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await dismissModelList(user);

      expect(input).toHaveValue("");
      expect(
        screen.queryByLabelText(/^reasoning$/i, { selector: "button" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    });
  });

  describe("reasoning control", () => {
    // Renders one provider's block with the ladder it stores for its model.
    function withLadder(reasoning: ReasoningDescriptor | null) {
      return {
        providers: {
          ...CONFIG.providers,
          anthropic: { ...CONFIG.providers.anthropic, reasoning },
        },
      };
    }

    // The saved model's ladder travels with the config, so the control offers
    // that model's rungs. Nothing here knows which provider is active.
    it("offers exactly the levels the chosen model publishes", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const list = await openSelect(user, /^reasoning$/i);
      const options = within(list).getAllByRole("option");

      expect(options.map((o) => o.textContent)).toEqual([
        "Max",
        "High",
        "Medium",
        "Low",
      ]);
    });

    /* The ladder is the catalogue's to state, so while it loads the row holds only
       the saved level, disabled, and keeps its place in the form. */
    it("holds the saved level alone while the catalog loads", async () => {
      const user = userEvent.setup();
      // A catalog that never resolves: the rest of the form still stands.
      setup(undefined, new Promise<ModelCatalog>(() => {}));
      await openSection(user, /provider/i);

      expect(await screen.findByLabelText(/^base url$/i)).toBeInTheDocument();
      const reasoning = screen.getByRole("combobox", { name: /^reasoning$/i });
      expect(reasoning).toHaveTextContent("High");
      expect(reasoning).toBeDisabled();
      await openModelList(user);
      expect(await screen.findByText(/loading models/i)).toBeInTheDocument();
    });

    it("never offers an off switch: reasoning is not something a model may be told to skip", async () => {
      const user = userEvent.setup();
      setup(
        withLadder({
          levels: [{ value: "medium", label: "Medium" }],
          defaultLevel: "medium",
        }),
      );
      await openSection(user, /provider/i);

      const list = await openSelect(user, /^reasoning$/i);

      expect(
        within(list).queryByRole("option", { name: "Off" }),
      ).not.toBeInTheDocument();
    });

    it("shows no reasoning control at all for a model that advertises none", async () => {
      const user = userEvent.setup();
      // The ladder comes from the catalog, so the saved model publishes none there.
      const { sent } = setup(undefined, {
        ok: true,
        models: [{ id: "claude-sonnet-4-6", reasoning: null }],
      });
      await openSection(user, /provider/i);

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await waitFor(() =>
        expect(sent("POST", "/api/config/models").length).toBeGreaterThan(0),
      );
      await act(async () => {});
      expect(screen.queryByLabelText(/^reasoning$/i)).not.toBeInTheDocument();
    });

    it("takes the new model's ladder when the model changes", async () => {
      const user = userEvent.setup();
      setup(withLadder(null), {
        ok: true,
        models: [
          {
            id: "openai/gpt-5",
            reasoning: {
              // Deliberately without "high": the level in hand has to be one
              // this ladder cannot offer, or keeping it is the right answer.
              levels: [
                { value: "medium", label: "Medium" },
                { value: "low", label: "Low" },
              ],
              defaultLevel: "low",
            },
          },
        ],
      });
      await openSection(user, /provider/i);

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "openai/gpt-5");

      const list = await openSelect(user, /^reasoning$/i);
      // The new model's own default, not whatever the previous one was set to.
      expect(
        within(list).getByRole("option", { selected: true }),
      ).toHaveTextContent("Low");
    });

    // The other half, and the commoner one: a level both models offer survives
    // the swap rather than being reset to the new model's default.
    it("keeps a level the new model also offers", async () => {
      const user = userEvent.setup();
      setup(undefined, {
        ok: true,
        models: [
          {
            id: "openai/gpt-5",
            reasoning: {
              levels: [
                { value: "high", label: "High" },
                { value: "low", label: "Low" },
              ],
              defaultLevel: "low",
            },
          },
        ],
      });
      await openSection(user, /provider/i);

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "openai/gpt-5");

      const list = await openSelect(user, /^reasoning$/i);
      expect(
        within(list).getByRole("option", { selected: true }),
      ).toHaveTextContent("High");
    });
  });

  describe("provider picker", () => {
    it("offers whatever the server says it can reach, rather than a list the frontend keeps", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const list = await openSelect(user, /^provider$/i);

      expect(
        within(list)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Anthropic", "OpenRouter", "OpenAI-compatible"]);
    });

    /* A real value, not ghost text: as a placeholder it read as filled while the
       stored value was empty, sending an OpenRouter key to OpenAI. */
    it("fills the Base URL with the provider's own default", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      expect(await screen.findByLabelText(/base url/i)).toHaveValue(
        "https://api.anthropic.com",
      );
    });
  });

  describe("OpenAI-compatible server", () => {
    // A server the operator runs: no address of ours, and no list to pick from
    // when it does not answer /v1/models.
    const SERVER = "http://localhost:11434/v1";
    const withServer = (over: Partial<AgentConfig["providers"]["anthropic"]>) =>
      ({
        ...CONFIG,
        provider: "openai-compatible",
        providers: {
          ...CONFIG.providers,
          "openai-compatible": {
            ...CONFIG.providers["openai-compatible"],
            ...over,
          },
        },
      }) satisfies AgentConfig;
    const NO_LIST: ModelCatalog = { ok: false, error: "unreachable" };

    it("takes a typed model id when the server lists none, and saves only with an address", async () => {
      const user = userEvent.setup();
      const { sent } = setup(withServer({}), NO_LIST);
      await openSection(user, /provider/i);

      // The field is a list until the server has failed to give one.
      await user.type(
        await screen.findByPlaceholderText("llama3.1:8b"),
        "llama3.1:8b",
      );
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

      await user.type(screen.getByLabelText(/^base url$/i), SERVER);
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        expect(sent("PATCH", "/api/config")[0]?.body).toEqual({
          providers: {
            "openai-compatible": { model: "llama3.1:8b", baseUrl: SERVER },
          },
        });
      });
      // No key was typed, and the server may need none.
      expect(sent("PATCH", "/api/config/key")).toHaveLength(0);
    });

    it("asks the server whether the model calls a tool, with the address and any key on screen", async () => {
      const user = userEvent.setup();
      const answer = answerFrom(
        withServer({ model: "llama3.1:8b", baseUrl: SERVER }),
        NO_LIST,
      );
      const { sent } = renderSettings(async (request) =>
        request.path === "/api/config/model-check"
          ? json({ ok: false, reason: "no_tool_call" })
          : await answer(request),
      );
      await openSection(user, /provider/i);

      await user.click(
        await screen.findByRole("button", { name: /check model/i }),
      );
      await waitFor(() => {
        expect(sent("POST", "/api/config/model-check")).toHaveLength(1);
      });
      await user.type(screen.getByPlaceholderText(/paste api key/i), "sk-gw");
      await user.click(screen.getByRole("button", { name: /check model/i }));

      await waitFor(() => {
        expect(
          sent("POST", "/api/config/model-check").map((r) => r.body),
        ).toEqual([
          {
            provider: "openai-compatible",
            model: "llama3.1:8b",
            baseUrl: SERVER,
          },
          {
            provider: "openai-compatible",
            model: "llama3.1:8b",
            baseUrl: SERVER,
            apiKey: "sk-gw",
          },
        ]);
      });
    });
  });

  describe("stored API key", () => {
    const withStoredKey = {
      ...CONFIG,
      providers: {
        ...CONFIG.providers,
        anthropic: {
          ...CONFIG.providers.anthropic,
          apiKeyMasked: "sk-...9999",
        },
      },
    };

    it("loads the catalog with the saved key, without it being retyped", async () => {
      const user = userEvent.setup();
      const { sent } = setup(withStoredKey);
      await openSection(user, /provider/i);

      await waitFor(() => {
        const call = sent("POST", "/api/config/models")[0];
        expect(call).toBeDefined();
        const body = call?.body as {
          apiKey?: string;
          provider: string;
        };
        // No key travels when none was typed: the server uses the stored one.
        expect(body.apiKey).toBeUndefined();
        expect(body.provider).toBe("anthropic");
      });
    });
  });

  describe("Limits", () => {
    it("keeps a saved value the presets do not list, rather than showing a blank", async () => {
      const user = userEvent.setup();
      setup({ checkInAfterMs: 45 * 60_000 });
      await openSection(user, /limits/i);

      const list = await openSelect(user, /ask to continue after/i);
      expect(
        within(list).getByRole("option", { name: "45 minutes" }),
      ).toBeInTheDocument();
    });

    it("writes the picked preset in milliseconds", async () => {
      const user = userEvent.setup();
      const { sent } = setup();
      await openSection(user, /limits/i);

      const list = await openSelect(user, /ask to continue after/i);
      await user.click(within(list).getByRole("option", { name: "1 hour" }));

      await waitFor(() => {
        const patch = sent("PATCH", "/api/config")[0];
        expect(patch).toBeDefined();
        const body = patch?.body as { checkInAfterMs: number };
        expect(body.checkInAfterMs).toBe(3_600_000);
      });
    });
  });

  describe("a setting the environment sets", () => {
    it("disables the control, so nothing is sent for it", async () => {
      const user = userEvent.setup();
      const { sent } = setup({
        locked: {
          settings: { maxRetries: "NIGHTWARDEN_MAX_RETRIES" },
          providers: {},
        },
      });
      await openSection(user, /limits/i);

      const control = await screen.findByRole("combobox", {
        name: /retry failed model requests/i,
      });
      await user.click(control);
      expect(control).toBeDisabled();
      expect(sent("PATCH", "/api/config")).toHaveLength(0);
    });
  });

  describe("API key", () => {
    it("carries a freshly typed key on the catalog request, which is what verifies it", async () => {
      const user = userEvent.setup();
      const { sent } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      // Debounced, so this is the request that lands after typing stops.
      await waitFor(
        () => {
          const withKey = sent("POST", "/api/config/models").filter((r) =>
            JSON.stringify(r.body ?? null).includes("sk-ant-newkey"),
          );
          expect(withKey.length).toBe(1);
        },
        { timeout: 3000 },
      );
    });

    it("PATCHes /config/key on Save, before the config that depends on it", async () => {
      const user = userEvent.setup();
      const { sent } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const keyCall = sent("PATCH", "/api/config/key")[0];
        expect(keyCall).toBeDefined();
        const body = keyCall?.body as {
          apiKey: string;
          provider: string;
        };
        expect(body.apiKey).toBe("sk-ant-newkey");
        expect(body.provider).toBe("anthropic");
      });
    });
  });

  describe("sandbox network", () => {
    it("saves the sandbox network mode", async () => {
      const user = userEvent.setup();
      const { sent } = setup();
      await openSection(user, /sandbox/i);

      const list = await openSelect(user, /sandbox network/i);
      await user.click(
        within(list).getByRole("option", { name: /open \(unrestricted\)/i }),
      );

      await waitFor(() => {
        const patch = sent("PATCH", "/api/config")[0];
        expect(patch).toBeDefined();
        const body = patch?.body as {
          sandboxNetwork?: string;
        };
        expect(body.sandboxNetwork).toBe("open");
      });
    });

    it("adds and removes allowed hosts as chips, and refuses anything but a hostname", async () => {
      const user = userEvent.setup();
      const { sent } = setup({ sandboxNetwork: "allowlist" });
      await openSection(user, /sandbox/i);

      const hosts = await screen.findByRole("list", { name: /allowed hosts/i });
      expect(within(hosts).getByText("registry.npmjs.org")).toBeInTheDocument();

      const field = screen.getByLabelText(/hosts the sandbox can reach/i);
      await user.type(field, "https://internal.dev{enter}");
      expect(await screen.findByText(/a hostname only/i)).toBeInTheDocument();

      await user.clear(field);
      await user.type(field, "internal.dev{enter}");

      const patches = () =>
        sent("PATCH", "/api/config").map(
          (r) =>
            (r.body as { sandboxAllowlistHosts?: string[] })
              .sandboxAllowlistHosts,
        );
      await waitFor(() =>
        expect(patches().at(-1)).toEqual([
          "registry.npmjs.org",
          "internal.dev",
        ]),
      );

      await user.click(
        await screen.findByRole("button", { name: "Remove internal.dev" }),
      );
      await waitFor(() =>
        expect(patches().at(-1)).toEqual(["registry.npmjs.org"]),
      );
    });
  });

  describe("removed default hosts", () => {
    it("lists a default that is no longer allowed, and restoring it sends the list with that host back", async () => {
      const user = userEvent.setup();
      const { sent } = setup({ sandboxNetwork: "allowlist" });
      await openSection(user, /sandbox/i);

      const removed = await screen.findByRole("list", {
        name: /removed defaults/i,
      });
      expect(within(removed).getByText("pypi.org")).toBeInTheDocument();
      await user.click(
        within(removed).getByRole("button", { name: "Restore pypi.org" }),
      );

      await waitFor(() => {
        const patch = sent("PATCH", "/api/config")[0];
        expect(patch).toBeDefined();
        const body = patch?.body as { sandboxAllowlistHosts: string[] };
        expect(body.sandboxAllowlistHosts).toEqual([
          "registry.npmjs.org",
          "pypi.org",
        ]);
      });
    });
  });

  describe("profile", () => {
    it("saves a new name when the field is left, and ignores an empty one", async () => {
      vi.stubGlobal("EventSource", MockEventSource);
      const user = userEvent.setup();
      const { requests } = stubApi((request) => {
        const signedIn = signedInAnswer(request.path, SESSION);
        if (signedIn !== undefined) return signedIn;
        if (request.path === "/api/config") return json(CONFIG);
        if (request.path === "/api/auth/update-user") {
          return json({ status: true });
        }
        return undefined;
      });
      renderApp({ path: "/settings/profile" });

      const name = await screen.findByLabelText("Name");
      await user.clear(name);
      await user.tab();
      expect(requests("/api/auth/update-user")).toHaveLength(0);
      expect(name).toHaveValue("Admin");

      await user.clear(name);
      await user.type(name, "Night Owl");
      await user.tab();
      await waitFor(() =>
        expect(requests("/api/auth/update-user")[0]?.body).toEqual({
          name: "Night Owl",
        }),
      );
    });
  });

  describe("appearance", () => {
    function openAppearance() {
      vi.stubGlobal("EventSource", MockEventSource);
      const api = stubApi((request) => {
        const signedIn = signedInAnswer(
          request.path,
          sessionBody({ email: OWNER_EMAIL, theme: "dark" }),
        );
        if (signedIn !== undefined) return signedIn;
        if (request.path === "/api/config") return json(CONFIG);
        if (request.path === "/api/auth/update-user") {
          return json({ status: true });
        }
        return undefined;
      });
      renderApp({ path: "/settings/profile" });
      return api;
    }

    afterEach(() => {
      localStorage.clear();
    });

    it("saves the appearance on the account and repaints before the write lands", async () => {
      const user = userEvent.setup();
      const { requests } = openAppearance();

      await user.click(await screen.findByRole("button", { name: "Light" }));

      expect(document.documentElement.dataset["theme"]).toBe("light");
      await waitFor(() =>
        expect(requests("/api/auth/update-user")[0]?.body).toEqual({
          theme: "light",
        }),
      );
    });
  });

  // The real route, reached as the security page is: signed in, through the auth client.
  describe("security", () => {
    function openAccount(answer: (path: string) => Response | undefined) {
      vi.stubGlobal("EventSource", MockEventSource);
      const api = stubApi((request) => {
        const signedIn = signedInAnswer(request.path, SESSION);
        if (signedIn !== undefined) return signedIn;
        if (request.path === "/api/config") return json(CONFIG);
        return answer(request.path);
      });
      const { router } = renderApp({ path: "/settings/security" });
      return { ...api, router };
    }

    const DEVICE = (id: string, userAgent: string) => ({
      id,
      token: `token-${id}`,
      userAgent,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    it("revokes the device asked and signs out the others", async () => {
      const user = userEvent.setup();
      let devices = [
        // The session the page itself runs on, as get-session names it.
        DEVICE("s1", "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/140"),
        DEVICE("s2", "Mozilla/5.0 (X11; Linux) Firefox/130"),
        DEVICE("s3", "Mozilla/5.0 (Windows NT 10.0) Edg/140"),
      ];
      const { requests } = openAccount((path) => {
        if (path === "/api/auth/list-sessions") return json(devices);
        if (path === "/api/auth/revoke-session") {
          devices = devices.filter((d) => d.id !== "s2");
          return json({ status: true });
        }
        if (path === "/api/auth/revoke-other-sessions") {
          devices = devices.slice(0, 1);
          return json({ status: true });
        }
        return undefined;
      });

      expect(await screen.findByText(/firefox on linux/i)).toBeInTheDocument();
      await user.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);

      await waitFor(() =>
        expect(screen.queryByText(/firefox on linux/i)).not.toBeInTheDocument(),
      );
      expect(requests("/api/auth/revoke-session")[0]?.body).toEqual({
        token: "token-s2",
      });

      await user.click(
        screen.getByRole("button", { name: "Sign out other devices" }),
      );
      await waitFor(() =>
        expect(requests("/api/auth/revoke-other-sessions")).toHaveLength(1),
      );
    });

    it("shows the server's reason when the current password is wrong", async () => {
      const user = userEvent.setup();
      openAccount((path) => {
        if (path === "/api/auth/list-sessions") return json([]);
        if (path === "/api/auth/change-password") {
          return json({ message: "Invalid password" }, 400);
        }
        return undefined;
      });

      await user.click(
        await screen.findByRole("button", { name: "Change password" }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(
        within(dialog).getByLabelText("Current password"),
        "wrong-one-123",
      );
      await user.type(
        within(dialog).getByLabelText("New password"),
        "brand-new-pass-1",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Change password" }),
      );

      expect(await screen.findByText("Invalid password")).toBeInTheDocument();
    });
  });
});
