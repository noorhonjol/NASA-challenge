import { useEffect, useRef, useState } from "react";
import { fetchSunJudge, fetchSunRegion, stepFor, type CriterionResult, type Judged, type SunPreset, type SunRegion } from "../api/client";
import { distanceKm, nearbyGrid } from "../nearby";
import { hours, rangeProblem, toUtc } from "../mission";

const PRESETS: { id: SunPreset | ""; label: string }[] = [
  { id: "crewed_landing", label: "Crewed landing" },
  { id: "lander_survival", label: "Lander survival" },
  { id: "solar_rover", label: "Solar rover" },
  { id: "ice_cold_trap", label: "Ice cold trap" },
  { id: "", label: "No mission check" },
];
const METRIC_LABEL: Record<string, string> = {
  illumination_fraction: "Sunlit fraction", max_darkness_hours: "Longest darkness (h)",
  mean_irradiance_wm2: "Mean sunlight on the ground (W/m²)", energy_tracking_kwh_m2: "Energy, tracking panel (kWh/m²)",
  energy_flat_kwh_m2: "Energy, flat panel (kWh/m²)", slope_deg: "Slope (°)", elevation_m: "Elevation (m)",
  min_temp_K: "Lowest temperature (K)", max_temp_K: "Highest temperature (K)", mean_temp_K: "Mean temperature (K)",
  temp_range_K: "Temperature range (K)", earth_visible_fraction: "Earth visible fraction",
  max_earth_blackout_hours: "Longest Earth blackout (h)",
};
const NEARBY_HALF_KM = 10, NEARBY_PER_SIDE = 7, NEARBY_LISTED = 5;
const W = 314, H = 56;

