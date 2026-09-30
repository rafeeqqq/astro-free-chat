// North-Indian kundli, drawn from the server-built chart (houses numbered from the lagna,
// planets in their real houses). Pure SVG: sharp on every screen, no image to download.

import s from "./chat.module.css";

export type KundliView = { basis: "lagna" | "moon"; houses: { sign: number; items: string[] }[] };

const SIZE = 240;

// Where each house's planets sit, and where its sign number goes (near the house's inner corner).
// House 1 is the top diamond; houses run anticlockwise, as in a printed North-Indian chart.
// "wide" triangles (top/bottom) have room for two labels per line; "tall" ones (left/right) stack one per line.
type Shape = "diamond" | "wide" | "tall";
const HOUSES: { at: [number, number]; num: [number, number]; shape: Shape }[] = [
  { at: [120, 58], num: [120, 106], shape: "diamond" }, // 1
  { at: [60, 20], num: [60, 47], shape: "wide" },       // 2
  { at: [25, 60], num: [47, 60], shape: "tall" },       // 3
  { at: [58, 120], num: [106, 120], shape: "diamond" }, // 4
  { at: [25, 180], num: [47, 180], shape: "tall" },     // 5
  { at: [60, 220], num: [60, 193], shape: "wide" },     // 6
  { at: [120, 182], num: [120, 134], shape: "diamond" }, // 7
  { at: [180, 220], num: [180, 193], shape: "wide" },   // 8
  { at: [215, 180], num: [193, 180], shape: "tall" },   // 9
  { at: [182, 120], num: [134, 120], shape: "diamond" }, // 10
  { at: [215, 60], num: [193, 60], shape: "tall" },     // 11
  { at: [180, 20], num: [180, 47], shape: "wide" },     // 12
];

function lines(items: string[], shape: Shape): string[] {
  const perLine = shape === "wide" && items.length > 2 ? 2 : 1;
  const out: string[] = [];
  for (let i = 0; i < items.length; i += perLine) out.push(items.slice(i, i + perLine).join("  "));
  return out;
}

export function KundliCard({
  title, subtitle, kundli, facts,
}: {
  title: string;
  subtitle: string;
  kundli: KundliView | null;
  facts: { label: string; value: string }[];
}) {
  return (
    <figure className={`${s.kundliCard} ${s.appear}`}>
      <figcaption className={s.kundliHead}>
        <span className={s.kundliTitle}>{title}</span>
        <span className={s.kundliSub}>{subtitle}</span>
      </figcaption>

      <svg className={s.kundliSvg} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={title}>
        <rect x="1" y="1" width={SIZE - 2} height={SIZE - 2} fill="#FFFBF6" stroke="#E7A56A" strokeWidth="1.4" />
        <g stroke="#E7A56A" strokeWidth="1.1" fill="none">
          <line x1="1" y1="1" x2={SIZE - 1} y2={SIZE - 1} />
          <line x1={SIZE - 1} y1="1" x2="1" y2={SIZE - 1} />
          <polygon points={`${SIZE / 2},1 ${SIZE - 1},${SIZE / 2} ${SIZE / 2},${SIZE - 1} 1,${SIZE / 2}`} />
        </g>

        {kundli?.houses.map((h, i) => {
          const pos = HOUSES[i];
          const rows = lines(h.items, pos.shape);
          const lh = pos.shape === "diamond" ? 11 : 9.5;
          const top = pos.at[1] - ((rows.length - 1) * lh) / 2;
          return (
            <g key={i}>
              <text x={pos.num[0]} y={pos.num[1] + 3} textAnchor="middle" className={s.kNum}>{h.sign}</text>
              {rows.map((r, j) => (
                <text
                  key={j}
                  x={pos.at[0]}
                  y={top + j * lh + 3}
                  textAnchor="middle"
                  className={r.startsWith("Asc") ? s.kAsc : pos.shape === "tall" ? s.kPlanetSm : s.kPlanet}
                >
                  {r}
                </text>
              ))}
            </g>
          );
        })}
      </svg>

      <div className={s.kundliFacts}>
        {facts.map((f) => (
          <div key={f.label} className={s.fact}><span>{f.label}</span><b>{f.value}</b></div>
        ))}
      </div>
    </figure>
  );
}
