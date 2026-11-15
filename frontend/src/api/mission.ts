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

// ------------------------------------------------------------------ window search
export type PowerTier = "low" | "mid" | "high";
export type HeatProfile = "crewed" | "robotic" | "cold_science";
export type CommLevel = "high" | "mid" | "low";
export type SearchNeeds = {
  power: { tier: PowerTier; load_w?: number; energy_kwh?: number; panel_area_m2?: number; efficiency?: number; tracking: boolean; battery_hours?: number };
  heat: { profile: HeatProfile; min_k?: number; max_k?: number };
  comm: { frequency: CommLevel; min_visible_fraction?: number; max_blackout_hours?: number };
  max_slope_deg: number;
};
export type SearchOptions = {
  power: Record<PowerTier, { label: string; load_w: number; panel_area_m2: number; battery_hours: number }>;
  heat: Record<HeatProfile, { label: string; min_k: number; max_k: number }>;
  comm: Record<CommLevel, { label: string; min_visible_fraction: number; max_blackout_hours: number }>;
  efficiency: number; max_search_days: number; max_mission_days: number;
};
/** One cell in one window: the three scores (0-100) and the numbers behind them. */
export type CellDetail = {
  power: number; heat: number; comm: number; site: number;
  energy_kwh: number; coverage: number; sunlit_fraction: number; longest_darkness_h: number; fixed_panel_azimuth_deg: number | null;
  in_range_fraction: number; min_temp_K: number; max_temp_K: number;
  earth_visible_fraction: number; longest_blackout_h: number; slope_ok: boolean;
};
export type SpotDetail = CellDetail & { cell: number; lat: number; lon: number; slope_deg: number; elevation_m: number };
export type ScoreMaps = Record<"site" | "power" | "heat" | "comm", (number | null)[]>;
export type SearchWindow = {
  index: number; start: string; end: string; score: number;
  parts: { power: number; heat: number; comm: number };
  base: SpotDetail; solar_spots: SpotDetail[]; comm_spots: SpotDetail[];
  maps: ScoreMaps; cells: CellDetail[];
};
export type SearchResult = {
  kind: "point" | "polygon";
  cells: { lat: number; lon: number; slope_deg: number; elevation_m: number }[];
  grid: { rows: number; cols: number; resolution_m: number; cell_rows: number[]; cell_cols: number[] } | null;
  timeline: { starts: string[]; score: (number | null)[]; power: (number | null)[]; heat: (number | null)[]; comm: (number | null)[] };
  windows: SearchWindow[];
  need_kwh: number;
  needs: { load_w: number; panel_area_m2: number; efficiency: number; tracking: boolean; battery_hours: number; min_k: number; max_k: number;
    min_visible_fraction: number; max_blackout_hours: number; max_slope_deg: number; labels: Record<string, string> };
  period: { start: string; end: string; mission_days: number };
  step_hours: number; window_stride_hours: number; window_count: number;
  limitations: string[]; sources: Record<string, string>;
};
export type SearchStatus = { status: "running" | "done" | "error"; progress: number; cells: number; result?: SearchResult; error?: string };

export async function fetchSearchOptions(signal?: AbortSignal): Promise<SearchOptions> {
  const res = await fetch("/api/mission/search/options", { signal });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/** Start a window search and poll it; `onProgress` gets 0-1 and the number of sampled cells. */
export async function searchMission(where: Where, start: Date, end: Date, missionDays: number, needs: SearchNeeds,
  onProgress?: (fraction: number, cells: number) => void, signal?: AbortSignal): Promise<SearchResult> {
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  const res = await fetch("/api/mission/search", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ where, start: iso(start), end: iso(end), mission_days: missionDays, ...needs }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const { id, cells } = await res.json() as { id: string; cells: number };
  onProgress?.(0, cells);
  for (;;) {
    await wait(700, signal);
    const poll = await fetch(`/api/mission/search/${id}`, { signal });
    if (!poll.ok) throw new Error(await errorMessage(poll));
    const status = await poll.json() as SearchStatus;
    if (status.status === "error") throw new Error(status.error ?? "The search failed.");
    if (status.status === "done" && status.result) return status.result;
    onProgress?.(status.progress, status.cells);
  }
}
