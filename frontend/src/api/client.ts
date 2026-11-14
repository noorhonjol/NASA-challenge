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

export type PlanningPoint = {lat: number; lon: number};
export type Equipment = {
  load_w: number; panel_area_m2: number; panel_efficiency: number; system_efficiency: number;
  panel_mode: "horizontal" | "sun_tracking"; battery_wh: number; usable_battery_fraction: number;
  minimum_earth_elevation_deg: number; require_earth_visibility: boolean;
};
export type PlanningSample = Positions & {
  generated_power_w: number; net_power_w: number; load_w: number;
  solar_irradiance_normal_w_m2: number; panel_irradiance_w_m2: number;
  required_panel_area_m2: number | null; earth_visible: boolean; meets_operating_constraints: boolean;
};
export type PlanningResult = {
  point: PlanningPoint & {elevation_m: number};
  elevation: {dataset: string; resolution_m?: number; resolution_deg?: number; method: string; frame: string; reference_radius_m: number};
  samples: PlanningSample[];
  operating_windows: {start: string; end: string; duration_hours: number}[];
  summary: {duration_hours: number; generated_energy_wh: number; load_energy_wh: number; net_energy_wh: number;
    minimum_initial_usable_energy_wh: number; minimum_usable_storage_wh: number;
    minimum_nameplate_battery_wh: number; battery_sufficient_if_initially_full: boolean};
};
export type PlanningResponse = Partial<PlanningResult> & {
  results?: PlanningResult[]; source: string; solar_reference_url: string; assumptions: string[]; equipment: Equipment;
};

export async function fetchPlanning(mode: "power" | "analysis" | "windows", payload: object, signal?: AbortSignal): Promise<PlanningResponse> {
  return requestPlanning<PlanningResponse>(mode, payload, signal);
}

export type ResourceResult = {
  point: PlanningResult["point"]; elevation: PlanningResult["elevation"];
  samples: (Positions & {solar_irradiance_normal_w_m2: number; horizontal_irradiance_w_m2: number; sun_visible: boolean; earth_visible: boolean})[];
  summary: {duration_hours: number; horizontal_solar_energy_wh_m2: number; mean_horizontal_irradiance_w_m2: number; peak_sampled_horizontal_irradiance_w_m2: number};
};
export type ResourceResponse = {results: ResourceResult[]; source: string; solar_reference_url: string; assumptions: string[]};
export function fetchResources(payload: object, signal?: AbortSignal): Promise<ResourceResponse> {
  return requestPlanning<ResourceResponse>("resources", payload, signal);
}

async function requestPlanning<T>(mode: string, payload: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/planning/${mode}`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail)
      ? detail.map((item: {loc?: (string | number)[]; msg: string}) => `${item.loc?.slice(1).join(".")}: ${item.msg}`).join("; ")
      : `Planning request failed (${response.status})`);
  }
  if (!body || (!Array.isArray(body.results) && !Array.isArray(body.samples))) throw new Error("Invalid planning response");
  return body;
}
