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
