import { useEffect, useRef, useState } from "react";

// Compact elapsed time, dropping a zero tail: 45s, 1m 12s, 2h, 3d 4h.
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export interface RunSpan {
  live: boolean;
  startedAt?: string;
  endedAt?: string;
}

/* How long a run has been going: a live one ticks against the wall clock once a
   second, and a settled one is the span between the stamps its turns carry. */
export function useRunSeconds({ live, startedAt, endedAt }: RunSpan): number {
  // A live run has no server stamp yet, its items still being in flight, so the
  // clock starts when the group first appears.
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const start =
    startedAt === undefined ? mountedAt.current : Date.parse(startedAt);
  const end = !live && endedAt !== undefined ? Date.parse(endedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}
