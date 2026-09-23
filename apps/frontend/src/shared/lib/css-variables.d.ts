// A custom property is how a runtime value reaches a class, so style accepts one.
import "react";

declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}
