import { useState } from "react";
import { Pencil } from "lucide-react";
import {
  REASONING_LEVELS,
  type AgentConfig,
  type ModelCheck,
  type ModelCheckReason,
  type ModelOption,
  type ProviderOption,
  type ProviderSettings,
} from "@nightwarden/shared";

import { Button } from "@/shared/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/shared/ui/combobox";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { ICON_UI } from "@/shared/lib/iconProps";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

// "input-clear" is absent on purpose: that is Base UI wiping the box when the
// list closes on no match, and honouring it threw away what was typed.
const OPERATOR_EDIT = new Set([
  "input-change",
  "input-paste",
  "item-press",
  "clear-press",
]);

export type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; models: ModelOption[] }
  | { kind: "empty"; message: string };

const CHECK_FAILURES: Record<ModelCheckReason, string> = {
  unreachable: "Could not reach that server. Check the Base URL.",
  needs_url: "Enter the Base URL first.",
  bad_key: "That key was rejected. Check it and try again.",
  refused: "The server refused the request.",
  no_tool_call:
    "The model answered in words and did not call the tool, so it cannot run an investigation. Pick another model.",
};

function checkMessage(result: ModelCheck): string {
  if (result.ok)
    return "The model called the tool, so it can run an investigation.";
  const detail = "detail" in result && result.detail ? ` ${result.detail}` : "";
  return `${CHECK_FAILURES[result.reason]}${detail}`;
}

interface ModelCheckState {
  pending: boolean;
  // Absent until a check has run for the model on screen.
  result: ModelCheck | null;
}

interface ProviderSectionProps {
  form: AgentConfig;
  block: ProviderSettings | null;
  savedApiKeyMasked: string | null;
  catalog: CatalogState;
  providers: ProviderOption[];
  newApiKey: string;
  dirty: boolean;
  saving: boolean;
  unchosen: boolean;
  modelCheck: ModelCheckState;
  onCheckModel: () => void;
  onProviderChange: (provider: AgentConfig["provider"]) => void;
  onProviderField: <K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ) => void;
  onModelChange: (id: string | null) => void;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
}

