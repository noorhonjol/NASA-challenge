import { useEffect, useRef, useState } from "react";
import { fetchEarthLink, stepFor, type EarthLink, type EarthLinkWindow } from "../api/client";
import { DAY_MS, hours, rangeProblem, toUtc, when } from "../mission";

const STATUS_LABEL = { available: "Earth visible", blocked: "Blocked", unknown: "Unknown" } as const;
const CAUSE_LABEL = { lunar_limb: "below the Moon's horizon", terrain: "hidden by terrain" } as const;
const WIDTH = 314;
const MAX_LISTED = 8;


function Timeline({ data }: { data: EarthLink }) {
  const t0 = Date.parse(data.period.start_utc);
  const span = Date.parse(data.period.end_utc) - t0;
  const x = (iso: string) => (Date.parse(iso) - t0) / span * WIDTH;
  const days = span / DAY_MS;
  const tickEvery = [0.25, 1, 2, 5, 10, 15, 30, 60].find(d => days / d <= 8) ?? 60;
  const ticks = Array.from({ length: Math.floor(days / tickEvery + 1e-9) + 1 }, (_, i) => i * tickEvery);
  const label = (d: number) => days <= 2 ? `+${d * 24}h`
    : new Date(t0 + d * DAY_MS).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return <svg className="link-timeline" viewBox={`0 0 ${WIDTH} 40`} role="img"
    aria-label={`Earth visible ${Math.round(data.summary.available_fraction * 100)}% of the period`}>
    <defs><pattern id="link-unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#3a4554" /><rect width="3" height="6" fill="#58667a" />
    </pattern></defs>
    {data.windows.map(w => <rect key={w.start_utc} className={`link-${w.status}`} x={x(w.start_utc)} y="2"
      width={Math.max(x(w.end_utc) - x(w.start_utc), 0.5)} height="20"
      fill={w.status === "unknown" ? "url(#link-unknown)" : undefined}>
      <title>{`${STATUS_LABEL[w.status]} · ${when(w.start_utc)} – ${when(w.end_utc)} UTC`}</title>
    </rect>)}
    {ticks.map(d => <g key={d}>
      <line x1={d / days * WIDTH} x2={d / days * WIDTH} y1="22" y2="26" stroke="#6c7e94" />
      <text x={Math.min(Math.max(d / days * WIDTH, 8), WIDTH - 8)} y="37" textAnchor="middle">
        {label(d)}
      </text>
    </g>)}
  </svg>;
}

function describe(w: EarthLinkWindow) {
  if (w.status !== "blocked" || !w.causes.length) return STATUS_LABEL[w.status];
  return `${STATUS_LABEL.blocked}: ${w.causes.map(c => CAUSE_LABEL[c]).join(", ")}`;
}

/** Results reset when the parent changes its key (location or mission range). */
export function EarthLinkPanel({ lat, lon, start, end }: { lat: number; lon: number; start: string; end: string }) {
  const [data, setData] = useState<EarthLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const check = () => {
    const from = toUtc(start), to = toUtc(end);
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true); setError(null); setData(null);
    fetchEarthLink(lat, lon, from, to, stepFor(to.getTime() - from.getTime()), controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  };

  const valid = Number.isFinite(lat) && Number.isFinite(lon) && !rangeProblem(start, end);
  const available = data?.windows.filter(w => w.status === "available") ?? [];
  const s = data?.summary;

  return <section className="link-panel" aria-labelledby="link-heading">
    <h3 id="link-heading">Earth contact windows</h3>
    <p>When Earth is in direct line of sight from this location over the mission time range.</p>
    <div className="link-controls">
      <button type="button" disabled={!valid || loading} onClick={check}>
        {loading ? "Calculating…" : "Check Earth contact"}
      </button>
    </div>
    {loading && <p role="status">Tracing Earth's path against the local terrain. This can take a few seconds.</p>}
    {error && <p role="alert">{error}</p>}
    {data && s && <>
      <Timeline data={data} />
      <ul className="link-legend" aria-hidden="true">
        <li><i className="link-available" />Visible</li><li><i className="link-blocked" />Blocked</li><li><i className="link-unknown" />Unknown</li>
      </ul>
      <div className="metrics">
        <article><h3>Earth visible</h3><strong>{Math.round(s.available_fraction * 100)}%</strong>
          <p>{hours(s.available_hours)} in {s.available_windows} window{s.available_windows === 1 ? "" : "s"}</p></article>
        <article><h3>Longest blackout</h3><strong>{hours(s.longest_blackout_hours)}</strong>
          <p>{s.first_contact_after_hours === null ? "No contact in this period" : s.first_contact_after_hours === 0 ? "Visible at the start" : `First contact after ${hours(s.first_contact_after_hours)}`}</p></article>
      </div>
      {s.unknown_hours > 0 && <p className="banner">{hours(s.unknown_hours)} could not be decided and is counted as no contact.</p>}
      {available.length > 0 && <ol className="link-windows">
        {available.slice(0, MAX_LISTED).map(w => <li key={w.start_utc}>
          <span>{when(w.start_utc)} – {when(w.end_utc)}</span><span>{hours(w.duration_hours)}</span>
        </li>)}
        {available.length > MAX_LISTED && <li className="link-more">+{available.length - MAX_LISTED} more windows</li>}
      </ol>}
      {available.length === 0 && <p>{data.windows.length === 1 ? `${describe(data.windows[0])} for the whole period.` : "Earth is not visible at any time in this period."}</p>}
      {data.warnings.map(w => <p key={w} role="status">{w}</p>)}
      <p className="attribution">
        {data.terrain_model.type === "lola"
          ? `Terrain: LOLA, ${data.terrain_model.site_resolution_m} m near the site, rays out to ${data.terrain_model.max_range_km} km.`
          : "No terrain data on the server. Only times when Earth is certainly below the horizon are marked blocked; the rest is unknown."}
        {" "}Antenna 2 m above the ground. Times in UTC. Line of sight to Earth's center only. {data.rf.note}
      </p>
    </>}
  </section>;
}
