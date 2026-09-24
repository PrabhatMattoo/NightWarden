import { createContext, useContext } from "react";

// The ground a component stands on, carried through portals so a popup knows where it was opened.
export type Ground = "stage" | "sidebar" | "card" | "overlay" | "overlay-stage";

const GroundContext = createContext<Ground>("stage");

export function GroundProvider({
  ground,
  children,
}: {
  ground: Ground;
  children: React.ReactNode;
}): React.JSX.Element {
  return <GroundContext value={ground}>{children}</GroundContext>;
}

/* A menu builds on whatever opened it: a card's menu sits on the card, and the
   page's or the sidebar's on the page. A menu opened from a menu keeps its own. */
export function useOverlayGround(): "overlay" | "overlay-stage" {
  const opener = useContext(GroundContext);
  return opener === "card" || opener === "overlay"
    ? "overlay"
    : "overlay-stage";
}
