import { useEffect, useRef, useState } from "react";
import type { Positions } from "../api/client";
import type { SurfaceStatus } from "../globe/orbitCamera";
import { fetchSkyTrack, positionsAt, trackEnd, trackStart, type SkyTrack } from "../globe/skyTrack";

const SPEEDS = [
  { seconds: 600, label: "10 min/s" },
  { seconds: 3600, label: "1 h/s" },
  { seconds: 6 * 3600, label: "6 h/s" },
  { seconds: 86400, label: "1 day/s" },
];
type Follow = "none" | "sun" | "earth";
const STEP_MS = 30 * 60000;
const R = 1737400, RAD = Math.PI / 180;
const metresBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.acos(Math.min(1, Math.sin(a.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((a.lon - b.lon) * RAD))) * R;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const fmt = (b: Positions["sun"]) => `${b.elevation_deg >= 0 ? "▲" : "▼"} ${b.elevation_deg.toFixed(2)}° · az ${b.azimuth_deg.toFixed(1)}°`;

/**
 * Stellarium-style time control for the spot you stand on: 30 days of Sun and Earth positions
 * (JPL Horizons, every 30 min) loaded once, then a slider, play/pause and "keep centred".
 */
export function SkyTimePanel({ status, onPositions, onLook, onClose }: {
  status: SurfaceStatus;
  onPositions: (positions: Positions | null) => void;
  onLook: (azimuthDeg: number, elevationDeg: number) => void;
  onClose: () => void;
}) {
  const [track, setTrack] = useState<SkyTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3600);
  const [follow, setFollow] = useState<Follow>("none");
  const inFlight = useRef<AbortController | null>(null);
  // Current values for handlers and the play loop (never read during render).
  const live = useRef<{ track: SkyTrack | null; time: number; follow: Follow }>({ track: null, time: 0, follow: "none" });

  /**
   * Move to time `t`: update the panel, the drawn sky and (when following) the camera.
   * Called from event handlers and animation frames, not from an effect, so a running
   * clock never chains state updates through effects.
   */
  const show = (t: number) => {
    const tr = live.current.track;
    if (!tr) return;
    live.current.time = t;
    setTime(t);
    const p = positionsAt(tr, t);
    onPositions(p);
    const f = live.current.follow;
    if (f !== "none") onLook(p[f].azimuth_deg, p[f].elevation_deg);
  };

  /** Fetch 30 days from now for (lat, lon); state changes happen when the request settles. */
  const request = (lat: number, lon: number, ground: number) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const start = new Date(Math.floor(Date.now() / STEP_MS) * STEP_MS);
    fetchSkyTrack(lat, lon, ground, start, controller.signal)
      .then(t => { if (!controller.signal.aborted) { live.current.track = t; setTrack(t); setError(null); show(trackStart(t)); } })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  };
  /** "Load the sky for this spot" after walking away from where the track was computed. */
  const reload = () => { setLoading(true); setError(null); setPlaying(false); request(status.latitude, status.longitude, status.groundM); };
  // Load once for the spot where the panel opened; clear the drawn sky when it closes.
  const opened = useRef(status);
  useEffect(() => {
    request(opened.current.latitude, opened.current.longitude, opened.current.groundM);
    return () => { inFlight.current?.abort(); onPositions(null); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Play: advance simulated time at `speed` seconds per real second.
  useEffect(() => {
    if (!playing || !track) return;
    let last = performance.now(), frame = 0;
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      const next = live.current.time + dt * speed * 1000;
      if (next >= trackEnd(track)) { show(trackEnd(track)); setPlaying(false); return; }
      show(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, track]); // eslint-disable-line react-hooks/exhaustive-deps

  const moved = track ? metresBetween({ lat: track.latitude_deg, lon: track.longitude_deg }, { lat: status.latitude, lon: status.longitude }) : 0;
  const p = track ? positionsAt(track, time) : null;
  return <section className="sky-panel" aria-label="Sky and time">
    <div className="sky-head">
      <strong>Sky &amp; time</strong>
      <span>{track ? utc(time) : loading ? "Loading 30 days of Sun and Earth positions…" : ""}</span>
      <button type="button" onClick={onClose} aria-label="Close sky and time">×</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {track && p && <>
      <input type="range" aria-label="Time" min={trackStart(track)} max={trackEnd(track)} step={60000} value={time}
        onChange={e => { setPlaying(false); show(Number(e.target.value)); }} />
      <div className="sky-controls">
        <button type="button" onClick={() => { if (time >= trackEnd(track)) show(trackStart(track)); setPlaying(v => !v); }}>{playing ? "Pause" : "Play"}</button>
        <label>Speed<select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
          {SPEEDS.map(s => <option key={s.seconds} value={s.seconds}>{s.label}</option>)}
        </select></label>
        <div className="sky-follow" role="group" aria-label="Keep centred">
          <span>Keep centred:</span>
          {(["none", "sun", "earth"] as const).map(f => <button key={f} type="button" aria-pressed={follow === f} onClick={() => { live.current.follow = f; setFollow(f); show(live.current.time); }}>
            {f === "none" ? "Off" : f === "sun" ? "Sun" : "Earth"}</button>)}
        </div>
      </div>
      <div className="sky-readout">
        <span className="sky-sun">Sun {fmt(p.sun)}</span>
        <span className="sky-earth">Earth {fmt(p.earth)}</span>
      </div>
      {moved > 500 && <button type="button" className="sky-reload" onClick={reload} disabled={loading}>
        You moved {(moved / 1000).toFixed(1)} km: load the sky for this spot</button>}
      <p className="sky-note">Positions from JPL Horizons every 30 min for 30 days, interpolated in between. Elevations are against a level horizon; nearby terrain can still hide the Sun or Earth.</p>
    </>}
  </section>;
}
