import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSearchOptions, searchMission,
  type CellDetail, type CommLevel, type HeatProfile, type PowerTier, type SearchNeeds, type SearchOptions,
  type SearchResult, type SearchWindow, type SpotDetail, type Where,
} from "../api/mission";
import { rangeProblem, spanDays, toUtc } from "../mission";
import { MissionRange } from "./MissionRange";
import { LAYERS, estimate, scoreColor, type Layer } from "./missionScores";
import type { GlobeOverlay } from "./MissionPlanner";

type Probe = { id: number; lat: number; lon: number; elevation: number; state: "estimate" | "loading" | "done" | "error"; result?: SearchResult; error?: string };

const FALLBACK: SearchOptions = {
  power: { low: { label: "Low power · small robotic payload", load_w: 100, panel_area_m2: 1.5, battery_hours: 50 },
    mid: { label: "Mid power · rover or robotic lander", load_w: 1000, panel_area_m2: 10, battery_hours: 30 },
    high: { label: "High power · crewed lander or habitat", load_w: 10000, panel_area_m2: 80, battery_hours: 12 } },
  heat: { crewed: { label: "Crewed", min_k: 100, max_k: 330 }, robotic: { label: "Robotic", min_k: 70, max_k: 380 },
    cold_science: { label: "Cold-trap science (ice)", min_k: 0, max_k: 110 } },
  comm: { high: { label: "Very frequent (near-continuous)", min_visible_fraction: 0.9, max_blackout_hours: 12 },
    mid: { label: "Frequent (daily contact)", min_visible_fraction: 0.5, max_blackout_hours: 48 },
    low: { label: "Occasional", min_visible_fraction: 0.2, max_blackout_hours: 168 } },
  efficiency: 0.3, max_search_days: 180, max_mission_days: 60,
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const span = (a: string, b: string) => `${day(a)} – ${day(b)}`;
const pct = (v: number | null | undefined) => v == null ? "–" : `${Math.round(v * 100)}%`;
const num = (v: number | null | undefined, d = 0) => v == null ? "–" : v.toFixed(d);
/** Optional number field: empty means "use the default". */
const optional = (text: string) => { const v = Number(text.trim()); return text.trim() && Number.isFinite(v) ? v : undefined; };
/** Score colour from dark purple (0) through teal to yellow (100); also used on the globe. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="choice-group" role="radiogroup" aria-label={label}>
    {options.map(o => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>)}
  </div>;
}

function Bar({ label, value }: { label: string; value: number | null | undefined }) {
  return <span className="score-bar" title={`${label}: ${num(value)}`}>
    <i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, background: scoreColor(value) }} /><b>{label}</b>
  </span>;
}

/** The numbers behind one spot's three scores in one window. */
function Criteria({ cell, needs, needKwh }: { cell: CellDetail; needs: SearchResult["needs"]; needKwh: number }) {
  const ok = (pass: boolean) => <span className={pass ? "pass" : "fail"}>{pass ? "✓" : "✗"}</span>;
  return <table className="criteria-table">
    <thead><tr><th>Criterion</th><th>Here</th><th>Needed</th><th /></tr></thead>
    <tbody>
      <tr className="crit-head"><td colSpan={4}>Power · {num(cell.power)}</td></tr>
      <tr><td>Energy from panels</td><td>{num(cell.energy_kwh)} kWh</td><td>{num(needKwh)} kWh</td><td>{ok(cell.energy_kwh >= needKwh)}</td></tr>
      <tr><td>Longest darkness</td><td>{num(cell.longest_darkness_h)} h</td><td>≤ {num(needs.battery_hours)} h battery</td><td>{ok(cell.longest_darkness_h <= needs.battery_hours)}</td></tr>
      <tr><td>Sunlit</td><td>{pct(cell.sunlit_fraction)}</td><td /><td /></tr>
      {cell.fixed_panel_azimuth_deg != null && <tr><td>Fixed panel faces</td><td>{num(cell.fixed_panel_azimuth_deg)}°</td><td /><td /></tr>}
      <tr className="crit-head"><td colSpan={4}>Heat · {num(cell.heat)}</td></tr>
      <tr><td>Time in allowed range</td><td>{pct(cell.in_range_fraction)}</td><td>{num(needs.min_k)}–{num(needs.max_k)} K</td><td>{ok(cell.in_range_fraction >= 0.999)}</td></tr>
      <tr><td>Surface temperature</td><td>{num(cell.min_temp_K)}–{num(cell.max_temp_K)} K</td><td /><td /></tr>
      <tr className="crit-head"><td colSpan={4}>Communication · {num(cell.comm)}</td></tr>
      <tr><td>Earth in view</td><td>{pct(cell.earth_visible_fraction)}</td><td>≥ {pct(needs.min_visible_fraction)}</td><td>{ok(cell.earth_visible_fraction >= needs.min_visible_fraction)}</td></tr>
      <tr><td>Longest blackout</td><td>{num(cell.longest_blackout_h)} h</td><td>≤ {num(needs.max_blackout_hours)} h</td><td>{ok(cell.longest_blackout_h <= needs.max_blackout_hours)}</td></tr>
      <tr className="crit-head"><td colSpan={4}>Ground</td></tr>
      <tr><td>Slope fit for a base</td><td>{cell.slope_ok ? "Yes" : "Too steep"}</td><td>≤ {num(needs.max_slope_deg)}°</td><td>{ok(cell.slope_ok)}</td></tr>
    </tbody>
  </table>;
}

function Timeline({ result, selected, onSelect }: { result: SearchResult; selected: number; onSelect: (i: number) => void }) {
  const W = 400, H = 80;
  const n = result.timeline.score.length;
  const x = (i: number) => n > 1 ? i / (n - 1) * W : W / 2;
  const y = (v: number | null) => H - 4 - (v ?? 0) / 100 * (H - 20);       // room above 100 for the labels
  const line = result.timeline.score.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return <figure className="search-timeline">
    <figcaption>Window score through the search period <span>by start day</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Score of every mission window by its start date">
      <polyline points={line} fill="none" />
      {result.windows.map((w, k) => <g key={w.index} className={k === selected ? "is-selected" : ""} onClick={() => onSelect(k)}>
        <circle cx={x(w.index)} cy={y(w.score)} r={k === selected ? 6 : 4.5} />
        <text x={x(w.index)} y={y(w.score) - 8} textAnchor="middle">{k + 1}</text>
      </g>)}
    </svg>
    <div className="sun-spark-axis"><span>{day(result.timeline.starts[0])}</span><span>{day(result.timeline.starts[n - 1])}</span></div>
  </figure>;
}

function SpotList({ title, spots, field, onFly, onShow, shown }: {
  title: string; spots: SpotDetail[]; field: "power" | "comm" | "site"; onFly: (s: SpotDetail) => void; onShow: (s: SpotDetail) => void; shown: number | null;
}) {
  return <div className="spot-list">
    <h4>{title}</h4>
    <ol>{spots.map(s => <li key={s.cell} className={shown === s.cell ? "is-shown" : ""}>
      <button type="button" className="spot-name" onClick={() => onShow(s)}>{s.lat.toFixed(4)}°, {s.lon.toFixed(4)}°</button>
      <span style={{ color: scoreColor(s[field]) }}>{num(s[field])}</span>
      <button type="button" onClick={() => onFly(s)}>Fly here</button>
    </li>)}</ol>
  </div>;
}

export function MissionSearch({ where, mission, onMissionChange, onFly, onOverlay, probing, onProbe, probe }: {
  where: Where | null;
  mission: { start: string; end: string };
  onMissionChange: (start: string, end: string) => void;
  onFly: (lat: number, lon: number, elevation: number) => void;
  onOverlay: (overlay: GlobeOverlay) => void;
  /** Whether the next click on the Moon picks a spot to compare. */
  probing: boolean;
  onProbe: (on: boolean) => void;
  /** The last spot clicked while probing. */
  probe: { lat: number; lon: number; elevation: number } | null;
}) {
  const [options, setOptions] = useState<SearchOptions>(FALLBACK);
  const [missionDays, setMissionDays] = useState("14");
  const [tier, setTier] = useState<PowerTier>("mid");
  const [tracking, setTracking] = useState(true);
  const [power, setPower] = useState({ energy: "", area: "", efficiency: "", battery: "" });
  const [profile, setProfile] = useState<HeatProfile>("robotic");
  const [heat, setHeat] = useState({ min: "", max: "" });
  const [frequency, setFrequency] = useState<CommLevel>("mid");
  const [comm, setComm] = useState({ share: "", blackout: "" });
  const [slope, setSlope] = useState("15");
  const [computed, setComputed] = useState<{ key: string; result: SearchResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number; cells: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [layer, setLayer] = useState<Layer>("site");
  const [shown, setShown] = useState<number | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const inFlight = useRef<AbortController | null>(null);
  const probeFlights = useRef(new Set<AbortController>());
  const nextProbe = useRef(1);

  useEffect(() => {
    const controller = new AbortController();
    fetchSearchOptions(controller.signal)
      .then(o => { if (o?.power?.mid && o?.heat?.robotic && o?.comm?.mid) setOptions(o); })     // else the built-in defaults stay
      .catch(() => { /* built-in defaults stay */ });
    const flights = probeFlights.current;
    return () => { controller.abort(); inFlight.current?.abort(); flights.forEach(f => f.abort()); };
  }, []);

  const days = Number(missionDays);
  const periodDays = spanDays(mission.start, mission.end);
  const rangeIssue = rangeProblem(mission.start, mission.end);
  const problem = rangeIssue ?? (
    !Number.isFinite(days) || days <= 0 ? "Enter the mission length in days."
    : days > options.max_mission_days ? `A mission can be at most ${options.max_mission_days} days.`
    : periodDays > options.max_search_days ? `The search period can be at most ${options.max_search_days} days.`
    : days > periodDays + 1e-9 ? "The mission must fit inside the search period."
    : toUtc(mission.start).getTime() - 30 * 86400e3 < Date.parse("2020-01-01T00:00:00Z") || toUtc(mission.end) >= new Date("2036-01-01T00:00:00Z")
      ? "The ephemeris covers 2020–2035; the search also needs the month before its start." : null);

  const needs: SearchNeeds = useMemo(() => ({
    power: { tier, tracking, energy_kwh: optional(power.energy), panel_area_m2: optional(power.area),
      efficiency: optional(power.efficiency) !== undefined ? optional(power.efficiency)! / 100 : undefined, battery_hours: optional(power.battery) },
    heat: { profile, min_k: optional(heat.min), max_k: optional(heat.max) },
    comm: { frequency, min_visible_fraction: optional(comm.share) !== undefined ? optional(comm.share)! / 100 : undefined, max_blackout_hours: optional(comm.blackout) },
    max_slope_deg: optional(slope) ?? 15,
  }), [tier, tracking, power, profile, heat, frequency, comm, slope]);
  // A result belongs to its exact question; changing anything hides it until searched again.
  const key = JSON.stringify({ where, mission, days, needs });
  const result = computed?.key === key ? computed.result : null;
  const win: SearchWindow | null = result?.windows[selected] ?? result?.windows[0] ?? null;

  const run = () => {
    if (!where || problem) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const asked = key;
    setBusy(true); setError(null); setProgress(null); setComputed(null); setSelected(0); setShown(null); setProbes([]);
    searchMission(where, toUtc(mission.start), toUtc(mission.end), days, needs, (fraction, cells) => setProgress({ fraction, cells }), controller.signal)
      .then(value => { if (!controller.signal.aborted) setComputed({ key: asked, result: value }); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) { setBusy(false); setProgress(null); } });
  };

  // A spot clicked on the Moon while comparing: estimate at once, compute on request.
  const lastProbe = useRef(probe);
  useEffect(() => {
    if (!probe || probe === lastProbe.current) return;
    lastProbe.current = probe;
    const id = nextProbe.current++;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new click from the globe adds a row
    setProbes(list => [...list, { id, ...probe, state: "estimate" }]);
    onProbe(false);
  }, [probe, onProbe]);

  const computeProbe = (p: Probe) => {
    const controller = new AbortController();
    probeFlights.current.add(controller);
    setProbes(list => list.map(q => q.id === p.id ? { ...q, state: "loading" } : q));
    searchMission({ type: "point", lat: p.lat, lon: p.lon }, toUtc(mission.start), toUtc(mission.end), days, needs, undefined, controller.signal)
      .then(r => setProbes(list => list.map(q => q.id === p.id ? { ...q, state: "done", result: r } : q)))
      .catch((err: unknown) => { if (!controller.signal.aborted) setProbes(list => list.map(q => q.id === p.id ? { ...q, state: "error", error: err instanceof Error ? err.message : String(err) } : q)); })
      .finally(() => probeFlights.current.delete(controller));
  };

  // The globe: area outline, the selected window's spots and the smooth score surface.
  useEffect(() => {
    const polygon = where?.type === "polygon" ? where.coordinates : null;
    const spots: GlobeOverlay["spots"] = [];
    if (win && result?.kind === "polygon") {
      spots.push({ lat: win.base.lat, lon: win.base.lon, label: `Base · ${num(win.base.site)}`, pass: true, color: "#5fd39a" });
      win.solar_spots.slice(0, 1).forEach(s => spots.push({ lat: s.lat, lon: s.lon, label: `Solar panels · ${num(s.power)}`, pass: true, color: "#ffd166" }));
      win.comm_spots.slice(0, 1).forEach(s => spots.push({ lat: s.lat, lon: s.lon, label: `Antenna · ${num(s.comm)}`, pass: true, color: "#69ceff" }));
    }
    probes.forEach((p, i) => spots.push({ lat: p.lat, lon: p.lon, label: `Spot ${String.fromCharCode(65 + i)}`, pass: true, color: "#ffffff" }));
    const surface = win && result?.kind === "polygon" && result.grid ? {
      cells: result.cells.map(c => [c.lat, c.lon] as [number, number]), cellRows: result.grid.cell_rows, cellCols: result.grid.cell_cols,
      values: win.maps[layer],
    } : null;
    onOverlay({ polygon, spots, surface });
  }, [where, result, win, layer, probes, onOverlay]);

  const fly = (s: { lat: number; lon: number; elevation_m?: number }) => onFly(s.lat, s.lon, s.elevation_m ?? 0);
  const shownCell = win && shown != null ? win.cells[shown] : win?.base ?? null;
  const shownSpot = win && shown != null ? result!.cells[shown] : win?.base ?? null;
  const p = options.power[tier], h = options.heat[profile], c = options.comm[frequency];

  return <div className="mission-search">
    <fieldset className="mission-step">
      <legend>2 · When</legend>
      <MissionRange start={mission.start} end={mission.end} onChange={onMissionChange}
        startLabel="Search from (UTC)" endLabel="Search until (UTC)" presets={[30, 60, 90, 180]} />
      <label className="inline-field">Mission length (days)<input type="text" inputMode="decimal" value={missionDays} onChange={e => setMissionDays(e.target.value)} /></label>
      <div className="link-presets" role="group" aria-label="Mission length presets">
        {[3, 7, 14, 28].map(d => <button key={d} type="button" aria-pressed={days === d} onClick={() => setMissionDays(String(d))}>{d} days</button>)}
      </div>
      <p className="mission-note">The planner tries every {missionDays || "?"}-day window inside the search period and ranks them.</p>
    </fieldset>

    <fieldset className="mission-step criteria-card">
      <legend>3 · Power</legend>
      <Choice label="Power need" value={tier} onChange={setTier}
        options={(["low", "mid", "high"] as const).map(id => ({ id, label: options.power[id].label }))} />
      <label className="check-row"><input type="checkbox" checked={tracking} onChange={e => setTracking(e.target.checked)} />Panels turn to follow the Sun</label>
      <details>
        <summary>Advanced power</summary>
        <div className="advanced-grid">
          <label>Energy needed over the mission (kWh)<input type="text" inputMode="decimal" placeholder={num(p.load_w * (days || 0) * 24 / 1000)} value={power.energy} onChange={e => setPower({ ...power, energy: e.target.value })} /></label>
          <label>Panel area (m²)<input type="text" inputMode="decimal" placeholder={String(p.panel_area_m2)} value={power.area} onChange={e => setPower({ ...power, area: e.target.value })} /></label>
          <label>Panel efficiency (%)<input type="text" inputMode="decimal" placeholder={String(options.efficiency * 100)} value={power.efficiency} onChange={e => setPower({ ...power, efficiency: e.target.value })} /></label>
          <label>Battery (hours of load)<input type="text" inputMode="decimal" placeholder={String(p.battery_hours)} value={power.battery} onChange={e => setPower({ ...power, battery: e.target.value })} /></label>
        </div>
        <p className="mission-note">Defaults for this tier: {p.load_w.toLocaleString("en")} W average load, {p.panel_area_m2} m² of panels. Leave a field empty to use its default.</p>
      </details>
    </fieldset>

    <fieldset className="mission-step criteria-card">
      <legend>4 · Heat</legend>
      <Choice label="Who or what must survive" value={profile} onChange={setProfile}
        options={(["crewed", "robotic", "cold_science"] as const).map(id => ({ id, label: options.heat[id].label }))} />
      <details>
        <summary>Advanced heat</summary>
        <div className="advanced-grid">
          <label>Lowest surface temperature (K)<input type="text" inputMode="decimal" placeholder={String(h.min_k)} value={heat.min} onChange={e => setHeat({ ...heat, min: e.target.value })} /></label>
          <label>Highest surface temperature (K)<input type="text" inputMode="decimal" placeholder={String(h.max_k)} value={heat.max} onChange={e => setHeat({ ...heat, max: e.target.value })} /></label>
        </div>
      </details>
    </fieldset>

    <fieldset className="mission-step criteria-card">
      <legend>5 · Communication</legend>
      <Choice label="How often to talk to Earth" value={frequency} onChange={setFrequency}
        options={(["high", "mid", "low"] as const).map(id => ({ id, label: options.comm[id].label }))} />
      <details>
        <summary>Advanced communication</summary>
        <div className="advanced-grid">
          <label>Earth in view at least (%)<input type="text" inputMode="decimal" placeholder={String(c.min_visible_fraction * 100)} value={comm.share} onChange={e => setComm({ ...comm, share: e.target.value })} /></label>
          <label>Longest blackout allowed (h)<input type="text" inputMode="decimal" placeholder={String(c.max_blackout_hours)} value={comm.blackout} onChange={e => setComm({ ...comm, blackout: e.target.value })} /></label>
        </div>
      </details>
      <label className="inline-field">Steepest ground for the base (°)<input type="text" inputMode="decimal" value={slope} onChange={e => setSlope(e.target.value)} /></label>
    </fieldset>

    {problem && <p className="link-hint">{problem}</p>}
    <button type="button" className="mission-run" disabled={!where || Boolean(problem) || busy} onClick={run}>
      {busy ? "Searching…" : "Find the best windows"}</button>
    {busy && <div role="status" className="search-progress">
      <progress max={1} value={progress?.fraction ?? 0} />
      <span>{progress ? `${progress.cells} spot${progress.cells === 1 ? "" : "s"} · ${Math.round(progress.fraction * 100)}%` : "Starting…"}</span>
    </div>}
    {error && <p role="alert">{error}</p>}

    {result && win && <section className="search-results" aria-label="Search results">
      <p className="mission-verdict">Best {result.period.mission_days}-day window: <strong>{span(win.start, win.end)}</strong> · score <strong style={{ color: scoreColor(result.windows[0].score) }}>{num(result.windows[0].score)}</strong></p>
      <Timeline result={result} selected={selected} onSelect={i => { setSelected(i); setShown(null); }} />
      <ol className="window-list" aria-label="Best windows">
        {result.windows.map((w, i) => <li key={w.index}>
          <button type="button" aria-pressed={i === selected} onClick={() => { setSelected(i); setShown(null); }}>
            <span className="window-rank">#{i + 1}</span>
            <span className="window-dates">{span(w.start, w.end)}</span>
            <strong style={{ color: scoreColor(w.score) }}>{num(w.score)}</strong>
            <span className="window-bars"><Bar label="Power" value={w.parts.power} /><Bar label="Heat" value={w.parts.heat} /><Bar label="Comm" value={w.parts.comm} /></span>
          </button>
        </li>)}
      </ol>

      {result.kind === "polygon" ? <>
        <div className="map-layer">
          <label>Map on the Moon<select value={layer} onChange={e => setLayer(e.target.value as Layer)}>
            {LAYERS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select></label>
          <span className="map-legend" aria-label="Colour scale from 0 to 100">0<i />100</span>
        </div>
        <p className="mission-note">Window #{selected + 1}: the coloured surface on the Moon shows each place's score, smoothed between {result.cells.length} samples. The base can be at one spot while the panels and antenna stand at others in the area.</p>
        <div className="spot-columns">
          <SpotList title="Base site" spots={[win.base]} field="site" onFly={fly} onShow={s => setShown(s.cell)} shown={shown ?? win.base.cell} />
          <SpotList title="Solar panels" spots={win.solar_spots} field="power" onFly={fly} onShow={s => setShown(s.cell)} shown={shown} />
          <SpotList title="Antenna" spots={win.comm_spots} field="comm" onFly={fly} onShow={s => setShown(s.cell)} shown={shown} />
        </div>
      </> : null}

      {shownCell && shownSpot && <details className="mission-criteria" open>
        <summary>How {result.kind === "polygon" ? `${shownSpot.lat.toFixed(4)}°, ${shownSpot.lon.toFixed(4)}°` : "this site"} does in window #{selected + 1}</summary>
        <Criteria cell={shownCell} needs={result.needs} needKwh={result.need_kwh} />
      </details>}

      <div className="probe-box">
        <h4>Compare other spots</h4>
        <p className="mission-note">Click anywhere on the Moon: you get an estimate from the nearby samples at once, and can compute the spot exactly.</p>
        <button type="button" aria-pressed={probing} onClick={() => onProbe(!probing)}>{probing ? "Cancel: click the Moon…" : "Pick a spot on the Moon"}</button>
        {probes.length > 0 && <table className="probe-table" aria-label="Compared spots">
          <thead><tr><th>Spot</th><th>Window #{selected + 1}</th><th>Power</th><th>Heat</th><th>Comm</th><th>Its best window</th><th /></tr></thead>
          <tbody>{probes.map((pr, i) => {
            const exact = pr.result;
            const at = exact ? exact.timeline.starts.indexOf(win.start) : -1;
            const row = exact && at >= 0
              ? { site: exact.timeline.score[at], power: exact.timeline.power[at], heat: exact.timeline.heat[at], comm: exact.timeline.comm[at] }
              : { site: estimate(result.cells, win.maps.site, pr.lat, pr.lon), power: estimate(result.cells, win.maps.power, pr.lat, pr.lon),
                heat: estimate(result.cells, win.maps.heat, pr.lat, pr.lon), comm: estimate(result.cells, win.maps.comm, pr.lat, pr.lon) };
            return <tr key={pr.id}>
              <td><button type="button" className="spot-name" onClick={() => onFly(pr.lat, pr.lon, pr.elevation)}>Spot {String.fromCharCode(65 + i)}</button>
                <small>{pr.lat.toFixed(4)}°, {pr.lon.toFixed(4)}°</small></td>
              <td style={{ color: scoreColor(row.site) }}>{num(row.site)}{!exact && <small> est.</small>}</td>
              <td>{num(row.power)}</td><td>{num(row.heat)}</td><td>{num(row.comm)}</td>
              <td>{exact?.windows[0] ? <>{span(exact.windows[0].start, exact.windows[0].end)} · {num(exact.windows[0].score)}</> : pr.state === "error" ? <span className="fail">{pr.error}</span> : "–"}</td>
              <td>{pr.state === "estimate" && <button type="button" onClick={() => computeProbe(pr)}>Compute exactly</button>}
                {pr.state === "loading" && <span role="status">Computing…</span>}</td>
            </tr>;
          })}</tbody>
        </table>}
      </div>

      <details className="mission-criteria">
        <summary>What the scores mean</summary>
        <ul className="mission-plain">
          <li>Each criterion scores 0–100 per spot and window. Power: panel energy against the energy needed, reduced when darkness lasts longer than the battery. Heat: share of the time the surface stays in the allowed range. Communication: Earth in view against the required share, reduced when a blackout lasts longer than allowed.</li>
          <li>A window's score averages the base site's heat with the best power spot and the best antenna spot in the area. A base steeper than the limit scores 0.</li>
          <li>Windows start every {result.window_stride_hours} h; the time step is {result.step_hours} h. Your needs: {result.needs.labels.power}, {result.needs.labels.heat}, {result.needs.labels.communication}.</li>
          {result.limitations.map(l => <li key={l}>{l}</li>)}
        </ul>
      </details>
    </section>}
  </div>;
}
