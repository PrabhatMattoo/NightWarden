import type { AgentConfig } from "@nightwarden/shared";

import { SettingsGroup } from "./SettingsRow";
import { formatDuration, formatRetries, PresetRow } from "./PresetRow";

interface LimitsSectionProps {
  config: AgentConfig;
  save: (patch: Partial<AgentConfig>) => void;
}

// Grouped by what each bound applies to, outermost first.
export function LimitsSection({
  config,
  save,
}: LimitsSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Investigations">
        <PresetRow
          id="settings-max-per-hour"
          setting="maxInvestigationsPerHour"
          title="Automatic investigations per hour"
          description="Alerts beyond this open an investigation you start yourself."
          value={config.maxInvestigationsPerHour}
          format={String}
          onCommit={(n) => save({ maxInvestigationsPerHour: n })}
        />
        <PresetRow
          id="settings-check-in"
          setting="checkInAfterMs"
          title="Ask to continue after"
          description="The agent finishes its step, then asks whether to continue."
          value={config.checkInAfterMs}
          format={formatDuration}
          onCommit={(ms) => save({ checkInAfterMs: ms })}
        />
      </SettingsGroup>

      <SettingsGroup title="Model requests">
        <PresetRow
          id="settings-request-timeout"
          setting="requestTimeoutMs"
          title="Model response timeout"
          description="How long one request to the model may take."
          value={config.requestTimeoutMs}
          format={formatDuration}
          onCommit={(ms) => save({ requestTimeoutMs: ms })}
        />
        <PresetRow
          id="settings-max-retries"
          setting="maxRetries"
          title="Retry failed model requests"
          description="How many times a failed request is retried before the run fails."
          value={config.maxRetries}
          format={formatRetries}
          onCommit={(n) => save({ maxRetries: n })}
        />
      </SettingsGroup>

      <SettingsGroup title="Tool calls">
        <PresetRow
          id="settings-tool-ceiling"
          setting="toolCallCeilingMs"
          title="Longest tool call"
          description="No single tool call may run longer than this."
          value={config.toolCallCeilingMs}
          format={formatDuration}
          onCommit={(ms) => save({ toolCallCeilingMs: ms })}
        />
      </SettingsGroup>
    </div>
  );
}
