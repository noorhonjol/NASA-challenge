import { useEffect, useRef, useState } from "react";
import { fetchPlanning, type Equipment, type PlanningPoint, type PlanningResponse, type PlanningResult, type Site } from "../api/client";

type Mode = "power" | "analysis" | "windows";
const utc = (value: string) => new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
const n = (value: number) => value.toLocaleString(undefined, {maximumFractionDigits: 2});

export function PlanningPanel({point, at, sites, onClose}: {point: PlanningPoint; at: string; sites: Site[]; onClose: () => void}) {
  const [initialAt] = useState(() => Number.isFinite(Date.parse(`${at}:00Z`)) ? at : new Date().toISOString().slice(0, 16));
  const [mode, setMode] = useState<Mode>("power");
  const [area, setArea] = useState("points");
  const [selectedSites, setSelectedSites] = useState<number[]>([]);
  const [result, setResult] = useState<PlanningResponse | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const results = result?.results ?? (result?.samples ? [result as PlanningResult] : []);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const number = (key: string) => Number(data.get(key));
    const equipment: Equipment = {
      load_w: number("load"), panel_area_m2: number("panel"), panel_efficiency: number("efficiency")/100,
      system_efficiency: number("system")/100, panel_mode: data.get("tracking") as Equipment["panel_mode"],
      battery_wh: number("battery"), usable_battery_fraction: number("usable")/100,
      minimum_earth_elevation_deg: number("earth"), require_earth_visibility: data.has("communication"),
    };
    const location = {lat: number("lat"), lon: number("lon")};
    const start = `${data.get("start")}:00Z`;
    const end = `${data.get("end")}:00Z`;
    const step_hours = number("step");
    const grid = {south: number("south"), north: number("north"), west: number("west"), east: number("east"),
      rows: number("rows"), columns: number("columns")};
    const points = [location, ...sites.filter(site => selectedSites.includes(site.id)).map(site => ({lat: site.lat_deg, lon: site.lon_deg}))];
    const duration = mode === "power" ? number("duration") : (Date.parse(end)-Date.parse(start))/3600000;
    const combinations = (Math.ceil(duration/step_hours)+1) * (mode === "analysis" ? area === "grid" ? grid.rows*grid.columns : points.length : 1);
    if (duration <= 0 || duration > 8784 || !Number.isFinite(duration)) {setError("Choose an end after the start, within 366 days."); return;}
    if (combinations > 128) {setError(`This selection needs ${combinations} point/time samples. Maximum 128: increase the step, shorten the range or reduce the grid/sites.`); return;}
    if (mode === "analysis" && area === "grid" && (grid.south >= grid.north || grid.west >= grid.east)) {setError("Grid south must be below north, and west below east. Split areas crossing the antimeridian."); return;}
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(""); setResult(null); setActive(0);
    const payload = mode === "power" ? {point: location, at: start, duration_hours: duration, step_hours, equipment}
      : mode === "windows" ? {point: location, start, end, step_hours, equipment, minimum_duration_hours: number("minimum")}
      : {start, end, step_hours, equipment, ...(area === "grid" ? {grid} : {points})};
    try {
      const response = await fetchPlanning(mode, payload, request.signal);
      if (!request.signal.aborted) setResult(response);
    } catch (err) {if (!request.signal.aborted) setError(err instanceof Error ? err.message : String(err));}
    finally {if (!request.signal.aborted) setBusy(false);}
  }

  const field = (label: string, name: string, value: number, min: number, max: number, step: number | "any" = "any") =>
    <label key={name}>{label}<input name={name} type="number" required defaultValue={value} min={min} max={max} step={step}/></label>;

  return <section id="mission-planner" className="planning-panel" aria-label="Mission power planner">
    <div className="panel-heading"><div><p className="eyebrow">MISSION SCREENING</p><h1>Power & operating windows</h1></div><button type="button" className="panel-toggle" onClick={onClose}>Close planner</button></div>
    <div className="planning-content">
      <p>Compare solar power and direct-to-Earth visibility. All dates and results use UTC.</p>
      <form onSubmit={event => {event.preventDefault(); void submit(event.currentTarget);}} onChange={() => {controller.current?.abort(); setBusy(false); setResult(null); setError("");}}>
        <label>Planning task<select value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="power">Mission power estimate</option><option value="analysis">Compare sites / area</option><option value="windows">Find equipment operating windows</option></select></label>
        <fieldset><legend>Location</legend><div className="planning-fields">
          {field("Planner latitude (° north)", "lat", point.lat, -90, 90)}
          {field("Planner longitude (° east)", "lon", point.lon, -180, 180)}
        </div><p>Elevation is determined automatically from local LOLA data for each coordinate: native 5 m south-pole mosaic within coverage, coarser global LOLA elsewhere.</p>
        {mode === "analysis" && <>
          <label>Compare using<select value={area} onChange={event => setArea(event.target.value)}><option value="points">This point + named locations</option><option value="grid">Rectangular grid</option></select></label>
          {area === "points" ? <div className="planning-sites">{sites.length ? sites.map(site => <label className="planning-check" key={site.id}><input type="checkbox" checked={selectedSites.includes(site.id)} onChange={event => setSelectedSites(ids => event.target.checked ? [...ids, site.id] : ids.filter(id => id !== site.id))}/>{site.name}</label>) : <p>No named locations available. Use a grid to compare custom locations.</p>}</div>
            : <div className="planning-fields">{field("South bound (°)", "south", -89.5, -90, 90)}{field("North bound (°)", "north", -89, -90, 90)}{field("West bound (°)", "west", 0, -180, 180)}{field("East bound (°)", "east", 1, -180, 180)}{field("Grid rows", "rows", 2, 2, 8, 1)}{field("Grid columns", "columns", 2, 2, 8, 1)}</div>}
        </>}
        </fieldset>
        <fieldset><legend>Schedule · UTC</legend><div className="planning-fields">
          <label>Start (UTC)<input name="start" required type="datetime-local" defaultValue={initialAt} min="1550-01-01T00:00" max="2649-12-31T23:59"/></label>
          {mode === "power" ? field("Mission duration (hours)", "duration", 24, 0.25, 8784)
            : <label>End (UTC)<input name="end" required type="datetime-local" defaultValue={new Date(Date.parse(`${initialAt}:00Z`)+86400000).toISOString().slice(0,16)} min="1550-01-01T00:00" max="2649-12-31T23:59"/></label>}
          {field("Sampling step (hours)", "step", 6, 0.25, 168)}
          {mode === "windows" && field("Minimum window (hours)", "minimum", 1, 0.25, 8784)}
        </div></fieldset>
        <fieldset><legend>Equipment & power</legend><div className="planning-fields">
          {field("Continuous load (W)", "load", 100, 0.01, 1e7)}
          {field("Solar panel area (m²)", "panel", 4, 0.001, 1e6)}
          {field("Panel efficiency (%)", "efficiency", 30, 0.01, 100)}
          {field("System efficiency (%)", "system", 85, 0.01, 100)}
          {field("Battery capacity (Wh)", "battery", 2000, 0, 1e12)}
          {field("Usable battery (%)", "usable", 80, 0.01, 100)}
          <label>Panel orientation<select name="tracking"><option value="horizontal">Horizontal</option><option value="sun_tracking">Ideal Sun tracking</option></select></label>
          {field("Minimum Earth elevation (°)", "earth", 0, 0, 90)}
        </div><label className="planning-check"><input type="checkbox" name="communication" defaultChecked/>Require Earth visibility for operating windows</label>
        <p>Include heaters, instruments and communications in the continuous load.</p></fieldset>
        <p>Up to 128 point/time samples. Live Horizons queries may take several minutes. Terrain shadows, eclipses, thermal effects and communication link budgets are excluded.</p>
        <div className="planning-actions"><button className="planning-run" disabled={busy} type="submit">{busy ? "Calculating…" : "Run planning analysis"}</button>{busy && <button type="button" onClick={() => {controller.current?.abort(); setBusy(false);}}>Cancel</button>}</div>
      </form>
      {busy && <p role="status">Querying JPL Horizons for each point and time…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <section aria-label="Planning results" aria-live="polite"><h2>Analysis results · {result.source}</h2>
        <div className="planning-table"><table><caption>Site comparison · select a row to inspect</caption><thead><tr><th>Location (lat, lon)</th><th>LOLA elevation (m)</th><th>Solar energy (Wh)</th><th>Load (Wh)</th><th>Battery needed (Wh)</th><th>Supplied battery</th></tr></thead><tbody>{results.map((item, i) => <tr key={i} className={active === i ? "is-selected" : ""}><th><button type="button" onClick={() => setActive(i)} aria-pressed={active === i}>{n(item.point.lat)}°, {n(item.point.lon)}°</button></th><td>{n(item.point.elevation_m)}</td><td>{n(item.summary.generated_energy_wh)}</td><td>{n(item.summary.load_energy_wh)}</td><td>{n(item.summary.minimum_nameplate_battery_wh)}</td><td>{item.summary.battery_sufficient_if_initially_full ? "Sufficient if full" : "Insufficient"}</td></tr>)}</tbody></table></div>
        {results[active] && <ResultDetails result={results[active]}/>}
        <details><summary>Model assumptions & sources</summary><ul>{result.assumptions.map(text => <li key={text}>{text}</li>)}</ul><a href={result.solar_reference_url}>Solar irradiance reference</a></details>
      </section>}
    </div>
  </section>;
}

