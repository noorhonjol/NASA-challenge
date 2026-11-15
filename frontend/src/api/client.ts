export type Site = {
  id: number;
  slug: string;
  name: string;
  lat_deg: number;
  lon_deg: number;
  elevation_m: number | null;
  frame: string;
  is_fictional: boolean;
  notes: string | null;
};

export async function fetchSites(): Promise<Site[]> {
  const res = await fetch("/api/sites");
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res.json();
}

export type BodyPosition = { azimuth_deg: number; elevation_deg: number; above_horizon: boolean; distance_km?: number };
export type Positions = {
  at_utc: string; latitude_deg: number; longitude_deg: number; elevation_m: number;
  source: string; source_url: string; horizon_model: string;
  sun: BodyPosition; earth: BodyPosition;
};

export async function fetchPositions(lat: number, lon: number, elevation: number, at: string, signal?: AbortSignal): Promise<Positions> {
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon), elevation_m: String(elevation), at });
  const res = await fetch(`/api/positions?${query}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Position request failed (${res.status})`);
  }
  return res.json();
}

export type TerrainRegion = {
  id: number; catalog_key: string; region_id: string; name: string; resolution_m: number;
  center: {latitude: number; longitude: number; elevation: number};
  min_elevation_m: number; max_elevation_m: number; bounds_xy_m: number[];
  width: number; height: number; pixel_center_origin_xy_m: number[];
  scale_m: number; nodata: number; grid_bytes: number; compressed_bytes: number;
  grid_url: string; imagery_url: string; imagery_rectangle: number[];
  encoding: string;
  product_id?: number; native_resolution_m?: number; coverage_radius_m?: number;
  chunks?: {
    size: number; width: number; height: number; resolution_m: number;
    pixel_center_origin_xy_m: number[]; available: string[]; url_template: string;
  };
};
export type TerrainManifest = {
  version: string; reference_radius_m: number; tile_size: number; citation: string;
  regions: TerrainRegion[];
  baseline: {source: string; min_elevation_m: number; max_elevation_m: number;
    width: number; height: number; pixels_per_degree: number; scale_m: number; nodata: number; url: string; encoding: string};
};
export async function fetchTerrainManifest(signal?: AbortSignal): Promise<TerrainManifest> {
  const res = await fetch("/api/terrain/browser-manifest", {signal});
  if (!res.ok) throw new Error("Local terrain is not available. Download the elevation data on the backend.");
  const manifest = await res.json();
  if (!Array.isArray(manifest.regions) || manifest.reference_radius_m !== 1737400) throw new Error("Invalid lunar terrain manifest");
  return manifest;
}

export type LinkStatus = "available" | "blocked" | "unknown";
export type EarthLinkWindow = {
  status: LinkStatus; start_utc: string; end_utc: string; duration_hours: number;
  clipped_start: boolean; clipped_end: boolean;
  min_clearance_deg: number | null; max_clearance_deg: number | null;
  causes: ("lunar_limb" | "terrain")[];
};
export type EarthLink = {
  location: {latitude_deg: number; longitude_deg: number; ground_elevation_m: number | null; altitude_m: number};
  period: {start_utc: string; end_utc: string; step_minutes: number; samples: number; duration_hours: number};
  terrain_model: {type: "lola" | "smooth_sphere"; site_resolution_m?: number; max_range_km?: number};
  summary: {
    available_hours: number; available_fraction: number; blocked_hours: number; unknown_hours: number;
    available_windows: number; blocked_windows: number; unknown_windows: number;
    longest_usable_window_hours: number; longest_blackout_hours: number; first_contact_after_hours: number | null;
  };
  windows: EarthLinkWindow[];
  warnings: string[];
  rf: {assessed: boolean; note: string};
};

// Smallest ephemeris step that keeps a request at or under ~1,500 Horizons samples.
// The backend refines Earth's track between samples, so coarser steps stay accurate.
const LINK_STEPS = [10, 15, 30, 60, 120, 180, 360];
export const stepFor = (spanMs: number) => LINK_STEPS.find(m => spanMs / 60000 / m <= 1500) ?? 360;

export async function fetchEarthLink(lat: number, lon: number, start: Date, end: Date, stepMinutes: number, signal?: AbortSignal): Promise<EarthLink> {
  const query = new URLSearchParams({
    lat: String(lat), lon: String(lon), step_minutes: String(stepMinutes),
    start: start.toISOString().replace(".000Z", "Z"), end: end.toISOString().replace(".000Z", "Z"),
  });
  const res = await fetch(`/api/earth-link?${query}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) && typeof detail[0]?.msg === "string" ? detail[0].msg : null;
    throw new Error(message ?? `Earth link request failed (${res.status})`);
  }
  return res.json();
}

export type SunPreset = "crewed_landing" | "lander_survival" | "solar_rover" | "ice_cold_trap";
export type CriterionResult = {
  metric: string; op: string; target: number | [number, number]; actual: number | null;
  pass: boolean; required: boolean; weight: number;
};
export type RankedPoint = { lat: number; lon: number; elevation_m: number; score: number; verdict: "PASS" | "FAIL"; criteria: CriterionResult[] };
export type Judged = { summary: { n_cells: number; n_pass: number; best_score: number }; ranking: RankedPoint[] };
type Band = { mean: number[]; min: number[]; max: number[] };
export type SunRegion = {
  meta: { step_min: number; n_points: number; n_times: number; terrain_model: { type: "lola" | "smooth_sphere"; site_resolution_m?: number[] } };
  times: string[];
  region_timeseries: { sun_fraction: Band; irradiance_wm2: Band; surface_temp_K?: Band; earth_visible?: Band };
  cell_stats: Record<string, number[]>;
  judge?: Judged & { criteria: unknown[] };
  warnings: string[];
};
export type SunArea = { points: [number, number][]; start: Date; stop: Date; stepMin: number; preset?: SunPreset };

const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const detail = payload?.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) && typeof detail[0]?.msg === "string" ? detail[0].msg : null;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.json();
}

/** Sunlight, temperature and (with a preset) the verdict for each point, in one request. */
export function fetchSunRegion(area: SunArea, signal?: AbortSignal): Promise<SunRegion> {
  return postJson("/api/sun/region", {
    points: area.points, start: iso(area.start), stop: iso(area.stop), step_min: area.stepMin,
    thermal_model: true, grid_series: false, ...(area.preset ? { preset: area.preset } : {}),
  }, signal);
}

export function fetchSunJudge(area: SunArea & { preset: SunPreset; topN: number }, signal?: AbortSignal): Promise<Judged> {
  return postJson("/api/sun/judge", {
    points: area.points, start: iso(area.start), stop: iso(area.stop), step_min: area.stepMin,
    preset: area.preset, top_n: area.topN,
  }, signal);
}
