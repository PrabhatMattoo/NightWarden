import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Injected by vitest.config.ts, the only place certain of this package's location.
const SRC = process.env["FRONTEND_SRC"] ?? "";

const css = readFileSync(join(SRC, "styles.css"), "utf8");

function sources(
  dir: string,
  into: [string, string][] = [],
): [string, string][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") sources(path, into);
    } else if (/\.tsx?$/.test(entry.name)) {
      into.push([path, readFileSync(path, "utf8")]);
    }
  }
  return into;
}

const SOURCES = sources(SRC);

/* Values a utility of this kind may name. Anything else invents a rung, which
   is the drift these bands exist to stop. */
function expectUtilityValues(
  pattern: RegExp,
  allowed: readonly string[],
  what: string,
): void {
  for (const [path, text] of SOURCES) {
    for (const match of text.matchAll(pattern)) {
      expect(allowed, `${what} \`${match[0]}\` in ${path}`).toContain(match[1]);
    }
  }
}

const declared = (prefix: string): string[] =>
  [...css.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+):`, "g"))].map(
    (m) => m[1] ?? "",
  );

/* The 4px scale plus the half-steps that carry density. Sizes are dimensions,
   not rhythm, so only gaps, padding and margins are held to it. */
const SPACING = [
  "0",
  "0.5",
  "1",
  "1.5",
  "2",
  "2.5",
  "3",
  "3.5",
  "4",
  "5",
  "6",
  "8",
  "10",
  "12",
  "16",
  "24",
  "40",
];

describe("the vocabulary", () => {
  // Cleared, so a Tailwind default that bypasses a role generates nothing.
  it("clears every namespace a role stands in for", () => {
    for (const ns of [
      "color",
      "text",
      "font-weight",
      "leading",
      "tracking",
      "radius",
      "shadow",
    ]) {
      expect(css).toContain(`--${ns}-*: initial;`);
    }
  });
});

describe("widths", () => {
  it("names a container token rather than a raw width", () => {
    const containers = declared("container");
    for (const [path, text] of SOURCES) {
      if (path.includes(join("shared", "ui"))) continue;
      for (const match of text.matchAll(/\bmax-w-([a-z0-9-/]+)/g)) {
        const value = match[1] ?? "";
        if (["full", "none", "fit", "min", "max", "screen"].includes(value)) {
          continue;
        }
        if (/^\d+\/\d+$/.test(value)) continue;
        expect(containers, `\`${match[0]}\` in ${path}`).toContain(value);
      }
    }
  });
});

describe("radius", () => {
  // Radius rises with depth, restating the shadow: a control, a card, what floats.
  it("rises from the control to the card to what floats", () => {
    const rem = (name: string): number =>
      Number(new RegExp(`--radius-${name}:\\s*([\\d.]+)rem`).exec(css)?.[1]);
    expect(declared("radius").sort()).toEqual(["card", "control", "overlay"]);
    expect(rem("card")).toBeGreaterThan(rem("control"));
    expect(rem("overlay")).toBeGreaterThan(rem("card"));
  });
});

describe("focus", () => {
  it("is one outline in the focus colour, laid over the control's own edge", () => {
    expect(css).toContain("outline: 1px solid var(--focus)");
    expect(css).toContain("outline-offset: -1px");
  });

  /* Nothing recolours an edge for focus. Only a primitive may drop the outline,
     since only a primitive draws what replaces it: a group's ring, a highlight. */
  it("leaves the edge to the one rule, bar the primitives that replace it", () => {
    for (const [path, text] of SOURCES) {
      expect(text, `border-focus in ${path}`).not.toContain("border-focus");
      if (path.includes(join("shared", "ui"))) continue;
      expect(text, `outline-none in ${path}`).not.toMatch(
        /(?<![-\w:])outline-none(?![-\w])/,
      );
    }
  });
});

// One ordered ladder: a backdrop sits one below what it dims.
describe("layers", () => {
  it("names every layer, and pairs a backdrop with what it dims", () => {
    const layer = (name: string): number =>
      Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]);
    expect(layer("dialog-backdrop")).toBe(layer("dialog") - 1);
    expect(layer("overlay")).toBeGreaterThan(layer("dialog"));
    expect(layer("tooltip")).toBeGreaterThan(layer("overlay"));
    expect(layer("skip-link")).toBeGreaterThan(layer("tooltip"));
    expect(layer("rail")).toBeLessThan(layer("dialog"));
  });

  it("spends only the named layers", () => {
    const layers = declared("z");
    for (const [path, text] of SOURCES) {
      for (const match of text.matchAll(/(?<![-\w])z-(?!index)([^\s"'`]+)/g)) {
        const named = /^\(--z-([a-z-]+)\)$/.exec(match[1] ?? "")?.[1];
        expect(named, `raw z-index \`${match[0]}\` in ${path}`).toBeDefined();
        expect(layers, `\`${match[0]}\` in ${path}`).toContain(named);
      }
    }
  });
});

describe("motion", () => {
  it("resolves every duration and easing to a token", () => {
    const durations = declared("duration").map((d) => `(--duration-${d})`);
    expectUtilityValues(
      /(?<![-\w])duration-([^\s"'`]+)/g,
      durations,
      "duration",
    );
    expectUtilityValues(
      /(?<![-\w])ease-([^\s"'`]+)/g,
      ["in", "out", "panel"],
      "easing",
    );
  });

  it("no-ops every animation under reduced motion, in one place", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*animation-duration: 1ms !important;[^}]*transition-duration: 1ms !important;/,
    );
    for (const [path, text] of SOURCES) {
      expect(text, `motion-reduce: in ${path}`).not.toContain("motion-reduce:");
    }
  });
});

describe("the live sweep", () => {
  /* A position outside 0-100% slides part of the label off an image that does
     not repeat, and text clipped to it goes invisible. */
  it("never travels off the label it paints", () => {
    const at = css.indexOf("@keyframes nw-live");
    expect(at).toBeGreaterThan(-1);
    const stops = [
      ...css.slice(at, at + 300).matchAll(/background-position-x:\s*(-?\d+)%/g),
    ].map((m) => Number(m[1]));
    expect(stops.length).toBeGreaterThan(1);
    for (const stop of stops) {
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(stop).toBeLessThanOrEqual(100);
    }
  });
});

describe("disclosure", () => {
  // One mark for every row that opens, and never hidden by opacity, which Safari snaps.
  it("draws the disclosure mark in one place, and never hides it with opacity", () => {
    const owners = SOURCES.filter(([path]) =>
      path.endsWith("DisclosureChevron.tsx"),
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.[1]).not.toMatch(/opacity-\d/);
    for (const [path, text] of SOURCES) {
      if (path.endsWith("DisclosureChevron.tsx")) continue;
      expect(text, `${path} turns its own mark`).not.toMatch(
        /aria-expanded[^"'`]*rotate-/,
      );
    }
  });
});

describe("spacing", () => {
  it("holds every gap, padding and margin to the scale", () => {
    expectUtilityValues(
      /(?<![-\w])-?(?:gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me)-(\d+(?:\.\d+)?)(?![\w.-])/g,
      SPACING,
      "spacing",
    );
  });
});
