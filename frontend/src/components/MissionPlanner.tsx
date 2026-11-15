import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Site } from "../api/client";
import { analyzeMission, fetchKnownRegions, type Cell, type KnownRegion, type LatLon, type MetricKey,
  type MissionPreset, type MissionResult, type Where } from "../api/mission";
import { hours, rangeProblem, toUtc, when } from "../mission";
import { MissionRange } from "./MissionRange";
import { Sparkline } from "./Sparkline";

const PRESETS: { id: MissionPreset | ""; label: string }[] = [
  { id: "crewed_landing", label: "Crewed landing" },
  { id: "lander_survival", label: "Lander survival" },
  { id: "solar_rover", label: "Solar rover" },
  { id: "ice_cold_trap", label: "Ice cold trap" },
  { id: "", label: "No mission check" },
];
const MAP_LAYERS: { key: MetricKey | "score"; label: string }[] = [
  { key: "score", label: "Mission score" },
  { key: "illumination_fraction", label: "Sunlit fraction" },
  { key: "min_temp_K", label: "Lowest temperature" },
  { key: "max_temp_K", label: "Highest temperature" },
  { key: "earth_visible_fraction", label: "Earth visible" },
  { key: "slope_deg", label: "Slope" },
];
const LISTED = 5;
// Perceptually ordered dark-blue -> teal -> yellow scale; higher values are brighter.
const RAMP = ["#22305a", "#22668d", "#1f9e89", "#6ece58", "#fde725"];

export type PlannerSource = { kind: "location"; lat: number; lon: number; name: string };
export type GlobeOverlay = { polygon: LatLon[] | null; spots: { lat: number; lon: number; label: string; pass: boolean }[] };

const pct = (v: number | null | undefined) => v == null ? "–" : `${Math.round(v * 100)}%`;
const num = (v: number | null | undefined, digits = 0) => v == null ? "–" : v.toFixed(digits);

function color(value: number, min: number, max: number) {
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(t * (RAMP.length - 1))))];
}

function Heatmap({ result, layer, onPick }: { result: MissionResult; layer: MetricKey | "score"; onPick: (c: Cell) => void }) {
  const g = result.grid!;
  const values = result.cells.map(c => (layer === "score" ? c.score : c[layer]) ?? null);
  const finite = values.filter((v): v is number => v !== null);
  const min = Math.min(...finite), max = Math.max(...finite);
  const size = Math.max(6, Math.floor(420 / Math.max(g.cols, g.rows)));
  return <svg className="mission-heatmap" viewBox={`0 0 ${g.cols * size} ${g.rows * size}`} role="img"
    aria-label={`${MAP_LAYERS.find(l => l.key === layer)?.label} map, ${result.cells.length} cells of ${g.resolution_m} m`}>
    {result.cells.map((c, i) => <rect key={i} x={g.cell_cols[i] * size} y={g.cell_rows[i] * size} width={size - 1} height={size - 1}
      fill={values[i] === null ? "#333" : color(values[i]!, min, max)} stroke={c.verdict === "PASS" && layer === "score" ? "#fff" : "none"}
      onClick={() => onPick(c)}>
      <title>{`${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}° · ${values[i] ?? "no data"}${c.verdict ? ` · ${c.verdict}` : ""}`}</title>
    </rect>)}
  </svg>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <article className="mission-card"><h3>{title}</h3>{children}</article>;
}

