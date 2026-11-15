import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobeOptions } from "./globe/createLunarViewer";
import { fetchPositions, fetchSites, fetchTerrainManifest, type Positions, type Site, type TerrainManifest } from "./api/client";
import { LunarGlobe } from "./components/LunarGlobe";
import { EarthLinkPanel } from "./components/EarthLinkPanel";
import { MissionRange } from "./components/MissionRange";
import { SunPanel } from "./components/SunPanel";
import { addDays } from "./mission";

function App() {
  const [body, setBody] = useState<"moon" | "earth">("moon");
  const activeBody=useRef<"moon"|"earth">("moon");
  const [target, setTarget] = useState<GlobeOptions["target"]>(null);
  const [flyToTarget, setFlyToTarget] = useState(0);
  const [flightMode, setFlightMode] = useState<"site" | "terrain">("site");
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [terrain, setTerrain] = useState<TerrainManifest | null>(null);
  const [terrainError, setTerrainError] = useState<string | null>(null);
  const [terrainRegion, setTerrainRegion] = useState("");
  const [sites, setSites] = useState<Site[]>([]);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [lat, setLat] = useState("-89.45");
  const [lon, setLon] = useState("129.2");
  const [height, setHeight] = useState("0");
  const [mission, setMission] = useState(() => { const start = new Date().toISOString().slice(0, 16); return { start, end: addDays(start, 7) }; });
  const [request, setRequest] = useState<{lat: number; lon: number; height: number; at: string} | null>(null);
  const [data, setData] = useState<Positions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSites().then(value => { if (!cancelled) setSites(value.filter(site => site.slug.startsWith("pgda-78-"))); })
      .catch((err: unknown) => { if (!cancelled) setSiteError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchTerrainManifest(controller.signal).then(manifest => {
      if(controller.signal.aborted)return;
      setTerrain(manifest);
      const mosaic=manifest.regions.find(region=>region.product_id===81);
      if(mosaic && activeBody.current === "moon") {
        setTerrainRegion(mosaic.region_id);setTarget(mosaic.center);setFlightMode("terrain");
        setLat(mosaic.center.latitude.toFixed(6));setLon(mosaic.center.longitude.toFixed(6));setHeight(mosaic.center.elevation.toFixed(2));
      }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setTerrainError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    fetchPositions(request.lat, request.lon, request.height, request.at, controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request]);

  const chooseSite = (id: string) => {
    setSelected(id); setData(null); setRequest(null); setLoading(false);
    const site = sites.find(item => String(item.id) === id);
    if (site) {
      setLat(String(site.lat_deg)); setLon(String(site.lon_deg)); setHeight(String(site.elevation_m ?? 0));
      setTarget({latitude:site.lat_deg,longitude:site.lon_deg,elevation:site.elevation_m ?? 0});
      setFlightMode("terrain");setFlyToTarget(value=>value+1);setTerrainEnabled(true);
    }
  };
  const pickSpot = (latitude: number, longitude: number, elevation: number) => {
    setSelected(""); setData(null); setRequest(null); setLoading(false); setError(null);
    setLat(String(latitude)); setLon(String(longitude)); setHeight(String(elevation));
    setTarget({ latitude, longitude, elevation });
    setFlightMode("terrain"); setFlyToTarget(value => value + 1); setTerrainEnabled(true);
  };
  const dirty = () => { setData(null); setRequest(null); setLoading(false); setError(null); };
  const globeOptions = useMemo(() => ({ body, target, flyToTarget, flightMode, terrainEnabled, terrainRegion }), [body, target, flyToTarget, flightMode, terrainEnabled, terrainRegion]);

  return <main>
    <LunarGlobe sites={sites} positions={data} options={globeOptions} onSiteSelect={chooseSite}>
    <header><p className="eyebrow">LUNAR MISSION EXPLORER</p><h1>Lunar Planner</h1><p>Explore sunlight and Earth visibility from the Moon.</p></header>
    <form className="controls" onSubmit={event => {
      event.preventDefault();
      setTarget({ latitude: Number(lat), longitude: Number(lon), elevation: Number(height) });
      setFlightMode("site");
      setFlyToTarget(value => value + 1);
    }}>
      <label>Explore<select value={body} onChange={e => {
        const next = e.target.value as "moon" | "earth";
        activeBody.current=next;
        setBody(next); dirty(); setSelected(""); setTarget(null);
        setTerrainRegion(next === "moon" ? terrain?.regions.find(region=>region.product_id===81)?.region_id ?? "" : "");
        setLat(next === "moon" ? "-89.45" : "31.7683");
        setLon(next === "moon" ? "129.2" : "35.2137"); setHeight("0");
      }}><option value="moon">Moon</option><option value="earth">Earth</option></select></label>
      {body === "moon" && <div className="terrain-controls">
        <label className="terrain-toggle"><input type="checkbox" checked={terrainEnabled} onChange={e => setTerrainEnabled(e.target.checked)} />3D elevation terrain</label>
        {terrain && <>
          <p>{terrain.regions.some(region=>region.product_id===81)?"Product 81 · Continuous coverage, 87–90°S. Local 50 m overview with cached 5 m detail.":`${terrain.regions.length} prepared regions · Select one for 5 m detail.`}</p>
        </>}
        {terrainError && <p role="status">3D terrain unavailable: {terrainError}. Showing the reference sphere.</p>}
      </div>}
      {body === "moon" && <label>Named LOLA location<select value={selected} onChange={event => chooseSite(event.target.value)}>
        <option value="">Custom coordinates</option>
        {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>}
      <label>Latitude (° north)<input required type="number" min="-90" max="90" step="any" value={lat} onChange={e => { dirty(); setSelected(""); setLat(e.target.value); }} /></label>
      <label>Longitude (° east)<input required type="number" min="-180" max="180" step="any" value={lon} onChange={e => { dirty(); setSelected(""); setLon(e.target.value); }} /></label>
      <label>Altitude above {body === "moon" ? "lunar" : "Earth"} ellipsoid (m)<input required type="number" min="-20000" max="20000" step="any" value={height} onChange={e => { dirty(); setHeight(e.target.value); }} /></label>
      <button type="submit">Fly to coordinates</button>
      {body === "moon" && <>
      <fieldset className="mission-range">
        <legend>Mission time range</legend>
        <MissionRange start={mission.start} end={mission.end} onChange={(start, end) => { dirty(); setMission({ start, end }); }} />
      </fieldset>
      <button type="button" disabled={loading || !mission.start} onClick={event => {
        if (!event.currentTarget.form?.reportValidity()) return;
        setTarget({ latitude: Number(lat), longitude: Number(lon), elevation: Number(height) });
      setRequest({ lat: Number(lat), lon: Number(lon), height: Number(height), at: `${mission.start}:00Z` });
      }}>{loading ? "Querying JPL Horizons…" : "Show Sun & Earth at mission start"}</button>
      </>}
    </form>
    {selected && <p className="banner">{sites.find(s => String(s.id) === selected)?.notes}</p>}
    {siteError && <p role="alert">Could not load sites: {siteError}. Custom coordinates remain available.</p>}
    {loading && <p role="status">Fetching Sun and Earth positions from JPL Horizons…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !loading && <p>Enter coordinates and fly to the location. On the Moon, load Sun & Earth to look toward them from the site.</p>}
    {body === "moon" && <section className="mission-panel" aria-labelledby="mission-heading">
      <h2 id="mission-heading">Mission checks</h2>
      <p>Both checks use the mission time range and the location above.</p>
      <EarthLinkPanel key={`earth|${lat}|${lon}|${mission.start}|${mission.end}`} lat={Number(lat)} lon={Number(lon)} start={mission.start} end={mission.end} />
      <SunPanel key={`sun|${lat}|${lon}|${mission.start}|${mission.end}`} lat={Number(lat)} lon={Number(lon)} start={mission.start} end={mission.end} onPick={pickSpot} />
    </section>}
    </LunarGlobe>
  </main>;
}
export default App;
