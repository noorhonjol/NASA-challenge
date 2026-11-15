/** Mission planner API: one analysis covering power, heat and communication. */
export type LatLon = [number, number];
export type MissionPreset = "crewed_landing" | "lander_survival" | "solar_rover" | "ice_cold_trap";
export type Where = { type: "point"; lat: number; lon: number } | { type: "polygon"; coordinates: LatLon[] };

export type KnownRegion = {
  id: string; name: string; program: string;
  center: { lat: number; lon: number }; polygon: LatLon[]; size_km: [number, number];
};
export type KnownRegions = { title: string; accuracy: string; source: Record<string, string>; regions: KnownRegion[] };

export type MetricKey = "illumination_fraction" | "max_darkness_hours" | "solar_energy_kwh_m2" | "mean_irradiance_wm2"
  | "min_temp_K" | "max_temp_K" | "mean_temp_K" | "earth_visible_fraction" | "slope_deg" | "elevation_m";
export type Cell = Record<MetricKey, number | null> & { lat: number; lon: number; score?: number; verdict?: "PASS" | "FAIL" };
type Stat = { label: string; unit: string; min: number | null; mean: number | null; max: number | null };
export type CriterionResult = {
  metric: string; op: string; target: number | [number, number]; actual: number | null;
  pass: boolean; required: boolean; weight: number;
};
export type Ranked = { lat: number; lon: number; elevation_m: number; score: number; verdict: "PASS" | "FAIL"; criteria: CriterionResult[] };
export type MissionResult = {
  kind: "point" | "polygon";
  period: { start: string; end: string; days: number; power_step_hours: number; heat_step_minutes: number };
  preset: MissionPreset | null;
  metrics: Record<MetricKey, { label: string; unit: string; aspect: string }>;
  summary: Record<"power" | "heat" | "communication" | "ground", Partial<Record<MetricKey, Stat>>>;
  cells: Cell[];
  grid: { rows: number; cols: number; resolution_m: number; cell_rows: number[]; cell_cols: number[] } | null;
  ranking: Ranked[];
  pass_count: number | null;
  series?: { times: string[]; surface_temp_K: number[]; sun_fraction: number[] };
  communication?: {
    summary: { available_fraction: number; longest_blackout_hours: number; available_windows: number; unknown_hours: number };
    windows: { status: string; start_utc: string; end_utc: string; duration_hours: number }[];
    terrain_model: string;
  };
  warnings: string[];
  limitations: string[];
  sources: Record<string, string>;
};

async function errorMessage(res: Response) {
  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  return typeof detail === "string" ? detail
    : Array.isArray(detail) && typeof detail[0]?.msg === "string" ? String(detail[0].msg).replace(/^Value error, /, "")
    : `Request failed (${res.status})`;
}

export async function fetchKnownRegions(signal?: AbortSignal): Promise<KnownRegions> {
  const res = await fetch("/api/mission/regions", { signal });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function analyzeMission(where: Where, start: Date, end: Date, preset: MissionPreset | null, signal?: AbortSignal): Promise<MissionResult> {
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  const res = await fetch("/api/mission/analyze", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ where, start: iso(start), end: iso(end), preset }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}
