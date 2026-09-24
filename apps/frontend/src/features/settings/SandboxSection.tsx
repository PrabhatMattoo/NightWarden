import { useState } from "react";
import { X } from "lucide-react";
import { SANDBOX_HOST_PATTERN, type AgentConfig } from "@nightwarden/shared";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";
import {
  formatCores,
  formatDuration,
  formatMemory,
  PresetRow,
} from "./PresetRow";

// Both the closed trigger and the open list read from here, so the word an
// user sees before opening is the same word they pick.
const NETWORK_LABEL: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist: "Allowlist (recommended)",
  open: "Open (unrestricted)",
  none: "None (no network)",
};

const NETWORK_HINT: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist: "Reaches only the hosts listed below, through a proxy.",
  none: "No network at all, so dependencies can never install.",
  open: "Full internet access; a prompt-injected agent could exfiltrate code.",
};

interface SandboxSectionProps {
  config: AgentConfig;
  save: (patch: Partial<AgentConfig>) => void;
}

export function SandboxSection({
  config,
  save,
}: SandboxSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Container">
        <PresetRow
          id="settings-sandbox-idle"
          setting="sandboxIdleTimeoutMs"
          title="Remove idle sandboxes after"
          description="A sandbox nobody has used for this long is torn down."
          value={config.sandboxIdleTimeoutMs}
          format={formatDuration}
          onCommit={(ms) => save({ sandboxIdleTimeoutMs: ms })}
        />
        <PresetRow
          id="settings-sandbox-cpus"
          setting="sandboxCpus"
          title="Sandbox CPU"
          description="Cores each sandbox may use."
          value={config.sandboxCpus}
          format={formatCores}
          onCommit={(n) => save({ sandboxCpus: n })}
        />
        <PresetRow
          id="settings-sandbox-memory"
          setting="sandboxMemoryMb"
          title="Sandbox memory"
          description="Memory each sandbox may use."
          value={config.sandboxMemoryMb}
          format={formatMemory}
          onCommit={(n) => save({ sandboxMemoryMb: n })}
        />
        <SettingsRow
          id="settings-sandbox-gvisor"
          title="Require kernel isolation (gVisor)"
          description="Whether a sandbox may start without kernel-level isolation."
        >
          <Switch
            aria-labelledby={rowLabel("settings-sandbox-gvisor")}
            checked={config.sandboxRequireGvisor === true}
            onCheckedChange={(checked) =>
              save({ sandboxRequireGvisor: checked })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Network">
        <SettingsRow
          id="settings-sandbox-network"
          title="Sandbox network access"
          description={`What the sandbox may reach. ${NETWORK_HINT[config.sandboxNetwork]}`}
          // The hosts below belong to this choice, so no line divides them.
          joined={config.sandboxNetwork === "allowlist"}
        >
          <Select
            items={NETWORK_LABEL}
            value={config.sandboxNetwork}
            onValueChange={(value) =>
              save({
                sandboxNetwork:
                  value === "open"
                    ? "open"
                    : value === "none"
                      ? "none"
                      : "allowlist",
              })
            }
          >
            <SelectTrigger
              aria-labelledby={rowLabel("settings-sandbox-network")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(NETWORK_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        {config.sandboxNetwork === "allowlist" && (
          <SettingsRow
            id="settings-sandbox-host"
            title="Hosts the sandbox can reach"
            description="The proxy passes these through and refuses everything else."
            stacked
          >
            <AllowedHosts
              hosts={config.sandboxAllowlistHosts}
              onChange={(hosts) => save({ sandboxAllowlistHosts: hosts })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </div>
  );
}

// The API refuses an empty list, so the last host has no remove button.
function AllowedHosts({
  hosts,
  onChange,
}: {
  hosts: string[];
  onChange: (hosts: string[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add(): void {
    const host = draft.trim().toLowerCase();
    if (host === "") return;
    if (!SANDBOX_HOST_PATTERN.test(host)) {
      setError("A hostname only, such as registry.npmjs.org");
      return;
    }
    if (hosts.includes(host)) {
      setError(`${host} is already listed`);
      return;
    }
    onChange([...hosts, host]);
    setDraft("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          aria-labelledby={rowLabel("settings-sandbox-host")}
          measure="beside"
          placeholder="registry.npmjs.org"
          value={draft}
          aria-invalid={error !== null || undefined}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={draft.trim() === ""}
          onClick={add}
        >
          Add
        </Button>
      </div>
      {error !== null && <FieldError>{error}</FieldError>}
      <ul aria-label="Allowed hosts" className="flex flex-wrap gap-2">
        {hosts.map((host) => (
          <li key={host}>
            <Badge>
              {host}
              {hosts.length > 1 && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${host}`}
                  onClick={() => onChange(hosts.filter((h) => h !== host))}
                >
                  <X />
                </Button>
              )}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
