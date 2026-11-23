import { encode } from "uqr";

// The width scanners need around the symbol, in modules.
const QUIET_ZONE_MODULES = 4;

// Dark modules on a light ground in both themes, since a scanner reads an inverted code as noise.
export function QrCode({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.JSX.Element {
  const { data, size } = encode(value, { ecc: "M", border: 0 });
  const span = size + 2 * QUIET_ZONE_MODULES;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      className="size-56 shrink-0 rounded-control"
    >
      <rect width={span} height={span} className="fill-qr-light-module" />
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect
              key={`${x}-${y}`}
              x={x + QUIET_ZONE_MODULES}
              y={y + QUIET_ZONE_MODULES}
              width={1}
              height={1}
              className="fill-qr-dark-module"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
