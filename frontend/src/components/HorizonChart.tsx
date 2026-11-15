import { useEffect, useState } from "react";
import { fetchSkyView, type SkyView } from "../api/mission";

const W = 420, H = 170, PAD_L = 30, PAD_B = 18, PAD_T = 8;

/** Where the Sun and Earth move relative to the real terrain horizon at one spot, over a period. */
export function HorizonChart({ lat, lon, start, end, heightM, title }: { lat: number; lon: number; start: string; end: string; heightM: number; title: string }) {
  const [state, setState] = useState<{ key: string; sky?: SkyView; error?: string }>({ key: "" });
  const key = `${lat},${lon},${start},${end},${heightM}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchSkyView(lat, lon, start, end, heightM, controller.signal)
      .then(sky => setState({ key, sky }))
      .catch((err: unknown) => { if (!controller.signal.aborted) setState({ key, error: err instanceof Error ? err.message : String(err) }); });
    return () => controller.abort();
  }, [key, lat, lon, start, end, heightM]);
  const sky = state.key === key ? state.sky : undefined;
  if (state.key === key && state.error) return <p role="alert">{state.error}</p>;
  if (!sky) return <p className="mission-note" role="status">Loading the horizon…</p>;

  const all = [...sky.skyline_deg, ...sky.sun.elevation_deg, ...sky.earth.elevation_deg];
  const lo = Math.max(-10, Math.floor(Math.min(-1, ...all))), hi = Math.min(20, Math.ceil(Math.max(2, ...all) + 0.5));
  const x = (az: number) => PAD_L + az / 360 * (W - PAD_L - 4);
  const y = (el: number) => PAD_T + (hi - el) / (hi - lo) * (H - PAD_T - PAD_B);
  const ground = `M${x(0)},${H - PAD_B} ` + sky.skyline_deg.map((el, az) => `L${x(az).toFixed(1)},${y(el).toFixed(1)}`).join(" ")
    + ` L${x(360)},${y(sky.skyline_deg[0]).toFixed(1)} L${x(360)},${H - PAD_B} Z`;
  const sunUp = sky.sun.visible_fraction.filter(v => v > 0).length / sky.times.length;
  const earthUp = sky.earth.visible.filter(Boolean).length / sky.times.length;
  const ticks = [];
  for (let el = Math.ceil(lo); el <= hi; el += hi - lo > 10 ? 5 : 2) ticks.push(el);
  return <figure className="horizon-chart">
    <figcaption>{title}<span>{sky.height_m} m above the ground</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Terrain horizon with the Sun above it ${Math.round(sunUp * 100)}% and Earth ${Math.round(earthUp * 100)}% of the time`}>
      {ticks.map(t => <g key={t}><line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
        <text x={PAD_L - 4} y={y(t) + 3} textAnchor="end">{t}°</text></g>)}
      <path d={ground} className="ground" />
      {sky.earth.azimuth_deg.map((az, i) => <circle key={`e${i}`} cx={x(az)} cy={y(sky.earth.elevation_deg[i])} r={1.6}
        className={sky.earth.visible[i] ? "earth" : "earth hidden"} />)}
      {sky.sun.azimuth_deg.map((az, i) => <circle key={`s${i}`} cx={x(az)} cy={y(sky.sun.elevation_deg[i])} r={1.6}
        className={sky.sun.visible_fraction[i] > 0 ? "sun" : "sun hidden"} />)}
      {["N", "E", "S", "W", "N"].map((d, i) => <text key={i} x={x(i * 90)} y={H - 4} textAnchor="middle">{d}</text>)}
    </svg>
    <div className="horizon-legend">
      <span><i className="sun" />Sun above the terrain {Math.round(sunUp * 100)}% of the time</span>
      <span><i className="earth" />Earth in view {Math.round(earthUp * 100)}%</span>
      <span><i className="hidden-dot" />faded: hidden behind terrain</span>
    </div>
  </figure>;
}
