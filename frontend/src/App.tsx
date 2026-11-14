import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobeOptions } from "./globe/createLunarViewer";
import { fetchPositions, fetchSites, fetchTerrainManifest, type Positions, type Site, type TerrainManifest } from "./api/client";
import { EnergyPlanner } from "./components/EnergyPlanner";
import { LunarGlobe } from "./components/LunarGlobe";

function App() {
  const energyDialog = useRef<HTMLDialogElement>(null);
  const [plannerSelection,setPlannerSelection] = useState<{lat:number;lon:number;at:string;name:string;key:string}|null>(null);
  const [missionPins,setMissionPins] = useState<Site[]>([]);
  const [pinPlacement,setPinPlacement] = useState(false);
  const [pinTitle,setPinTitle] = useState("");
  const nextPinId = useRef(-2);
  const navigationTouched = useRef(false);
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
  const [at, setAt] = useState(() => new Date().toISOString().slice(0, 16));
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
      if(mosaic && activeBody.current === "moon" && !navigationTouched.current) {
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

  const allSites = useMemo(() => [...sites,...missionPins],[sites,missionPins]);
  const selectedSite = allSites.find(site => String(site.id) === selected);
  const openPlanner = (site?: Site) => {
    const latitude = site?.lat_deg ?? (body === "moon" ? Number(lat) : -89.45);
    const longitude = site?.lon_deg ?? (body === "moon" ? Number(lon) : 129.2);
    const instant=Date.parse(`${at}Z`);
    if (!Number.isFinite(instant) || new Date(instant).getUTCFullYear()<2020 || new Date(instant).getUTCFullYear()>2035) {
      setError("Choose a UTC date and time between 2020 and 2035 on the pin page before calculating energy.");return;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (!site && body === "moon" && (!lat.trim() || !lon.trim()))) {
      setError("Choose valid pin coordinates before calculating energy.");return;
    }
    setError(null);
    setPlannerSelection({lat:latitude,lon:longitude,at,name:site?.name ?? "Selected coordinates",key:`${latitude}:${longitude}:${at}`});
    energyDialog.current?.showModal();
  };
  const addPin = (point: {latitude:number;longitude:number;elevation:number}) => {
    navigationTouched.current=true;
    const id=nextPinId.current--;
    const pin:Site={id,slug:`mission-pin-${-id}`,name:pinTitle.trim() || `Mission site ${-id-1}`,lat_deg:point.latitude,lon_deg:point.longitude,elevation_m:point.elevation,frame:"MOON_ME",is_fictional:false,notes:"Personal mission planning pin. Analysis uses local LOLA elevation."};
    setMissionPins(pins=>[...pins,pin]);setSelected(String(id));setPinPlacement(false);setPinTitle("");
    setLat(String(point.latitude));setLon(String(point.longitude));setHeight(String(point.elevation));
    setTarget(point);setData(null);setRequest(null);setLoading(false);setError(null);
  };
  const chooseSite = (id: string) => {
    navigationTouched.current=true;
    setSelected(id); setData(null); setRequest(null); setLoading(false);
    const site = allSites.find(item => String(item.id) === id);
    if (site) {
      setLat(String(site.lat_deg)); setLon(String(site.lon_deg)); setHeight(String(site.elevation_m ?? 0));
      setTarget({latitude:site.lat_deg,longitude:site.lon_deg,elevation:site.elevation_m ?? 0});
      setFlightMode("terrain");setFlyToTarget(value=>value+1);setTerrainEnabled(true);
    }
  };
  const dirty = () => { setData(null); setRequest(null); setLoading(false); setError(null); };
  const globeOptions = useMemo(() => ({ body, target, flyToTarget, flightMode, terrainEnabled, terrainRegion, pinPlacement }), [body, target, flyToTarget, flightMode, terrainEnabled, terrainRegion, pinPlacement]);

  return <main>
    <nav className="energy-nav" aria-label="Main navigation">
      <strong>Lunar Planner</strong>
      <button type="button" aria-current="page" onClick={() => energyDialog.current?.close()}>Globe explorer</button>
      <button type="button" aria-haspopup="dialog" aria-controls="energy-dialog" onClick={() => openPlanner(selectedSite)}>Mission planner</button>
    </nav>
    <div className="globe-workspace">
    <LunarGlobe sites={allSites} positions={data} options={globeOptions} onSiteSelect={chooseSite} onPinPlace={addPin}>
    <header><p className="eyebrow">LUNAR MISSION EXPLORER</p><h1>Lunar Planner</h1><p>Explore sunlight and Earth visibility from the Moon.</p></header>
    {body === "moon" && selectedSite && <article className="mission-pin-tile" aria-label="Selected mission pin">
      <p className="eyebrow">SELECTED SITE</p><h2>{selectedSite.name}</h2>
      <p>{selectedSite.lat_deg.toFixed(5)}° N · {selectedSite.lon_deg.toFixed(5)}° E</p>
      <p>{at.replace("T"," ")} UTC</p>
      <button type="button" onClick={() => openPlanner(selectedSite)}>Calculate energy for this pin</button>
    </article>}
    <form className="controls" onSubmit={event => {
      event.preventDefault();
      navigationTouched.current=true;
      setTarget({ latitude: Number(lat), longitude: Number(lon), elevation: Number(height) });
      setFlightMode("site");
      setFlyToTarget(value => value + 1);
    }}>
      <label>Explore<select value={body} onChange={e => {
        const next = e.target.value as "moon" | "earth";
        activeBody.current=next;
        setBody(next); dirty(); setSelected(""); setTarget(null); setPinPlacement(false);
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
        {allSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>}
      <label>Latitude (° north)<input required type="number" min="-90" max="90" step="any" value={lat} onChange={e => { dirty(); setSelected(""); setLat(e.target.value); }} /></label>
      <label>Longitude (° east)<input required type="number" min="-180" max="180" step="any" value={lon} onChange={e => { dirty(); setSelected(""); setLon(e.target.value); }} /></label>
      <label>Altitude above {body === "moon" ? "lunar" : "Earth"} ellipsoid (m)<input required type="number" min="-20000" max="20000" step="any" value={height} onChange={e => { dirty(); setHeight(e.target.value); }} /></label>
      <button type="submit">Fly to coordinates</button>
      {body === "moon" && <div className="mission-pin-controls">
        <label>Pin title<input value={pinTitle} maxLength={100} placeholder="e.g. Shackleton candidate A" onChange={event => setPinTitle(event.target.value)}/></label>
        <button type="button" aria-pressed={pinPlacement} onClick={() => setPinPlacement(value=>!value)}>{pinPlacement ? "Cancel pin placement" : "Add pin on Moon"}</button>
        <button type="button" onClick={event => {if(event.currentTarget.form?.reportValidity()) addPin({latitude:Number(lat),longitude:Number(lon),elevation:Number(height)});}}>Pin these coordinates</button>
        <p role={pinPlacement ? "status" : undefined}>{pinPlacement ? "Click the lunar surface to place your pin. Clicking empty space does not place it." : "Pins remain available during this session. Select a pin, choose the UTC time below, then calculate."}</p>
      </div>}
      {body === "moon" && <>
      <label>Date & time (UTC)<input required type="datetime-local" min="1550-01-01T00:00" max="2649-12-31T23:59" value={at} onChange={e => { dirty(); setAt(e.target.value); }} /></label>
      <button type="button" disabled={loading} onClick={event => {
        if (!event.currentTarget.form?.reportValidity()) return;
        setTarget({ latitude: Number(lat), longitude: Number(lon), elevation: Number(height) });
      setRequest({ lat: Number(lat), lon: Number(lon), height: Number(height), at: `${at}:00Z` });
      }}>{loading ? "Querying JPL Horizons…" : "Show Sun & Earth"}</button>
      </>}
    </form>
    {selectedSite && <p className="banner">{selectedSite.notes}</p>}
    {siteError && <p role="alert">Could not load sites: {siteError}. Custom coordinates remain available.</p>}
    {loading && <p role="status">Fetching Sun and Earth positions from JPL Horizons…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !loading && <p>Enter coordinates and fly to the location. On the Moon, load Sun & Earth to look toward them from the site.</p>}
    </LunarGlobe>
    </div>
    <dialog ref={energyDialog} id="energy-dialog" aria-label="Lunar Energy planner" className="energy-dialog" onClick={event => {if (event.target === event.currentTarget) energyDialog.current?.close();}}>
      {plannerSelection && <EnergyPlanner key={plannerSelection.key} lat={plannerSelection.lat} lon={plannerSelection.lon} at={plannerSelection.at} siteName={plannerSelection.name} onClose={() => energyDialog.current?.close()}/>}
    </dialog>
  </main>;
}
export default App;