function Spark({ times, values, min, max, label, unit, className }:
  { times: string[]; values: number[]; min: number; max: number; label: string; unit: string; className: string }) {
  const n = values.length;
  const every = Math.max(1, Math.ceil(n / 400));
  const pts = values.filter((_, i) => i % every === 0 || i === n - 1)
    .map((v, i, all) => `${(i / Math.max(all.length - 1, 1) * W).toFixed(1)},${(H - 2 - (v - min) / (max - min || 1) * (H - 4)).toFixed(1)}`);
  const first = new Date(times[0]), last = new Date(times[n - 1]);
  const day = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return <figure className="sun-spark">
    <figcaption>{label}<span>{min.toFixed(0)}–{max.toFixed(0)} {unit}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} from ${day(first)} to ${day(last)}`}>
      <polyline className={className} points={pts.join(" ")} fill="none" />
    </svg>
    <div className="sun-spark-axis"><span>{day(first)}</span><span>{day(last)}</span></div>
  </figure>;
}

function target(c: CriterionResult) {
  return Array.isArray(c.target) ? `${c.target[0]}–${c.target[1]}` : `${c.op} ${c.target}`;
}

function Verdict({ judged }: { judged: Judged }) {
  const point = judged.ranking[0];
  return <div className="sun-verdict">
    <p><strong className={point.verdict === "PASS" ? "pass" : "fail"}>{point.verdict === "PASS" ? "Meets" : "Does not meet"}</strong>{" "}
      the required limits · score {point.score}%</p>
    <ul>{point.criteria.map(c => <li key={c.metric} className={c.pass ? "pass" : "fail"}>
      <span aria-hidden="true">{c.pass ? "✓" : "✗"}</span>
      <span>{METRIC_LABEL[c.metric] ?? c.metric}{c.required ? " · required" : ""}</span>
      <span>{c.actual ?? "–"} <small>({target(c)})</small></span>
    </li>)}</ul>
  </div>;
}

/** Results reset when the parent changes its key (location or mission range). */
export function SunPanel({ lat, lon, start, end, onPick }:
  { lat: number; lon: number; start: string; end: string; onPick: (lat: number, lon: number, elevation: number) => void }) {
  const [preset, setPreset] = useState<SunPreset | "">("crewed_landing");
  const [data, setData] = useState<SunRegion | null>(null);
  const [nearby, setNearby] = useState<Judged | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"site" | "nearby" | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const area = () => {
    const from = toUtc(start), to = toUtc(end);
    return { start: from, stop: to, stepMin: stepFor(to.getTime() - from.getTime()) };
  };
  const run = <T,>(kind: "site" | "nearby", request: (signal: AbortSignal) => Promise<T>, done: (value: T) => void) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(kind); setError(null);
    request(controller.signal)
      .then(value => { if (!controller.signal.aborted) done(value); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(null); });
  };
  const checkSite = () => {
    setData(null);
    run("site", signal => fetchSunRegion({ ...area(), points: [[lat, lon]], preset: preset || undefined }, signal), setData);
  };
  const rankNearby = () => {
    if (!preset) return;
    setNearby(null);
    run("nearby", signal => fetchSunJudge({ ...area(), points: nearbyGrid(lat, lon, NEARBY_HALF_KM, NEARBY_PER_SIDE),
      preset, topN: NEARBY_LISTED }, signal), setNearby);
  };

  const valid = Number.isFinite(lat) && Number.isFinite(lon) && !rangeProblem(start, end);
  const s = data?.cell_stats;
  const ts = data?.region_timeseries;

  return <section className="link-panel" aria-labelledby="sun-heading">
    <h3 id="sun-heading">Sunlight & temperature</h3>
    <p>Direct sunlight, solar energy and surface temperature over the mission time range, checked against a mission type.</p>
    <div className="link-controls">
      <label>Mission type<select value={preset} onChange={e => { setPreset(e.target.value as SunPreset | ""); setData(null); setNearby(null); }}>
        {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select></label>
      <button type="button" disabled={!valid || busy !== null} onClick={checkSite}>
        {busy === "site" ? "Calculating…" : "Check sunlight & temperature"}
      </button>
    </div>
    {busy && <p role="status">{busy === "site" ? "Tracing the Sun against the local terrain and warming the surface-temperature model over one lunar day first. This takes 10–20 seconds."
      : `Scoring ${NEARBY_PER_SIDE * NEARBY_PER_SIDE} points within ${NEARBY_HALF_KM} km. This can take up to a minute for mission types that check temperature.`}</p>}
    {error && <p role="alert">{error}</p>}
    {data && s && ts && <>
      <div className="metrics">
        <article><h3>Sunlit</h3><strong>{Math.round(s.illumination_fraction[0] * 100)}%</strong>
          <p>Longest darkness {hours(s.max_darkness_hours[0])}</p></article>
        <article><h3>Surface temperature</h3><strong>{s.min_temp_K[0].toFixed(0)}–{s.max_temp_K[0].toFixed(0)} K</strong>
          <p>Mean {s.mean_temp_K[0].toFixed(0)} K</p></article>
        <article><h3>Solar energy</h3><strong>{s.energy_tracking_kwh_m2[0].toFixed(1)} kWh/m²</strong>
          <p>Sun-tracking panel · flat {s.energy_flat_kwh_m2[0].toFixed(1)}</p></article>
        <article><h3>Ground</h3><strong>{s.slope_deg[0].toFixed(1)}° slope</strong>
          <p>{s.elevation_m[0].toFixed(0)} m elevation</p></article>
      </div>
      <Spark times={data.times} values={ts.sun_fraction.mean.map(v => v * 100)} min={0} max={100}
        label="Sun disc visible" unit="%" className="spark-sun" />
      {ts.surface_temp_K && <Spark times={data.times} values={ts.surface_temp_K.mean}
        min={Math.min(...ts.surface_temp_K.mean)} max={Math.max(...ts.surface_temp_K.mean)}
        label="Surface temperature" unit="K" className="spark-temp" />}
      {data.judge && <Verdict judged={data.judge} />}
      {preset && <button type="button" className="sun-secondary" disabled={busy !== null} onClick={rankNearby}>
        {busy === "nearby" ? "Scoring nearby points…" : `Find better spots within ${NEARBY_HALF_KM} km`}
      </button>}
    </>}
    {nearby && <>
      <p>{nearby.summary.n_pass} of {nearby.summary.n_cells} nearby points meet the required limits. Best {NEARBY_LISTED}:</p>
      <ol className="link-windows sun-nearby">{nearby.ranking.map(p => <li key={`${p.lat},${p.lon}`}>
        <span>{p.lat.toFixed(4)}°, {p.lon.toFixed(4)}° · {distanceKm(lat, lon, p.lat, p.lon).toFixed(1)} km</span>
        <span className={p.verdict === "PASS" ? "pass" : "fail"}>{p.score}%</span>
        <button type="button" onClick={() => onPick(p.lat, p.lon, p.elevation_m)}>Fly here</button>
      </li>)}</ol>
    </>}
    {data && <>
      {data.warnings.map(w => <p key={w} role="status">{w}</p>)}
      <p className="attribution">
        {data.meta.terrain_model.type === "lola" ? `Terrain: LOLA, ${data.meta.terrain_model.site_resolution_m?.join(", ")} m near the site. ` : ""}
        Sun positions from JPL Horizons, every {data.meta.step_min} min. Direct sunlight only; the heat model (Hayne et al. 2017) has no light or heat from nearby terrain, so shadowed ground reads 10–30 K too cold.
      </p>
    </>}
  </section>;
}
