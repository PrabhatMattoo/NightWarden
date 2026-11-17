import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ELICITATIONS } from "../agent/tools/elicitations.js";
import { optionalText, parseInput } from "../agent/tools/schema.js";
import { TOOL_REGISTRY } from "../agent/tools/toolset.js";
import { COMPOSE_REPORT_TOOL } from "../agent/tools/report.js";
import {
  anthropicToolSchema,
  openAIToolSchema,
  toolSchemaFor,
} from "../llm/tool-schema-dialects.js";
import type { ToolSchema } from "../llm/types.js";

/* Every schema the build can offer, however it was produced. A hand-written one
   and a generated one answer to the same rules here. */
const SCHEMAS: ToolSchema[] = [
  ...TOOL_REGISTRY.map((tool) => tool.schema),
  ...ELICITATIONS.map((elicitation) => elicitation.schema),
  COMPOSE_REPORT_TOOL.schema,
];

/* Each provider's published list. A keyword outside its own is one that
   provider answers 400 on, breaking every call that offers the tool. */
const DIALECTS = [
  {
    name: "Anthropic",
    reduce: (s: ToolSchema["input_schema"]): unknown => anthropicToolSchema(s),
    allowed: new Set([
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "description",
      "enum",
      "const",
      "anyOf",
      "$ref",
      "$defs",
      "default",
      "minItems",
      "format",
    ]),
  },
  {
    name: "OpenAI",
    reduce: (s: ToolSchema["input_schema"]): unknown => openAIToolSchema(s),
    allowed: new Set([
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "description",
      "enum",
      "const",
      "anyOf",
      "$ref",
      "$defs",
      "default",
    ]),
  },
];

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every nested schema, so a rule holds at depth rather than only at the root.
function walk(node: unknown, path: string, into: Array<[string, Node]>): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, into));
    return;
  }
  if (!isNode(node)) return;
  into.push([path, node]);
  for (const [key, value] of Object.entries(node)) {
    walk(value, path === "" ? key : `${path}.${key}`, into);
  }
}

function nodesOf(schema: unknown, name: string): Array<[string, Node]> {
  const into: Array<[string, Node]> = [];
  walk(schema, name, into);
  return into;
}

// Every declared property, with the path a failure names it by.
function propertiesOf(
  schema: ToolSchema,
  inputSchema: unknown = schema.input_schema,
): Array<[string, Node]> {
  const into: Array<[string, Node]> = [];
  for (const [path, node] of nodesOf(inputSchema, schema.name)) {
    const properties = node["properties"];
    if (!isNode(properties)) continue;
    for (const [name, property] of Object.entries(properties)) {
      if (isNode(property)) into.push([`${path}.${name}`, property]);
    }
  }
  return into;
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

// A limit is met either as a numeral or spelled out, because "at least one"
// reads better in a sentence than "at least 1".
function states(description: string, value: unknown): boolean {
  if (typeof value !== "number") return false;
  // A whole number only, so a bound of 1000 is not stated by "10000" or "1,000.5".
  if (new RegExp(`(?<![\\d.,])${value}(?![\\d.,]*\\d)`).test(description))
    return true;
  const word = WORDS[value];
  return (
    word !== undefined && new RegExp(`\\b${word}\\b`, "i").test(description)
  );
}

const BOUNDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
] as const;

// OpenAI widens an optional field's type into a union with null, still carrying it.
function carries(
  node: Node | undefined,
  keyword: string,
  value: unknown,
): boolean {
  if (node === undefined) return false;
  if (keyword === "type") return [node["type"]].flat().includes(value);
  return node[keyword] === value;
}

// Zod stamps the safe-integer range onto every .int(). Nobody authored it, and
// no description should have to recite it.
function isAuthored(value: unknown): boolean {
  return value !== Number.MAX_SAFE_INTEGER && value !== Number.MIN_SAFE_INTEGER;
}

