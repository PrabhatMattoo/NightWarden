import { useEffect, useRef, useState } from "react";
import { max, min } from "d3-array";
import { scaleLinear, scaleTime } from "d3-scale";
import { line as d3Line } from "d3-shape";
import { formatBytes } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import type { Line, Point, Plot, PlotUnit } from "./plot.js";
import { clock } from "@/shared/lib/time";
import { compact } from "./format.js";

const DEFAULT_W = 720;
const H = 240;
const PAD_L = 56;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 30;

const SERIES_HUES = 6;
const strokeOf = (at: number): string =>
  `var(--series-${(at % SERIES_HUES) + 1})`;

function readingIn(unit: PlotUnit | null): (value: number) => string {
  return unit === "bytes" ? formatBytes : (value) => compact.format(value);
}

function useContainerWidth(defaultWidth = DEFAULT_W) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultWidth);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setWidth(Math.round(rect.width));

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWidth(Math.round(w));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [containerRef, width] as const;
}

function LineChart({
  lines,
  unit,
  alertAt,
}: {
  lines: Line[];
  unit: PlotUnit | null;
  alertAt: number | null;
}): React.JSX.Element {
  const [containerRef, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  const read = readingIn(unit);

  const allValues = lines.flatMap((line) => line.points.map((p) => p.value));
  const allTimes = lines.flatMap((line) => line.points.map((p) => p.at));

  const tMin = min(allTimes) ?? 0;
  const tMax = max(allTimes) ?? 1;
  const vMin = min(allValues) ?? 0;
  const vMax = max(allValues) ?? 1;

  const xScale = scaleTime()
    .domain([new Date(tMin), new Date(tMax === tMin ? tMin + 60_000 : tMax)])
    .range([PAD_L, Math.max(PAD_L + 1, width - PAD_R)]);

  const yScale = scaleLinear()
    .domain(vMin === vMax ? [vMin - 1, vMax + 1] : [vMin, vMax])
    .range([H - PAD_B, PAD_T])
    .nice();

  const pathGen = d3Line<Point>()
    .x((d) => xScale(new Date(d.at)))
    .y((d) => yScale(d.value));

  const yTicks = yScale.ticks(3);
  const tickCount = width < 420 ? 2 : width < 600 ? 3 : 5;
  const xTicks = xScale.ticks(tickCount);

  const atHover = lines.map((line) =>
    hover === null || line.points.length === 0
      ? null
      : line.points.reduce((best, p) =>
          Math.abs(p.at - hover) < Math.abs(best.at - hover) ? p : best,
        ),
  );

  const alertX = alertAt === null ? null : xScale(new Date(alertAt));
  const showAlert =
    alertX !== null && alertX >= PAD_L && alertX <= width - PAD_R;
  const flipAlert = alertX !== null && alertX > width - PAD_R - 65;

  return (
    <figure className="m-0">
      <div ref={containerRef} className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={lines.map((line) => line.label).join(", ")}
          className="w-full rounded-control border-hairline border-edge bg-ground"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const mouseX = Math.max(
              PAD_L,
              Math.min(width - PAD_R, e.clientX - box.left),
            );
            const date = xScale.invert(mouseX);
            setHover(date.getTime());
          }}
          onPointerLeave={() => setHover(null)}
        >
          {/* Y Axis Grid & Labels */}
          {yTicks.map((val) => (
            <g key={val}>
              <line
                x1={PAD_L}
                x2={width - PAD_R}
                y1={yScale(val)}
                y2={yScale(val)}
                className="stroke-edge-input"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 8}
                y={yScale(val) + 4}
                textAnchor="end"
                className="fill-ink-muted font-mono type-small"
              >
                {read(val)}
              </text>
            </g>
          ))}

          {/* X Axis Time Labels with right-edge flipping */}
          {xTicks.map((d) => {
            const xPos = xScale(d);
            const isNearRight = xPos > width - PAD_R - 35;
            const isNearLeft = xPos < PAD_L + 35;
            const anchor: "start" | "middle" | "end" = isNearRight
              ? "end"
              : isNearLeft
                ? "start"
                : "middle";
            return (
              <text
                key={d.getTime()}
                x={xPos}
                y={H - 10}
                textAnchor={anchor}
                className="fill-ink-muted font-mono type-small"
              >
                {clock(d.getTime())}
              </text>
            );
          })}

          {/* Alert Marker */}
          {showAlert && (
            <g>
              <line
                x1={alertX}
                x2={alertX}
                y1={PAD_T}
                y2={H - PAD_B}
                className="stroke-fail"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text
                x={flipAlert ? alertX - 5 : alertX + 5}
                y={PAD_T + 10}
                textAnchor={flipAlert ? "end" : "start"}
                className="fill-fail font-mono type-small"
              >
                alert {clock(alertAt!)}
              </text>
            </g>
          )}

          {/* Series Paths */}
          {lines.map((line, at) => {
            const pathData = pathGen(line.points);
            if (!pathData) return null;
            return (
              <path
                key={line.label}
                d={pathData}
                fill="none"
                stroke={strokeOf(at)}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* Hover Crosshair & Points */}
          {hover !== null && atHover[0] != null && (
            <g>
              <line
                x1={xScale(new Date(atHover[0].at))}
                x2={xScale(new Date(atHover[0].at))}
                y1={PAD_T}
                y2={H - PAD_B}
                className="stroke-edge-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {atHover.map((point, at) =>
                point === null ? null : (
                  <circle
                    key={at}
                    cx={xScale(new Date(point.at))}
                    cy={yScale(point.value)}
                    r={3.5}
                    fill={strokeOf(at)}
                    className="stroke-ground"
                    strokeWidth={2}
                  />
                ),
              )}
            </g>
          )}
        </svg>

        {/* Hover Tooltip */}
        {hover !== null && atHover[0] != null && (
          <div
            className={cn(
              "pointer-events-none absolute top-2 left-(--at) rounded-control border-hairline border-edge-strong bg-ground px-2 py-1 font-mono type-body whitespace-nowrap shadow-card",
              // Flipped past the middle, so it never runs off the chart's far edge.
              xScale(new Date(atHover[0].at)) > width / 2
                ? "-ml-2 -translate-x-full"
                : "ml-2",
            )}
            style={{
              "--at": `${(xScale(new Date(atHover[0].at)) / width) * 100}%`,
            }}
          >
            <p className="m-0 text-ink-muted">{clock(atHover[0].at)}</p>
            {atHover.map((point, at) =>
              point === null ? null : (
                <p key={at} className="m-0 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full bg-(--swatch)"
                    style={{ "--swatch": strokeOf(at) }}
                  />
                  {lines.length > 1 && (
                    <span className="text-ink-muted">{lines[at]!.label}</span>
                  )}
                  <span className="tabular-nums">{read(point.value)}</span>
                </p>
              ),
            )}
          </div>
        )}
      </div>

      {lines.length > 1 && (
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
          {lines.map((line, at) => (
            <li
              key={line.label}
              className="flex items-center gap-2 type-body text-ink-muted"
            >
              <span
                aria-hidden
                className="h-0.5 w-4 rounded-full bg-(--swatch)"
                style={{ "--swatch": strokeOf(at) }}
              />
              <span className="font-mono">{line.label}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function Bars({
  unit,
  bars,
}: {
  unit: PlotUnit | null;
  bars: { label: string; value: number }[];
}): React.JSX.Element {
  const read = readingIn(unit);
  const maxVal = Math.max(...bars.map((b) => b.value), 0) || 1;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {bars.map((bar, at) => (
        <li key={bar.label} className="flex items-center gap-3">
          <span className="w-48 shrink-0 truncate font-mono type-body text-ink-muted">
            {bar.label}
          </span>
          <span className="flex min-w-0 flex-1 items-center">
            <span
              aria-hidden
              className="h-2 w-(--share) rounded-full bg-(--swatch)"
              style={{
                "--share": `${Math.max((bar.value / maxVal) * 100, 1)}%`,
                "--swatch": strokeOf(at),
              }}
            />
          </span>
          <span className="w-24 shrink-0 text-right font-mono type-body tabular-nums">
            {read(bar.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Measurement({ plot }: { plot: Plot }): React.JSX.Element {
  if (plot.kind === "line") {
    return (
      <LineChart lines={plot.lines} unit={plot.unit} alertAt={plot.alertAt} />
    );
  }
  if (plot.kind === "bars") return <Bars unit={plot.unit} bars={plot.bars} />;
  return (
    <p className="m-0 font-mono type-display tabular-nums">
      {readingIn(plot.unit)(plot.value)}
    </p>
  );
}
