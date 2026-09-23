import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { vi } from "vitest";

// testTimeout does not reach waitFor, which keeps its own 1s default.
configure({ asyncUtilTimeout: 5_000 });

const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (elt) => computedStyle(elt);
window.HTMLElement.prototype.scrollIntoView = () => {};
// jsdom has no scrollTo; the router's scroll restoration calls it on navigate.
window.scrollTo = () => {};
// jsdom doesn't implement the Web Animations API; Base UI's ScrollArea
// viewport calls element.getAnimations() to detect transition completion.
if (!("getAnimations" in window.Element.prototype)) {
  Object.defineProperty(window.Element.prototype, "getAnimations", {
    value: () => [],
  });
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  // Width queries answer from the stubbed innerWidth, as a browser would.
  value: vi.fn().mockImplementation((query: string) => ({
    matches: (() => {
      const min = /width >= (\d+)px|min-width: (\d+)px/.exec(query);
      return min === null
        ? false
        : window.innerWidth >= Number(min[1] ?? min[2]);
    })(),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(document, "fonts", {
  value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
});

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;
