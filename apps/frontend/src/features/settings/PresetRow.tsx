import { SETTING_RANGES, type NumericSetting } from "@nightwarden/shared";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { rowLabel, SettingsRow } from "./SettingsRow";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

// Largest unit first, so 90 minutes reads "1 hour 30 minutes" and never "90 minutes".
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let left = ms;
  for (const [size, one, many] of [
    [HOUR, "hour", "hours"],
    [MINUTE, "minute", "minutes"],
    [SECOND, "second", "seconds"],
  ] as const) {
    const whole = Math.floor(left / size);
    if (whole > 0) parts.push(count(whole, one, many));
    left -= whole * size;
  }
  return parts.join(" ") || "0 seconds";
}

export const formatMemory = (mb: number): string =>
  mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;

export const formatCores = (n: number): string => count(n, "core", "cores");

export const formatRetries = (n: number): string =>
  n === 0 ? "Never" : count(n, "time", "times");

interface PresetRowProps {
  id: string;
  setting: NumericSetting;
  title: string;
  description: string;
  value: number;
  format: (value: number) => string;
  onCommit: (value: number) => void;
}

// A saved value outside the presets is offered too, so the control never shows a blank.
export function PresetRow({
  id,
  setting,
  title,
  description,
  value,
  format,
  onCommit,
}: PresetRowProps): React.JSX.Element {
  const presets: readonly number[] = SETTING_RANGES[setting].presets;
  const options = presets.includes(value)
    ? presets
    : [...presets, value].sort((a, b) => a - b);
  const items = Object.fromEntries(options.map((n) => [String(n), format(n)]));
  return (
    <SettingsRow id={id} title={title} description={description}>
      <Select
        items={items}
        value={String(value)}
        onValueChange={(next) => {
          const n = Number(next);
          if (Number.isFinite(n) && n !== value) onCommit(n);
        }}
      >
        <SelectTrigger aria-labelledby={rowLabel(id)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {format(n)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
