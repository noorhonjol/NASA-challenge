export type EnergyTask = "point" | "region" | "mission" | "windows";
export type Location = {
  lat: number;
  lon: number;
  height_m: number;
  elevation_m: number;
  slope_deg: number;
  aspect_deg: number;
};
export type Meta = {
  request_id: string;
  dem_product: string;
  ephemeris: string;
  computed_in_ms: number;
  limitations: string[];
  horizon_model: string;
};
export type EnergyData = {
  location?: Location;
  meta: Meta;
  time?: string;
  sun?: Record<string, number | boolean>;
  earth?: { elevation_deg: number; is_visible: boolean };
  irradiance?: Record<string, number | null>;
  grid?: {
    rows: number;
    cols: number;
    resolution_m: number;
    mask: boolean[][];
  };
  metrics?: Record<
    string,
    {
      unit: string;
      min: number | null;
      max: number | null;
      mean: number | null;
      values: (number | null)[][];
    }
  >;
  ranking?: {
    by: string;
    top: {
      row: number;
      col: number;
      lat: number;
      lon: number;
      value: number;
    }[];
  };
  solar_conditions?: Record<string, number | string | null>;
  energy?: Record<string, number>;
  sizing?: Record<string, number | string | null>;
  feasible?: boolean;
  warnings?: { code: string; message: string; time?: string }[];
  panel_recommendation?: {
    selected_mode: string;
    selected_tilt_deg: number | null;
    selected_azimuth_deg: number | null;
    comparison: Record<string, number | string | null>[];
  };
  timeline?: {
    times: string[];
    solar_input_w?: number[];
    load_w?: number[];
    battery_soc_pct: number[];
    power_w?: number[];
    usable?: boolean[];
  };
  summary?: {
    usable_pct: number;
    window_count: number;
    total_window_hours: number;
  };
  windows?: {
    rank: number;
    start: string;
    end: string;
    duration_hours: number;
    score: number;
    mean_power_w: number;
    min_battery_soc_pct: number;
  }[];
  unsuitable_periods?: { start: string; end: string; reasons: string[] }[];
};
const paths: Record<EnergyTask, string> = {
  point: "solar/point",
  region: "solar/region",
  mission: "power/mission",
  windows: "power/windows",
};
export async function fetchEnergy(
  task: EnergyTask,
  payload: object,
  signal: AbortSignal,
): Promise<EnergyData> {
  const query =
    task === "point"
      ? "?" +
        new URLSearchParams(
          Object.entries(payload).map(([key, value]) => [key, String(value)]),
        )
      : "";
  const response = await fetch(
    `/v1/${paths[task]}${query}`,
    task === "point"
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error
        ? `${body.error.code}: ${body.error.message}${body.error.field ? ` (${body.error.field})` : ""}`
        : `Energy API request failed (${response.status})`,
    );
  if (!body?.meta) throw new Error("Invalid Energy API response");
  return body;
}