// The one block that is not autosaved: a provider with no key and no model
// cannot run, so the five fields are one transaction.
export function ProviderSection({
  form,
  block,
  savedApiKeyMasked,
  catalog,
  providers,
  newApiKey,
  dirty,
  saving,
  unchosen,
  modelCheck,
  onCheckModel,
  onProviderChange,
  onProviderField,
  onModelChange,
  onApiKeyChange,
  onSave,
}: ProviderSectionProps): React.JSX.Element {
  const [replacingKey, setReplacingKey] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const keyInputOpen = savedApiKeyMasked === null || replacingKey;
  // Everything below the provider waits on it, and dims until it is chosen.
  const noProvider = block === null;
  const models = catalog.kind === "ready" ? catalog.models : [];
  // From the list the picker is drawn from, so the control always fits the
  // model actually selected.
  const reasoning =
    models.find((m) => m.id === block?.model)?.reasoning ?? null;
  const option = providers.find((p) => p.name === form.provider);
  // A provider with no address of its own is a server the operator runs: it may
  // run open, may not list its models, and may be small.
  const selfHosted = option?.defaultBaseUrl === null;
  const keyOptional = option?.requiresKey === false;
  // A list that did not come back leaves the id to be typed.
  const typedModel = selfHosted && catalog.kind === "empty";
  const providerItems: Record<string, string> = Object.fromEntries(
    providers.map((provider) => [provider.name, provider.label]),
  );
  /* While the catalog loads, the saved level stands alone and disabled, so the
     row keeps its place instead of vanishing and returning with the ladder. */
  const heldLevel =
    catalog.kind === "loading" && block?.model ? block.reasoningLevel : null;
  const levels =
    reasoning?.levels ??
    REASONING_LEVELS.filter((level) => level.value === heldLevel);
  const levelItems: Record<string, string> = Object.fromEntries(
    levels.map((l) => [l.value, l.label]),
  );

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup>
        <SettingsRow
          id="settings-provider"
          title="Provider"
          description="Which service answers a request."
        >
          <Select
            items={providerItems}
            value={form.provider}
            onValueChange={(value) =>
              onProviderChange(
                providers.find((p) => p.name === value)?.name ?? null,
              )
            }
          >
            <SelectTrigger aria-labelledby={rowLabel("settings-provider")}>
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(providerItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          id="settings-base-url"
          unavailable={noProvider}
          title="Base URL"
          description={
            selfHosted
              ? "Where the server answers, including the /v1 part."
              : "Where to reach that service."
          }
        >
          <Input
            aria-labelledby={rowLabel("settings-base-url")}
            measure="beside"
            disabled={noProvider}
            {...(selfHosted && { placeholder: "http://localhost:11434/v1" })}
            value={block?.baseUrl ?? option?.defaultBaseUrl ?? ""}
            onChange={(e) =>
              onProviderField("baseUrl", e.currentTarget.value || undefined)
            }
          />
        </SettingsRow>

        <SettingsRow
          id="settings-api-key"
          unavailable={noProvider}
          title="API key"
          description={
            keyOptional
              ? "Optional: leave it empty when the server needs none. Stored encrypted and never shown again."
              : "Stored encrypted and never shown again."
          }
        >
          {keyInputOpen ? (
            <Input
              aria-labelledby={rowLabel("settings-api-key")}
              type="password"
              measure="beside"
              disabled={noProvider}
              placeholder="Paste API key"
              value={newApiKey}
              onChange={(e) => onApiKeyChange(e.currentTarget.value)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono type-body text-ink-muted">
                {savedApiKeyMasked}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Replace API key"
                onClick={() => setReplacingKey(true)}
              >
                <Pencil {...ICON_UI} />
              </Button>
            </div>
          )}
        </SettingsRow>

        <SettingsRow
          id="settings-model"
          unavailable={noProvider}
          title="Model"
          description={
            typedModel
              ? "That server did not list its models, so type the id it expects."
              : "One of the models that endpoint lists."
          }
        >
          {typedModel ? (
            <Input
              aria-labelledby={rowLabel("settings-model")}
              measure="beside"
              placeholder="llama3.1:8b"
              value={block?.model ?? ""}
              onChange={(e) =>
                onModelChange(e.currentTarget.value.trim() || null)
              }
            />
          ) : (
            <Combobox
              items={models.map((m) => m.id)}
              value={block?.model ?? ""}
              inputValue={typed ?? block?.model ?? ""}
              /* What is in the box is the answer and it stays there: Base UI would
               otherwise put the saved id back the moment the list closed. */
              onInputValueChange={(text, details) => {
                if (!OPERATOR_EDIT.has(details.reason)) return;
                setTyped(text);
                onModelChange(models.some((m) => m.id === text) ? text : null);
              }}
              openOnInputClick
            >
              <ComboboxInput
                aria-labelledby={rowLabel("settings-model")}
                className="w-full sm:w-control"
                onKeyDownCapture={(e) => {
                  if (e.key !== "Enter") return;
                  if (
                    document.querySelector('[role="option"][data-highlighted]')
                  )
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                }}
                disabled={noProvider}
                placeholder={
                  noProvider ? "Choose a provider first" : "Search models"
                }
              />
              <ComboboxContent
                side="bottom"
                collisionAvoidance={{ side: "none" }}
              >
                <ComboboxEmpty>{emptyMessage(catalog)}</ComboboxEmpty>
                <ComboboxList>
                  {(id: string) => (
                    <ComboboxItem key={id} value={id}>
                      <span className="min-w-0 truncate font-mono">{id}</span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          )}
        </SettingsRow>

        {selfHosted && (
          <SettingsRow
            id="settings-model-check"
            unavailable={!block?.model}
            title="Tool calling"
            description={
              modelCheck.result === null
                ? "An investigation needs a model that calls tools. This sends it one request to find out."
                : checkMessage(modelCheck.result)
            }
          >
            <Button
              type="button"
              variant="outline"
              disabled={!block?.model || modelCheck.pending}
              onClick={onCheckModel}
            >
              {modelCheck.pending ? "Checking…" : "Check model"}
            </Button>
          </SettingsRow>
        )}

        {levels.length > 0 && (
          <SettingsRow
            id="settings-reasoning"
            title="Reasoning"
            description="How hard the model works on each request."
          >
            <Select
              items={levelItems}
              disabled={reasoning === null}
              value={block?.reasoningLevel ?? ""}
              onValueChange={(value) =>
                onProviderField("reasoningLevel", value || null)
              }
            >
              <SelectTrigger aria-labelledby={rowLabel("settings-reasoning")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(levelItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
      </SettingsGroup>

      {selfHosted && (
        <p className="type-body text-pretty text-ink-muted">
          Small local models produce weaker investigations than hosted ones.
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          unavailable={noProvider}
          disabled={!dirty || unchosen || saving}
          onClick={onSave}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function emptyMessage(catalog: CatalogState): string {
  if (catalog.kind === "loading") return "Loading models…";
  if (catalog.kind === "empty") return catalog.message;
  return "No model matches.";
}