function Results({ result, onFly }: { result: MissionResult; onFly: (lat: number, lon: number, elevation: number) => void }) {
  const [layer, setLayer] = useState<MetricKey | "score">(result.preset ? "score" : "illumination_fraction");
  const region = result.kind === "polygon";
  const s = result.summary;
  const one = result.cells[0];
  const best = result.ranking[0];
  const range = (k: MetricKey, f: (v: number | null) => string, group: keyof MissionResult["summary"]) => {
    const st = s[group][k];
    return region ? `${f(st?.min ?? null)} – ${f(st?.max ?? null)}` : f(one[k]);
  };
  return <section className="mission-results" aria-label="Mission results">
    {result.preset && (region
      ? <p className="mission-verdict">{result.pass_count} of {result.cells.length} spots meet every required limit.</p>
      : <p className="mission-verdict"><strong className={best?.verdict === "PASS" ? "pass" : "fail"}>
          {best?.verdict === "PASS" ? "Meets" : "Does not meet"}</strong> the required limits · score {best?.score}%</p>)}
    {region && <p className="mission-note">Ranges across {result.cells.length} spots, {(result.grid!.resolution_m / 1000).toFixed(result.grid!.resolution_m < 1000 ? 2 : 1)} km apart.</p>}
    <div className="mission-cards">
      <Card title="Power · sunlight">
        <strong>{range("illumination_fraction", pct, "power")}</strong><span>of the time in sunlight</span>
        <p>Longest darkness {range("max_darkness_hours", v => v == null ? "–" : hours(v), "power")}</p>
        <p>{range("solar_energy_kwh_m2", v => num(v), "power")} kWh/m² on a sun-tracking panel</p>
      </Card>
      <Card title="Heat · surface">
        <strong>{region ? `${num(s.heat.min_temp_K?.min)} – ${num(s.heat.max_temp_K?.max)} K` : `${num(one.min_temp_K)} – ${num(one.max_temp_K)} K`}</strong>
        <span>lowest to highest</span>
        <p>Mean {range("mean_temp_K", v => `${num(v)} K`, "heat")}</p>
      </Card>
      <Card title="Communication · Earth">
        <strong>{result.communication ? pct(result.communication.summary.available_fraction) : range("earth_visible_fraction", pct, "communication")}</strong>
        <span>of the time Earth is in view</span>
        {result.communication
          ? <p>Longest blackout {hours(result.communication.summary.longest_blackout_hours)} · {result.communication.summary.available_windows} window{result.communication.summary.available_windows === 1 ? "" : "s"}</p>
          : <p>Line of sight to Earth's center</p>}
      </Card>
      <Card title="Ground">
        <strong>{range("slope_deg", v => `${num(v, 1)}°`, "ground")}</strong><span>slope</span>
        <p>Elevation {range("elevation_m", v => `${num(v)} m`, "ground")}</p>
      </Card>
    </div>
    {!region && result.series && <>
      <Sparkline times={result.series.times} values={result.series.sun_fraction.map(v => v * 100)} min={0} max={100}
        label="Sun disc visible" unit="%" className="spark-sun" />
      <Sparkline times={result.series.times} values={result.series.surface_temp_K}
        min={Math.min(...result.series.surface_temp_K)} max={Math.max(...result.series.surface_temp_K)}
        label="Surface temperature" unit="K" className="spark-temp" />
    </>}
    {!region && result.communication && result.communication.summary.unknown_hours > 0 &&
      <p className="banner">{hours(result.communication.summary.unknown_hours)} of Earth contact could not be decided and counts as no contact.</p>}
    {best && <details className="mission-criteria" open={!region}>
      <summary>{region ? "Why the best spot scores what it does" : "Mission check, criterion by criterion"}</summary>
      <ul>{best.criteria.map(c => <li key={c.metric} className={c.pass ? "pass" : "fail"}>
        <span aria-hidden="true">{c.pass ? "✓" : "✗"}</span>
        <span>{result.metrics[c.metric as MetricKey]?.label ?? c.metric}{c.required ? " · required" : ""}</span>
        <span>{c.actual ?? "–"} <small>({Array.isArray(c.target) ? c.target.join("–") : `${c.op} ${c.target}`})</small></span>
      </li>)}</ul>
    </details>}
    {region && <>
      <label className="mission-layer">Map layer<select value={layer} onChange={e => setLayer(e.target.value as MetricKey | "score")}>
        {MAP_LAYERS.filter(l => l.key !== "score" || result.preset).map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select></label>
      <Heatmap result={result} layer={layer} onPick={c => onFly(c.lat, c.lon, c.elevation_m ?? 0)} />
      <p className="mission-note">Brighter is higher. Polar regions are drawn with 0° longitude at the top. Click a cell to fly there.</p>
      {result.ranking.length > 0 && <ol className="link-windows mission-ranking" aria-label="Best spots">{result.ranking.slice(0, LISTED).map(r =>
        <li key={`${r.lat},${r.lon}`}>
          <span>{r.lat.toFixed(4)}°, {r.lon.toFixed(4)}°</span>
          <span className={r.verdict === "PASS" ? "pass" : "fail"}>{r.score}%</span>
          <button type="button" onClick={() => onFly(r.lat, r.lon, r.elevation_m)}>Fly here</button>
        </li>)}</ol>}
    </>}
    {!region && result.communication && result.communication.windows.some(w => w.status === "available") && <details className="mission-criteria">
      <summary>Earth contact windows (UTC)</summary>
      <ol className="link-windows">{result.communication.windows.filter(w => w.status === "available").slice(0, 10).map(w =>
        <li key={w.start_utc}><span>{when(w.start_utc)} – {when(w.end_utc)}</span><span>{hours(w.duration_hours)}</span></li>)}</ol>
    </details>}
    {result.warnings.map(w => <p key={w} role="status">{w}</p>)}
    <details className="mission-criteria">
      <summary>How this was calculated</summary>
      <ul className="mission-plain">
        {Object.entries(result.sources).map(([k, v]) => <li key={k}><strong>{k}:</strong> {v}</li>)}
        <li>Sampling: sunlight every {result.period.power_step_hours} h, temperature every {result.period.heat_step_minutes} min.</li>
        {result.limitations.map(l => <li key={l}>{l}</li>)}
      </ul>
    </details>
  </section>;
}

type Choice = "location" | "known" | "drawn";

export function MissionPlanner({ location, sites, mission, onMissionChange, drawn, onDraw, onFly, onOverlay, onClose, advanced }: {
  /** The site picked on the globe or in the panel; null when nothing is selected. */
  location: PlannerSource | null;
  sites: Site[];
  mission: { start: string; end: string };
  onMissionChange: (start: string, end: string) => void;
  drawn: LatLon[] | null;
  onDraw: () => void;
  onFly: (lat: number, lon: number, elevation: number) => void;
  onOverlay: (overlay: GlobeOverlay) => void;
  onClose: () => void;
  advanced: ReactNode;
}) {
  const [tab, setTab] = useState<"plan" | "advanced">("plan");
  const [choice, setChoice] = useState<Choice>(drawn ? "drawn" : location ? "location" : "known");
  const [known, setKnown] = useState("");
  const [regions, setRegions] = useState<KnownRegion[]>([]);
  const [regionsNote, setRegionsNote] = useState("");
  const [preset, setPreset] = useState<MissionPreset | "">("crewed_landing");
  // A result belongs to the area it was computed for; it stays while that area is chosen
  // (flying to a best spot keeps a region's result) and is hidden once the area changes.
  const [computed, setComputed] = useState<{ key: string; result: MissionResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchKnownRegions(controller.signal).then(doc => { setRegions((Array.isArray(doc?.regions) ? doc.regions : []).filter(r => r && Array.isArray(r.size_km) && Array.isArray(r.polygon))); setRegionsNote(doc.accuracy); })
      .catch(() => { /* The site list still works without the regions. */ });
    return () => { controller.abort(); inFlight.current?.abort(); };
  }, []);

  // Depend on the coordinates, not the location object, which the parent recreates on every render.
  const locationLat = location?.lat ?? NaN, locationLon = location?.lon ?? NaN;
  // With nothing selected, "Selected site" cannot apply: fall back to the known list.
  const active: Choice = choice === "location" && !location ? "known" : choice;
  const where: Where | null = useMemo(() => {
    if (active === "location") return Number.isFinite(locationLat) && Number.isFinite(locationLon) ? { type: "point", lat: locationLat, lon: locationLon } : null;
    if (active === "drawn") return drawn && drawn.length >= 3 ? { type: "polygon", coordinates: drawn } : null;
    const region = regions.find(r => r.id === known);
    if (region) return { type: "polygon", coordinates: region.polygon };
    const site = sites.find(s => `site:${s.id}` === known);
    return site ? { type: "point", lat: site.lat_deg, lon: site.lon_deg } : null;
  }, [active, locationLat, locationLon, drawn, known, regions, sites]);
  const whereKey = JSON.stringify(where);
  const result = computed && computed.key === whereKey ? computed.result : null;

  // Show the chosen area and the best spots on the globe.
  useEffect(() => {
    const polygon = where?.type === "polygon" ? where.coordinates : null;
    const spots = result?.kind === "polygon" ? result.ranking.slice(0, LISTED).map((r, i) => ({ lat: r.lat, lon: r.lon, label: `#${i + 1} · ${r.score}%`, pass: r.verdict === "PASS" })) : [];
    onOverlay({ polygon, spots });
  }, [where, result, onOverlay]);

  const problem = rangeProblem(mission.start, mission.end);
  const outOfEpoch = !problem && (toUtc(mission.start) < new Date("2020-01-01T00:00:00Z") || toUtc(mission.end) >= new Date("2036-01-01T00:00:00Z"));
  const reset = () => { inFlight.current?.abort(); setComputed(null); setError(null); setBusy(false); };

  const analyze = () => {
    if (!where) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const key = whereKey;
    setBusy(true); setError(null); setComputed(null);
    analyzeMission(where, toUtc(mission.start), toUtc(mission.end), preset || null, controller.signal)
      .then(value => { if (!controller.signal.aborted) setComputed({ key, result: value }); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  // The planner sits beside the globe: flying keeps it open, with the results, to compare spots.
  const fly = (lat: number, lon: number, elevation: number) => onFly(lat, lon, elevation);

  return <section className="energy-planner mission-planner" aria-label="Mission planner">
    <div className="energy-heading">
      <div><h2>Mission planner</h2>
        <p>Sunlight, temperature and Earth contact for a site or a region.</p></div>
      <button type="button" onClick={onClose}>Close planner</button>
    </div>
    <div className="mission-tabs" role="tablist" aria-label="Planner mode">
      <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Plan</button>
      <button type="button" role="tab" aria-selected={tab === "advanced"} onClick={() => setTab("advanced")}>Detailed analysis</button>
    </div>
    {tab === "plan" ? <div className="mission-plan" role="tabpanel" aria-label="Plan">
      <fieldset className="mission-step">
        <legend>1 · Where</legend>
        <label className="mission-choice"><input type="radio" name="where" disabled={!location} checked={active === "location"} onChange={() => { setChoice("location"); reset(); }} />
          <span>Selected site<small>{location ? `${location.name} · ${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°` : "Pick a site first: choose one in the panel or click a pin"}</small></span></label>
        <label className="mission-choice"><input type="radio" name="where" checked={active === "known"} onChange={() => { setChoice("known"); reset(); }} />
          <span>Artemis III region or known site<small>NASA's candidate landing regions and the PGDA 78 south-pole sites</small></span></label>
        {active === "known" && <label className="mission-known">Region or site<select value={known} onChange={e => { setKnown(e.target.value); reset(); }}>
          <option value="">Choose…</option>
          {regions.length > 0 && <optgroup label="NASA Artemis III candidate regions (2024)">
            {regions.map(r => <option key={r.id} value={r.id}>{r.name} · {r.size_km[0].toFixed(0)}×{r.size_km[1].toFixed(0)} km</option>)}
          </optgroup>}
          {sites.length > 0 && <optgroup label="Sites (single points)">
            {sites.map(s => <option key={s.id} value={`site:${s.id}`}>{s.name}</option>)}
          </optgroup>}
        </select></label>}
        {active === "known" && regions.some(r => r.id === known) && <p className="mission-note">{regionsNote}</p>}
        <label className="mission-choice"><input type="radio" name="where" checked={active === "drawn"} onChange={() => { setChoice("drawn"); reset(); }} />
          <span>Draw a region on the Moon<small>{drawn && drawn.length >= 3 ? `${drawn.length} corners drawn` : "Click its corners on the globe"}</small></span></label>
        {active === "drawn" && <button type="button" className="sun-secondary" onClick={onDraw}>{drawn?.length ? "Redraw region on the Moon" : "Draw region on the Moon"}</button>}
      </fieldset>
      <fieldset className="mission-step">
        <legend>2 · When</legend>
        <MissionRange start={mission.start} end={mission.end} onChange={(s, e) => { reset(); onMissionChange(s, e); }} />
        {outOfEpoch && <p className="link-hint">The power model covers 2020–2035. Choose dates in that range.</p>}
      </fieldset>
      <fieldset className="mission-step">
        <legend>3 · Mission type</legend>
        <label>Mission type<select value={preset} onChange={e => { setPreset(e.target.value as MissionPreset | ""); reset(); }}>
          {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select></label>
        <p className="mission-note">Screening thresholds for slope, sunlight, darkness, temperature and Earth visibility. They are illustrative, not agency requirements.</p>
      </fieldset>
      <button type="button" className="mission-run" disabled={!where || Boolean(problem) || outOfEpoch || busy} onClick={analyze}>
        {busy ? "Analyzing…" : where?.type === "polygon" ? "Analyze region" : "Analyze site"}
      </button>
      {busy && <p role="status">{where?.type === "polygon"
        ? "Sampling the region on a grid, then sunlight, temperature and Earth visibility for every spot. This takes 15–60 seconds."
        : "Calculating sunlight, temperature and Earth contact. This takes 5–20 seconds."}</p>}
      {error && <p role="alert">{error}</p>}
      {result && <Results result={result} onFly={fly} />}
    </div> : <div className="mission-advanced" role="tabpanel" aria-label="Detailed analysis">{advanced}</div>}
  </section>;
}
