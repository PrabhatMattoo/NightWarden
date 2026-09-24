import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { THEME_PREFERENCES, type ThemePreference } from "@nightwarden/shared";

import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ICON_UI } from "@/shared/lib/iconProps";
import { useSetTheme } from "./useSetTheme";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

const THEME_OPTION: Record<
  ThemePreference,
  { label: string; icon: LucideIcon }
> = {
  system: { label: "System", icon: Monitor },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

// Kept on the account, so every browser a person signs in from agrees.
export function AppearanceGroup({
  theme,
}: {
  theme: ThemePreference;
}): React.JSX.Element {
  const setTheme = useSetTheme();
  return (
    <SettingsGroup title="Appearance">
      <SettingsRow id="settings-theme" title="Theme">
        <ToggleGroup
          aria-labelledby={rowLabel("settings-theme")}
          value={[theme]}
          onValueChange={(next) => {
            const [picked] = next;
            const preference = THEME_PREFERENCES.find((t) => t === picked);
            // Pressing the chosen one again empties the group; the choice stays.
            if (preference !== undefined) setTheme.mutate(preference);
          }}
        >
          {THEME_PREFERENCES.map((preference) => {
            const { label, icon: Icon } = THEME_OPTION[preference];
            return (
              <Tooltip key={preference}>
                <TooltipTrigger
                  render={
                    <ToggleGroupItem
                      size="icon"
                      value={preference}
                      aria-label={label}
                    />
                  }
                >
                  <Icon {...ICON_UI} />
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </SettingsRow>
    </SettingsGroup>
  );
}
