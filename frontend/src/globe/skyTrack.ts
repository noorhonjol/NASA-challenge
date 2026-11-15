/** Sun and Earth positions over time from one lunar spot, interpolated for a time slider. */
import type { BodyPosition, Positions } from "../api/client";

type Columns = { azimuth_deg: number[]; elevation_deg: number[]; distance_km: number[] };
export type SkyTrack = {
  latitude_deg: number; longitude_deg: number; elevation_m: number;
  start_utc: string; step_minutes: number; count: number;
  sun: Columns; earth: Columns; source: string; source_url: string;
};

export async function fetchSkyTrack(lat: number, lon: number, elevation: number, start: Date, signal?: AbortSignal): Promise<SkyTrack> {
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon), elevation_m: String(Math.round(elevation)),
    start: start.toISOString().replace(/\.\d{3}Z$/, "Z"), days: "30", step_minutes: "30" });
  const res = await fetch(`/api/positions/track?${query}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Sky track request failed (${res.status})`);
  }
  return res.json();
}

export const trackStart = (t: SkyTrack) => Date.parse(t.start_utc);
export const trackEnd = (t: SkyTrack) => trackStart(t) + (t.count - 1) * t.step_minutes * 60000;

function sample(c: Columns, i: number, f: number): BodyPosition {
  const j = Math.min(i + 1, c.azimuth_deg.length - 1);
  // Azimuth wraps at 360°: interpolate along the short way round.
  const da = ((c.azimuth_deg[j] - c.azimuth_deg[i] + 540) % 360) - 180;
  const elevation = c.elevation_deg[i] + (c.elevation_deg[j] - c.elevation_deg[i]) * f;
  return {
    azimuth_deg: (c.azimuth_deg[i] + da * f + 360) % 360,
    elevation_deg: elevation,
    distance_km: c.distance_km[i] + (c.distance_km[j] - c.distance_km[i]) * f,
    above_horizon: elevation > 0,
  };
}

/** Positions at `timeMs` (clamped to the track), in the shape the globe draws. */
export function positionsAt(t: SkyTrack, timeMs: number): Positions {
  const x = Math.min(Math.max((timeMs - trackStart(t)) / (t.step_minutes * 60000), 0), t.count - 1);
  const i = Math.min(Math.floor(x), t.count - 1), f = x - i;
  return {
    at_utc: new Date(trackStart(t) + x * t.step_minutes * 60000).toISOString(),
    latitude_deg: t.latitude_deg, longitude_deg: t.longitude_deg, elevation_m: t.elevation_m,
    source: t.source, source_url: t.source_url,
    horizon_model: `Interpolated from JPL Horizons every ${t.step_minutes} min; the smooth-sphere horizon, not terrain.`,
    sun: sample(t.sun, i, f), earth: sample(t.earth, i, f),
  };
}
