import { useState } from "react";
import { useBlocker, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentConfig,
  CatalogError,
  ConfigPatch,
  LLMProviderName,
  ModelCatalog,
  ProviderSettings,
} from "@nightwarden/shared";

import { Page } from "@/shared/ui/Page";
import { toast } from "@/shared/lib/toast";
import { api, dataOrThrow } from "@/shared/api/client";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { LimitsSection } from "@/features/settings/LimitsSection";
import { ProfileSection } from "@/features/settings/ProfileSection";
import {
  ProviderSection,
  type CatalogState,
} from "@/features/settings/ProviderSection";
import { SandboxSection } from "@/features/settings/SandboxSection";
import { SecuritySection } from "@/features/settings/SecuritySection";
import { useConfig, useConfigAutosave } from "@/features/settings/useConfig";
import { configQuery } from "@/features/settings/queries";
import { useDebounced } from "@/shared/hooks/useDebounced";

const CATALOG_ERRORS: Record<CatalogError, string> = {
  needs_key: "Add an API key to load models.",
  needs_url: "Enter the Base URL to load models.",
  bad_key: "That key was rejected. Check it and try again.",
  unreachable: "Could not reach that endpoint. Check the Base URL.",
};

const CATALOG_DEBOUNCE_MS = 500;

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "provider", label: "Provider" },
  { id: "limits", label: "Limits" },
  { id: "sandbox", label: "Sandbox" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// The bare path is a redirect into a section, so both spellings are still here.
function staysInSettings(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

const EDITABLE_PROVIDER_FIELDS = [
  "model",
  "baseUrl",
  "reasoningLevel",
] as const satisfies readonly (keyof ProviderSettings)[];

type ProviderDelta = NonNullable<ConfigPatch["providers"]>;

function buildProviderDelta(
  form: AgentConfig,
  base: AgentConfig,
): ProviderDelta {
  const delta: ProviderDelta = {};
  for (const name of Object.keys(form.providers) as LLMProviderName[]) {
    const blockDelta: Record<string, unknown> = {};
    for (const key of EDITABLE_PROVIDER_FIELDS) {
      if (!Object.is(form.providers[name][key], base.providers[name][key])) {
        blockDelta[key] = form.providers[name][key];
      }
    }
    if (Object.keys(blockDelta).length > 0) delta[name] = blockDelta;
  }
  return delta;
}

export function SettingsPage(): React.JSX.Element {
  const { section } = useParams({ strict: false }) as { section?: string };
  const active: SectionId =
    SECTIONS.find((s) => s.id === section)?.id ?? "profile";

  const config = useConfig();
  const save = useConfigAutosave();
  const queryClient = useQueryClient();

  // A result is void once the model, address or key it was asked with changes.
  const checkModel = useMutation({
    mutationFn: (vars: {
      provider: LLMProviderName;
      model: string;
      baseUrl?: string;
      apiKey?: string;
    }) => dataOrThrow(api.POST("/api/config/model-check", { body: vars })),
    onError: (error) =>
      toast.show({
        title: "Check failed",
        message: error.message,
        variant: "error",
      }),
  });

  // The provider block is a draft, seeded once and held while it is edited: a
  // background refetch would otherwise replace what is being typed.
  const [form, setForm] = useState<AgentConfig>(() => config);
  const [newApiKey, setNewApiKey] = useState("");
  // Counts edits to the typed key, so the catalog is keyed without the key itself.
  const [keyRevision, setKeyRevision] = useState(0);
  function changeApiKey(value: string): void {
    setNewApiKey(value);
    setKeyRevision((n) => n + 1);
    checkModel.reset();
  }

  const availableProviders = config.providerOptions;

  const editedProvider = form.provider ?? null;
  const editedBaseUrl = editedProvider
    ? (form.providers[editedProvider].baseUrl ?? "")
    : "";
  const catalogInput = useDebounced(
    {
      provider: editedProvider,
      baseUrl: editedBaseUrl,
      apiKey: newApiKey,
      keyRevision,
    },
    CATALOG_DEBOUNCE_MS,
  );

  const { data: catalogData, isPending: catalogPending } =
    useQuery<ModelCatalog>({
      queryKey: [
        "models",
        catalogInput.provider,
        catalogInput.baseUrl,
        catalogInput.keyRevision,
      ],
      queryFn: () =>
        dataOrThrow(
          api.POST("/api/config/models", {
            body: {
              ...(catalogInput.provider && { provider: catalogInput.provider }),
              ...(catalogInput.baseUrl && { baseUrl: catalogInput.baseUrl }),
              ...(catalogInput.apiKey.trim() && {
                apiKey: catalogInput.apiKey.trim(),
              }),
            },
          }),
        ).catch<ModelCatalog>(() => ({ ok: false, error: "unreachable" })),
      staleTime: 30_000,
      enabled: catalogInput.provider !== null,
    });

  const saveConfig = useMutation({
    mutationFn: (providers: ProviderDelta) =>
      dataOrThrow(
        api.PATCH("/api/config", {
          body: {
            ...(form.provider !== config.provider && {
              provider: form.provider,
            }),
            providers,
          },
        }),
      ),
  });

  const saveApiKey = useMutation({
    mutationFn: (vars: { provider: LLMProviderName; apiKey: string }) =>
      dataOrThrow(api.PATCH("/api/config/key", { body: vars })),
  });

  const block = form.provider ? form.providers[form.provider] : null;
  const savedBlock = form.provider
    ? (config.providers[form.provider] ?? null)
    : null;

  const catalog: CatalogState = ((): CatalogState => {
    const settled = catalogInput.provider === form.provider;
    if (!settled || catalogPending || catalogData === undefined) {
      return { kind: "loading" };
    }
    if (!catalogData.ok) {
      return { kind: "empty", message: CATALOG_ERRORS[catalogData.error] };
    }
    if (catalogData.models.length === 0) {
      return { kind: "empty", message: "This endpoint listed no models." };
    }
    return { kind: "ready", models: catalogData.models };
  })();
  const availableModels = catalog.kind === "ready" ? catalog.models : [];

  function patchProvider(
    name: LLMProviderName,
    patch: Record<string, unknown>,
  ): void {
    checkModel.reset();
    setForm((prev) =>
      prev
        ? {
            ...prev,
            providers: {
              ...prev.providers,
              [name]: { ...prev.providers[name], ...patch },
            },
          }
        : prev,
    );
  }

  function setProviderField<K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ): void {
    if (!form.provider) return;
    patchProvider(form.provider, { [key]: value });
  }

  function setModel(id: string | null): void {
    if (!form.provider) return;
    // Ladders differ per model, so a level the new one does not offer becomes
    // its default.
    const reasoning =
      availableModels.find((m) => m.id === id)?.reasoning ?? null;
    const keeps = reasoning?.levels.some(
      (l) => l.value === block?.reasoningLevel,
    );
    const levelIsLocked =
      config.locked.providers[form.provider]?.reasoningLevel !== undefined;
    patchProvider(form.provider, {
      model: id,
      ...(!levelIsLocked && {
        reasoningLevel: reasoning
          ? keeps
            ? block?.reasoningLevel
            : reasoning.defaultLevel
          : null,
      }),
    });
  }

  const providerDelta =
    form && config ? buildProviderDelta(form, config) : ({} as ProviderDelta);
  const providerDirty =
    Object.keys(providerDelta).length > 0 ||
    newApiKey.trim() !== "" ||
    (form != null && config != null && form.provider !== config.provider);
  const option = availableProviders.find((p) => p.name === form.provider);
  // A model, and an address where the provider has none of its own.
  const unchosen =
    form.provider != null &&
    (!block?.model || (option?.defaultBaseUrl === null && !block.baseUrl));

  function handleCheckModel(): void {
    if (!form.provider || !block?.model) return;
    checkModel.mutate({
      provider: form.provider,
      model: block.model,
      ...(block.baseUrl && { baseUrl: block.baseUrl }),
      ...(newApiKey.trim() && { apiKey: newApiKey.trim() }),
    });
  }

  async function handleSaveProvider(): Promise<void> {
    if (!form.provider) return;
    const keyToSave = newApiKey.trim();
    try {
      // The key goes first and alone: saving the block looks the chosen model up
      // in the catalog, which needs that key already stored.
      if (keyToSave) {
        await saveApiKey.mutateAsync({
          provider: form.provider,
          apiKey: keyToSave,
        });
      }
      await saveConfig.mutateAsync(providerDelta);
      await queryClient.invalidateQueries({ queryKey: configQuery().queryKey });
      changeApiKey("");
      toast.show({
        title: "Settings saved",
        message: "Your changes have been saved.",
        variant: "success",
      });
    } catch (err) {
      toast.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    }
  }

  // Only the provider block can be lost, and only on the way out: the four
  // tabs are one component, so a tab change keeps the draft in memory.
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => !staysInSettings(next.pathname),
    disabled: !providerDirty,
    enableBeforeUnload: () => providerDirty,
    withResolver: true,
  });

  const activeLabel =
    SECTIONS.find((s) => s.id === active)?.label ?? "Settings";

  return (
    <Page title={activeLabel}>
      {active === "provider" && (
        <ProviderSection
          form={form}
          locked={config.locked}
          block={block}
          savedApiKeyMasked={savedBlock?.apiKeyMasked ?? null}
          catalog={catalog}
          providers={availableProviders}
          newApiKey={newApiKey}
          dirty={providerDirty}
          saving={saveConfig.isPending || saveApiKey.isPending}
          unchosen={unchosen}
          modelCheck={{
            pending: checkModel.isPending,
            result: checkModel.data ?? null,
          }}
          onCheckModel={handleCheckModel}
          onProviderChange={(provider) => {
            checkModel.reset();
            setForm((prev) => (prev ? { ...prev, provider } : prev));
          }}
          onProviderField={setProviderField}
          onModelChange={setModel}
          onApiKeyChange={changeApiKey}
          onSave={() => void handleSaveProvider()}
        />
      )}
      {active === "profile" && <ProfileSection />}
      {active === "security" && <SecuritySection />}
      {active === "limits" && <LimitsSection config={config} save={save} />}
      {active === "sandbox" && <SandboxSection config={config} save={save} />}

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving?"
        description="The provider, key and model you edited will be lost."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed();
        }}
      />
    </Page>
  );
}