function ResultDetails({result}: {result: PlanningResult}) {
  const {samples, summary} = result;
  const maximum = Math.max(1, ...samples.map(s => s.generated_power_w), ...samples.map(s => s.load_w));
  const start = Date.parse(samples[0].at_utc);
  const span = Math.max(1, Date.parse(samples.at(-1)!.at_utc)-start);
  const x = (at: string) => 45+550*(Date.parse(at)-start)/span;
  const y = (power: number) => 155-125*power/maximum;
  return <>
    <p>Surface elevation: {n(result.point.elevation_m)} m · {result.elevation.dataset} · {result.elevation.resolution_m !== undefined ? `${n(result.elevation.resolution_m)} m native spacing` : `${n(result.elevation.resolution_deg ?? 0)}° spacing`} · {result.elevation.frame}. Terrain height is used for the observer position; terrain shadows remain excluded.</p>
    <div className="metrics"><article><h3>Net energy</h3><strong>{n(summary.net_energy_wh)} Wh</strong></article><article><h3>Required initial usable energy</h3><strong>{n(summary.minimum_initial_usable_energy_wh)} Wh</strong></article></div>
    <figure className="planning-chart"><figcaption>Solar generation & continuous load (W)</figcaption><svg viewBox="0 0 640 190" role="img" aria-label="Power over time. Gold shows generation; dashed blue shows equipment load. Exact values are in the sample table.">
      <line x1="45" y1="155" x2="595" y2="155" stroke="#607389"/>
      <text x="2" y="30">{n(maximum)}</text><text x="20" y="155">0</text>
      <polyline fill="none" stroke="#f6ce70" strokeWidth="3" points={samples.map(s => `${x(s.at_utc)},${y(s.generated_power_w)}`).join(" ")}/>
      <line x1="45" x2="595" y1={y(samples[0].load_w)} y2={y(samples[0].load_w)} stroke="#91dbff" strokeWidth="2" strokeDasharray="6 4"/>
      <text x="45" y="180">Start</text><text x="565" y="180">End</text>
    </svg><p>Gold: generation · Dashed blue: load. {utc(samples[0].at_utc)} → {utc(samples.at(-1)!.at_utc)}</p></figure>
    <h2>Operating windows</h2><p>Solar generation must meet load. Battery storage does not extend these sampled windows; actual transition times are unresolved.</p>
    {result.operating_windows.length ? <ul className="planning-windows">{result.operating_windows.map(window => <li key={window.start}>{utc(window.start)} → {utc(window.end)}<strong>{n(window.duration_hours)} hours</strong></li>)}</ul> : <p className="banner">No operating windows meet your constraints at this sampling resolution. Try another site, date range, equipment setup or smaller sampling step.</p>}
    <details><summary>Inspect {samples.length} time samples</summary><div className="planning-table"><table><caption>UTC positions and electrical power</caption><thead><tr><th>Time (UTC)</th><th>Sun elevation</th><th>Earth elevation</th><th>Panel flux (W/m²)</th><th>Generation (W)</th><th>Net (W)</th><th>Required panel (m²)</th><th>Constraints met</th></tr></thead><tbody>{samples.map(sample => <tr key={sample.at_utc}><th>{utc(sample.at_utc)}</th><td>{n(sample.sun.elevation_deg)}°</td><td>{n(sample.earth.elevation_deg)}°</td><td>{n(sample.panel_irradiance_w_m2)}</td><td>{n(sample.generated_power_w)}</td><td>{n(sample.net_power_w)}</td><td>{sample.required_panel_area_m2 === null ? "No sunlight" : n(sample.required_panel_area_m2)}</td><td>{sample.meets_operating_constraints ? "Yes" : "No"}</td></tr>)}</tbody></table></div></details>
  </>;
}
