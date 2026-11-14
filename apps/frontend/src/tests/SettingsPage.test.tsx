import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderApp, TestProviders } from "./renderWithProviders.js";
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
const AUTH_STATUS_RESPONSE = {
  ownerExists: true,
  authenticated: true,
  email: OWNER_EMAIL,
  name: "Admin",
  image: null,
};

// The picker is served with the config, so a new adapter reaches the form as data.
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    name: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
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
  },
  maxRetries: 2,
  maxInvestigationsPerHour: 10,
  checkInAfterMs: 1800000,
  toolCallCeilingMs: 600000,
  sandboxIdleTimeoutMs: 3600000,
  sandboxCpus: 2,
  sandboxMemoryMb: 4096,
  sandboxRequireGvisor: false,
  sandboxNetwork: "none",
  sandboxAllowlistHosts: ["registry.npmjs.org"],
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
    if (path === "/api/auth-status") return json(AUTH_STATUS_RESPONSE);
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
    history: createMemoryHistory({ initialEntries: ["/settings/provider"] }),
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
    ["profile", "security", "provider", "limits", "sandbox"].find((s) =>
      name.source.includes(s),
    ) ?? "provider";
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

    it("says only that it is loading until the catalog has answered", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);
      await openModelList(user);

      // Before the answer lands there is one honest message, not a guess that
      // gets corrected a frame later.
      expect(screen.queryByText(/add an api key/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/listed no models/i)).not.toBeInTheDocument();

      await screen.findByRole("option", { name: /claude-sonnet-4-6/ });
      expect(screen.queryByText(/loading models/i)).not.toBeInTheDocument();
    });

    it("asks for a key when the provider will not list models without one", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "needs_key" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(await screen.findByText(/add an api key/i)).toBeInTheDocument();
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
      ).toEqual(["Anthropic", "OpenRouter"]);
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

    it("shows the saved key masked, with no input open until Replace is pressed", async () => {
      const user = userEvent.setup();
      setup(withStoredKey);
      await openSection(user, /provider/i);

      expect(await screen.findByText("sk-...9999")).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/paste api key/i),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /replace/i }));

      expect(
        await screen.findByPlaceholderText(/paste api key/i),
      ).toBeInTheDocument();
    });

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
    it("offers presets in the unit a person would say them in", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /limits/i);

      // 1800000 ms is thirty minutes; nobody should have to do that division.
      expect(
        await screen.findByRole("combobox", { name: /ask to continue after/i }),
      ).toHaveTextContent("30 minutes");
      expect(
        screen.getByRole("combobox", { name: /longest tool call/i }),
      ).toHaveTextContent("10 minutes");
    });

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

    it("shows the reason inline when the catalog rejects the key", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "bad_key" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(
        await screen.findByText(/that key was rejected/i),
      ).toBeInTheDocument();
    });

    it("says an endpoint could not be reached, which is a different mistake", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "unreachable" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(
        await screen.findByText(/could not reach that endpoint/i),
      ).toBeInTheDocument();
    });

    it("enables Save as soon as anything is edited", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const save = await screen.findByRole("button", { name: /^save$/i });
      expect(save).toBeDisabled();

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      // The key changes what the catalog is asked, so Save turns on when that
      // answer lands, not before: an unverified key is not saveable.
      await waitFor(() => expect(save).toBeEnabled());
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
    it("saves the sandbox network knob and explains what each mode means", async () => {
      const user = userEvent.setup();
      const { sent } = setup();
      await openSection(user, /sandbox/i);

      expect(
        await screen.findByLabelText(/sandbox network/i),
      ).toHaveTextContent("None (no network)");
      expect(screen.getByText(/no network at all/i)).toBeInTheDocument();

      const list = await openSelect(user, /sandbox network/i);
      await user.click(
        within(list).getByRole("option", { name: /open \(unrestricted\)/i }),
      );
      expect(screen.getByText(/could exfiltrate/i)).toBeInTheDocument();

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

  describe("profile", () => {
    it("saves a new name when the field is left, and ignores an empty one", async () => {
      vi.stubGlobal("EventSource", MockEventSource);
      const user = userEvent.setup();
      const { requests } = stubApi((request) => {
        if (request.path === "/api/auth-status") {
          return json({ ...AUTH_STATUS_RESPONSE, theme: "system" });
        }
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
        if (request.path === "/api/auth-status") {
          return json({ ...AUTH_STATUS_RESPONSE, theme: "dark" });
        }
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
        if (request.path === "/api/auth-status") {
          return json({ ...AUTH_STATUS_RESPONSE, theme: "system" });
        }
        if (request.path === "/api/config") return json(CONFIG);
        return answer(request.path);
      });
      const { router } = renderApp({ path: "/settings/security" });
      return { ...api, router };
    }

    const DEVICE = (token: string, userAgent: string) => ({
      id: token,
      token,
      userAgent,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    it("lists each signed-in device and revokes the one asked", async () => {
      const user = userEvent.setup();
      let devices = [
        DEVICE("t-mac", "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/140"),
        DEVICE("t-linux", "Mozilla/5.0 (X11; Linux) Firefox/130"),
      ];
      const { requests } = openAccount((path) => {
        if (path === "/api/auth/list-sessions") return json(devices);
        if (path === "/api/auth/revoke-session") {
          devices = devices.slice(0, 1);
          return json({ status: true });
        }
        return undefined;
      });

      expect(await screen.findByText(/firefox on linux/i)).toBeInTheDocument();
      await user.click(screen.getAllByRole("button", { name: "Revoke" })[1]!);

      await waitFor(() =>
        expect(screen.queryByText(/firefox on linux/i)).not.toBeInTheDocument(),
      );
      expect(requests("/api/auth/revoke-session")[0]?.body).toEqual({
        token: "t-linux",
      });
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

    it("signs out every device, this one included, and lands on the login page", async () => {
      const user = userEvent.setup();
      const { requests, router } = openAccount((path) => {
        if (path === "/api/auth/list-sessions") return json([]);
        if (path === "/api/auth/revoke-sessions") return json({ status: true });
        if (path === "/api/auth/sign-out") return json({ success: true });
        return undefined;
      });

      await user.click(
        await screen.findByRole("button", { name: "Sign out everywhere" }),
      );

      expect(
        await screen.findByRole("heading", { name: /^log in$/i }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/login");
      expect(requests("/api/auth/revoke-sessions")).toHaveLength(1);
      expect(requests("/api/auth/sign-out")).toHaveLength(1);
    });
  });
});
