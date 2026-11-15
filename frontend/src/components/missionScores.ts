/** Score helpers shared by the mission planner views. */
import type { ScoreMaps } from "../api/mission";
import { scoreRgb } from "../globe/scoreSurface";

export type Layer = keyof ScoreMaps;
export const LAYERS: { id: Layer; label: string }[] = [
  { id: "site", label: "Overall (base site)" }, { id: "power", label: "Power" }, { id: "heat", label: "Heat" }, { id: "comm", label: "Communication" },
];

export function scoreColor(score: number | null | undefined) {
  return score == null ? "#3a4554" : `rgb(${scoreRgb(score).join(",")})`;
}

/** Estimate for an unsampled spot: inverse-distance weighting of the four nearest samples. */
export function estimate(cells: { lat: number; lon: number }[], values: (number | null)[], lat: number, lon: number) {
  const rad = Math.PI / 180;
  const near = cells.map((c, i) => {
    const d = Math.acos(Math.min(1, Math.sin(lat * rad) * Math.sin(c.lat * rad) + Math.cos(lat * rad) * Math.cos(c.lat * rad) * Math.cos((lon - c.lon) * rad)));
    return { d, v: values[i] };
  }).filter(n => n.v != null).sort((a, b) => a.d - b.d).slice(0, 4);
  if (!near.length) return null;
  if (near[0].d < 1e-9) return near[0].v;
  const w = near.map(n => 1 / (n.d * n.d));
  return near.reduce((sum, n, i) => sum + w[i] * (n.v as number), 0) / w.reduce((a, b) => a + b, 0);
}

