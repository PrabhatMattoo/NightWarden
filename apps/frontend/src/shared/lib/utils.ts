// The merge must know the theme's own names, or it drops a hairline as a colour.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const HAIRLINE = ["hairline"];

const twMerge = extendTailwindMerge<"type-role">({
  extend: {
    theme: {
      radius: ["control", "card", "overlay"],
      shadow: ["control", "control-hover", "lift", "card", "overlay", "modal"],
      container: [
        "narrow",
        "wide",
        "field",
        "control",
        "control-sm",
        "rail",
        "rail-max",
        "rail-step",
        "title",
        "login",
        "sidebar",
        "sidebar-icon",
        "sidebar-sheet",
      ],
      ease: ["panel"],
    },
    classGroups: {
      "border-w": [{ border: HAIRLINE }],
      "border-w-t": [{ "border-t": HAIRLINE }],
      "border-w-b": [{ "border-b": HAIRLINE }],
      "border-w-l": [{ "border-l": HAIRLINE }],
      "border-w-r": [{ "border-r": HAIRLINE }],
      "type-role": [
        {
          type: [
            "title",
            "display",
            "heading",
            "subtitle",
            "prose",
            "item",
            "body",
            "small",
            "label",
            "input",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