describe("every tool schema is one a provider will accept", () => {
  it("offers at least one schema, so the sweeps below cannot pass vacuously", () => {
    expect(SCHEMAS.length).toBeGreaterThan(30);
  });

  describe.each(DIALECTS)("reduced for $name", ({ reduce, allowed }) => {
    it("carries no keyword outside this provider's list, at any depth", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          // A properties map's keys are field names, not keywords.
          if (
            path.endsWith(".properties") ||
            path === `${schema.name}.properties`
          ) {
            continue;
          }
          for (const keyword of Object.keys(node)) {
            expect(allowed.has(keyword), `${path} carries ${keyword}`).toBe(
              true,
            );
          }
        }
      }
    });

    // Rejected outright by OpenAI, and silently permissive on Anthropic.
    it("closes every object, not only the root", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          if (node["type"] !== "object") continue;
          expect(node["additionalProperties"], `${path} is open`).toBe(false);
        }
      }
    });

    // Strict needs the key present even when nothing is required.
    it("declares required on every object, empty where nothing is", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          if (node["type"] !== "object") continue;
          expect(Array.isArray(node["required"]), `${path} omits it`).toBe(
            true,
          );
        }
      }
    });
  });

  it("describes every property, so none reaches the model unnamed", () => {
    for (const schema of SCHEMAS) {
      for (const [path, property] of propertiesOf(schema)) {
        expect(
          typeof property["description"],
          `${path} carries no description`,
        ).toBe("string");
      }
    }
  });

  /* A bound every provider's copy still carries reaches the model as schema. Any
     other reaches it as prose alone, since which provider runs is unknown here. */
  it("states every bound some dialect strips, in the field carrying it", () => {
    for (const schema of SCHEMAS) {
      const reduced = DIALECTS.map(
        ({ reduce }) =>
          new Map(propertiesOf(schema, reduce(schema.input_schema))),
      );
      for (const [path, property] of propertiesOf(schema)) {
        const description = property["description"];
        if (typeof description !== "string") continue;
        const needsProse = (keyword: string, value: unknown): boolean =>
          !reduced.every((copy) => carries(copy.get(path), keyword, value));
        if (property["type"] === "integer" && needsProse("type", "integer")) {
          expect(
            /whole number|integer/i.test(description),
            `${path} is an integer and does not say so`,
          ).toBe(true);
        }
        for (const bound of BOUNDS) {
          const value = property[bound];
          if (value === undefined || !isAuthored(value)) continue;
          // `required` already says a field needs content.
          if (bound === "minLength" && value === 1) continue;
          if (!needsProse(bound, value)) continue;
          expect(
            states(description, value),
            `${path} bounds ${bound} at ${JSON.stringify(value)} without saying so`,
          ).toBe(true);
        }
      }
    }
  });

  // A generated schema takes its property order from the Zod object, so a
  // reorder there silently reorders what the model is asked for.
  it("asks RecordFinding for its reasoning before its verdict", () => {
    const record = SCHEMAS.find((s) => s.name === "RecordFinding");
    const order = Object.keys(record?.input_schema.properties ?? {});
    expect(order.indexOf("explanation")).toBeGreaterThan(-1);
    expect(order.indexOf("explanation")).toBeLessThan(order.indexOf("verdict"));
    expect(order.indexOf("evidenceIds")).toBeLessThan(order.indexOf("verdict"));
  });

  it("keeps a format Anthropic accepts and drops one outside its list", () => {
    const reduced = anthropicToolSchema({
      type: "object",
      properties: {
        at: { type: "string", format: "date-time" },
        colour: { type: "string", format: "color" },
      },
    });
    expect(reduced.properties["at"]).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(reduced.properties["colour"]).toEqual({ type: "string" });
  });

  it("declares every required name as a property of the same object", () => {
    for (const schema of SCHEMAS) {
      for (const [path, node] of nodesOf(schema.input_schema, schema.name)) {
        const required = node["required"];
        if (!Array.isArray(required)) continue;
        const properties = isNode(node["properties"]) ? node["properties"] : {};
        for (const name of required) {
          expect(
            Object.keys(properties),
            `${path} requires ${String(name)}`,
          ).toContain(name);
        }
      }
    }
  });
});

/* A widened dialect has no "optional": a field the model skips arrives as an
   explicit null, so every optional shape a tool declares must read that. */
describe("a skipped field reaches the handler as an omission", () => {
  const OPTIONAL_SHAPES = {
    text: optionalText,
    enum: z.enum(["change", "signal"]).optional(),
    integer: z.number().int().optional(),
    boolean: z.boolean().optional(),
    strings: z.array(z.string()).optional(),
  } as const;

  it("reads a null in every optional shape as absent", () => {
    const schema = z.object(OPTIONAL_SHAPES);
    const nulls = Object.fromEntries(
      Object.keys(OPTIONAL_SHAPES).map((name) => [name, null]),
    );

    const parsed = parseInput(schema, nulls);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && Object.keys(parsed.data)).toEqual([]);
  });

  it("reads one nested inside an array of objects", () => {
    const schema = z.object({
      timeline: z.array(
        z.object({ at: z.string(), lane: OPTIONAL_SHAPES.enum }),
      ),
    });
    const parsed = parseInput(schema, {
      timeline: [{ at: "2026-01-14T03:12:45Z", lane: null }],
    });
    expect(parsed.ok && parsed.data["timeline"]).toEqual([
      { at: "2026-01-14T03:12:45Z" },
    ]);
  });

  it("still refuses a null the schema requires a value for", () => {
    const parsed = parseInput(z.object({ field: z.string() }), { field: null });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.failure.isError).toBe(true);
  });
});

describe("which provider gets which dialect", () => {
  const LOOKUP: ToolSchema["input_schema"] = {
    type: "object",
    properties: {
      service: { type: "string", format: "hostname" },
      tail: { type: "integer", minimum: 1 },
    },
    required: ["service"],
  };

  it("keeps Anthropic's own list for Anthropic", () => {
    expect(toolSchemaFor("anthropic", LOOKUP)).toEqual({
      type: "object",
      properties: {
        service: { type: "string", format: "hostname" },
        tail: { type: "integer" },
      },
      required: ["service"],
      additionalProperties: false,
    });
  });

  // A gateway that enforces strict mode refuses anything wider, so no other provider is sent more.
  it.each(["openai", "openrouter", "openai-compatible"] as const)(
    "gives %s strict mode's subset, with the optional field required and nullable",
    (provider) => {
      expect(toolSchemaFor(provider, LOOKUP)).toEqual({
        type: "object",
        properties: {
          service: { type: "string" },
          tail: { type: ["integer", "null"] },
        },
        required: ["service", "tail"],
        additionalProperties: false,
      });
    },
  );
});
