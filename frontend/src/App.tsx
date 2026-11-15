import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GlobeHandle, GlobeOptions } from "./globe/createLunarViewer";
import { fetchPositions, fetchSites, fetchTerrainManifest, type Positions, type Site, type TerrainManifest } from "./api/client";
import { EnergyPlanner } from "./components/EnergyPlanner";
import { MissionPlanner, type GlobeOverlay } from "./components/MissionPlanner";
import type { LatLon } from "./api/mission";
import { LunarGlobe } from "./components/LunarGlobe";
import { EarthLinkPanel } from "./components/EarthLinkPanel";
import { SunPanel } from "./components/SunPanel";
import { addDays } from "./mission";

type Spot = { lat: number; lon: number; elevation: number; name: string };

/** Parses a typed coordinate; text inputs keep the digits Western whatever the browser locale. */
const parseCoordinate = (text: string, limit: number) => {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
};

/** The detailed tools, one at a time. Hidden tabs stay mounted, so their results survive switching. */
function DetailedTabs({ note, tabs }: { note: string; tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0].id);
  return <>
    <p className="mission-note">{note}</p>
    <div className="mission-subtabs" role="tablist" aria-label="Detailed analysis topics">
      {tabs.map(t => <button key={t.id} type="button" role="tab" id={`detail-tab-${t.id}`} aria-controls={`detail-panel-${t.id}`}
        aria-selected={active === t.id} onClick={() => setActive(t.id)}>{t.label}</button>)}
    </div>
    {tabs.map(t => <div key={t.id} role="tabpanel" id={`detail-panel-${t.id}`} aria-labelledby={`detail-tab-${t.id}`}
      className="mission-detail" hidden={active !== t.id}>{t.content}</div>)}
  </>;
}

function App() {
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerKey, setPlannerKey] = useState(0);
  const [missionPins, setMissionPins] = useState<Site[]>([]);
  const [pinPlacement, setPinPlacement] = useState(false);
  const [pinTitle, setPinTitle] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<LatLon[]>([]);
  const [drawnPolygon, setDrawnPolygon] = useState<LatLon[] | null>(null);
  const [plannerOverlay, setPlannerOverlay] = useState<GlobeOverlay | null>(null);
  const nextPinId = useRef(-2);
  const globeActions = useRef<Pick<GlobeHandle, "view" | "surface"> | null>(null);
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
  // A spot that is not a named site: typed coordinates or a best spot from the planner.
  const [spot, setSpot] = useState<Spot | null>(null);
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
      if (controller.signal.aborted) return;
      setTerrain(manifest);
      const mosaic = manifest.regions.find(region => region.product_id === 81);
      if (mosaic) setTerrainRegion(mosaic.region_id);
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

  const allSites = useMemo(() => [...sites, ...missionPins], [sites, missionPins]);
  const selectedSite = allSites.find(site => String(site.id) === selected);
  // The one place everything is about: a named site or pin, else a spot, else nothing yet.
  const location: Spot | null = selectedSite
    ? { lat: selectedSite.lat_deg, lon: selectedSite.lon_deg, elevation: selectedSite.elevation_m ?? 0, name: selectedSite.name }
    : spot;

  const clearSky = () => { setData(null); setRequest(null); setLoading(false); setError(null); };
  const flyTo = (point: { latitude: number; longitude: number; elevation: number }, mode: "site" | "terrain") => {
    setTarget(point); setFlightMode(mode); setFlyToTarget(value => value + 1);
  };
  const addPin = (point: {latitude:number;longitude:number;elevation:number}) => {
    const id = nextPinId.current--;
    const pin: Site = { id, slug: `mission-pin-${-id}`, name: pinTitle.trim() || `Mission site ${-id-1}`, lat_deg: point.latitude, lon_deg: point.longitude,
      elevation_m: point.elevation, frame: "MOON_ME", is_fictional: false, notes: "Your pin for this session. Analysis uses local LOLA elevation." };
    setMissionPins(pins => [...pins, pin]); setSelected(String(id)); setSpot(null); setPinPlacement(false); setPinTitle("");
    setLat(String(point.latitude)); setLon(String(point.longitude)); setHeight(String(point.elevation));
    setTarget(point); clearSky();
  };
  const chooseSite = (id: string) => {
    setSelected(id); setSpot(null); clearSky();
    const site = allSites.find(item => String(item.id) === id);
    if (site) {
      setLat(String(site.lat_deg)); setLon(String(site.lon_deg)); setHeight(String(site.elevation_m ?? 0));
      flyTo({ latitude: site.lat_deg, longitude: site.lon_deg, elevation: site.elevation_m ?? 0 }, "terrain"); setTerrainEnabled(true);
    }
  };
  const pickSpot = (latitude: number, longitude: number, elevation: number) => {
    setSelected(""); clearSky();
    setSpot({ lat: latitude, lon: longitude, elevation, name: "Best spot" });
    setLat(String(latitude)); setLon(String(longitude)); setHeight(String(elevation));
    flyTo({ latitude, longitude, elevation }, "terrain"); setTerrainEnabled(true);
  };
  const readCoordinates = () => {
    const latitude = parseCoordinate(lat, 90), longitude = parseCoordinate(lon, 180), elevation = parseCoordinate(height, 20000);
    if (latitude === null || longitude === null || elevation === null) {
      setError("Enter a latitude between −90 and 90, a longitude between −180 and 180 and an elevation in metres.");
      return null;
    }
    return { latitude, longitude, elevation };
  };
  const checkSite = () => { setPlannerKey(key => key + 1); setPlannerOpen(true); };
  const startDrawing = () => { setPinPlacement(false); setDraft([]); setDrawing(true); };
  const stopDrawing = (keep: boolean) => {
    if (keep) setDrawnPolygon(draft);
    setDrawing(false); setDraft([]);
  };
  const overlay = useMemo(() => drawing ? { polygon: draft, closed: false, spots: [] }
    : plannerOverlay ? { ...plannerOverlay, closed: true } : null, [drawing, draft, plannerOverlay]);
  const globeOptions = useMemo(() => ({ body: "moon" as const, target, flyToTarget, flightMode, terrainEnabled, terrainRegion, pinPlacement, drawing, overlay }),
    [target, flyToTarget, flightMode, terrainEnabled, terrainRegion, pinPlacement, drawing, overlay]);
  const validStart = Number.isFinite(Date.parse(`${mission.start}Z`));

  return <main>
    <div className="globe-workspace">
    {drawing && <div className="draw-bar" role="region" aria-label="Draw mission region">
      <p><strong>Draw the mission region.</strong> Click its corners on the Moon ({draft.length} so far, at least 3). Dragging still orbits the camera.</p>
      <button type="button" disabled={!draft.length} onClick={() => setDraft(points => points.slice(0, -1))}>Undo corner</button>
      <button type="button" disabled={draft.length < 3} onClick={() => stopDrawing(true)}>Finish region</button>
      <button type="button" onClick={() => stopDrawing(false)}>Cancel</button>
    </div>}
    <LunarGlobe sites={allSites} positions={data} options={globeOptions} onSiteSelect={chooseSite} onPinPlace={addPin}
      onPolygonPoint={point => setDraft(points => [...points, [Math.round(point.latitude * 1e5) / 1e5, Math.round(point.longitude * 1e5) / 1e5]])}
      actionsRef={globeActions} initialView="pole" onSurfaceChange={active => { if (active) setPlannerOpen(false); }}
      dataDetails={<div className="terrain-controls">
        <label className="terrain-toggle"><input type="checkbox" checked={terrainEnabled} onChange={e => setTerrainEnabled(e.target.checked)} />3D elevation terrain</label>
        {terrain && <p>{terrain.regions.some(region => region.product_id === 81) ? "Product 81 · Continuous coverage, 87–90°S. Local 50 m overview with cached 5 m detail." : `${terrain.regions.length} prepared regions · Select one for 5 m detail.`}</p>}
      </div>}>
    <p className="panel-intro">Pick a landing site at the lunar south pole, then check its sunlight, temperature and Earth contact.</p>

    <section className="panel-section" aria-label="Site">
      <label className="section-label">Site<select value={selected} onChange={event => chooseSite(event.target.value)}>
        <option value="">Pick a site or click a pin…</option>
        {allSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>
      <div className="pin-row">
        <button type="button" aria-pressed={pinPlacement} onClick={() => setPinPlacement(value => !value)}>{pinPlacement ? "Cancel pin" : "Drop a pin"}</button>
        {pinPlacement && <label>Pin name (optional)<input value={pinTitle} maxLength={100} placeholder="e.g. Shackleton candidate A" onChange={event => setPinTitle(event.target.value)} /></label>}
      </div>
      {pinPlacement && <p role="status" className="hint">Click the Moon where the pin should go.</p>}
      <details className="coordinates">
        <summary>Enter coordinates…</summary>
        <form onSubmit={event => {
          event.preventDefault();
          const point = readCoordinates(); if (!point) return;
          setError(null); setSelected(""); clearSky();
          setSpot({ lat: point.latitude, lon: point.longitude, elevation: point.elevation, name: "Entered coordinates" });
          flyTo(point, "site");
        }}>
          <label>Latitude (° north)<input type="text" inputMode="decimal" spellCheck={false} value={lat} onChange={e => setLat(e.target.value)} /></label>
          <label>Longitude (° east)<input type="text" inputMode="decimal" spellCheck={false} value={lon} onChange={e => setLon(e.target.value)} /></label>
          <label>Elevation (m)<input type="text" inputMode="decimal" spellCheck={false} value={height} onChange={e => setHeight(e.target.value)} /></label>
          <div className="button-row">
            <button type="submit">Fly to coordinates</button>
            <button type="button" onClick={() => { const point = readCoordinates(); if (point) { setError(null); addPin(point); } }}>Pin these coordinates</button>
          </div>
        </form>
      </details>
    </section>

    {location && <article className="site-card" aria-label="Selected site">
      <h2>{location.name}</h2>
      <p>{location.lat.toFixed(5)}° N · {location.lon.toFixed(5)}° E · {Math.round(location.elevation)} m</p>
      {selectedSite?.notes && <p className="site-notes">{selectedSite.notes}</p>}
      <button type="button" className="primary" onClick={checkSite}>Check this site</button>
      <div className="button-row">
        <button type="button" onClick={() => globeActions.current?.surface?.("enter", { latitude: location.lat, longitude: location.lon })}>Stand here</button>
        <button type="button" onClick={() => flyTo({ latitude: location.lat, longitude: location.lon, elevation: location.elevation }, "terrain")}>Inspect terrain</button>
        <button type="button" disabled={loading || !validStart} onClick={() => {
          setTarget({ latitude: location.lat, longitude: location.lon, elevation: location.elevation });
          setRequest({ lat: location.lat, lon: location.lon, height: location.elevation, at: `${mission.start}:00Z` });
        }}>{loading ? "Asking JPL Horizons…" : "Show Sun & Earth"}</button>
      </div>
    </article>}

    {siteError && <p role="alert">Could not load sites: {siteError}. You can still enter coordinates.</p>}
    {terrainError && <p role="status">3D terrain unavailable: {terrainError}. Showing the reference sphere.</p>}
    {error && <p role="alert" className="error">{error}</p>}

    <div className="planner-launch">
      <button type="button" className="primary" aria-expanded={plannerOpen} aria-controls="mission-planner" onClick={() => setPlannerOpen(open => !open)}>
        {plannerOpen ? "Hide mission planner" : "Open mission planner"}</button>
      <small>Analyze a site, an Artemis III region, or a region you draw.</small>
    </div>
    </LunarGlobe>
    </div>
    <aside id="mission-planner" className="planner-drawer" aria-label="Mission planner" hidden={!plannerOpen}>
      <MissionPlanner key={plannerKey}
        location={location ? { kind: "location", lat: location.lat, lon: location.lon, name: location.name } : null}
        sites={allSites} mission={mission} onMissionChange={(start, end) => { clearSky(); setMission({ start, end }); }}
        drawn={drawnPolygon} onDraw={startDrawing} onFly={pickSpot} onOverlay={setPlannerOverlay}
        onClose={() => setPlannerOpen(false)}
        advanced={location && validStart ? <DetailedTabs note={`Detailed tools for ${location.name}. They use the same mission time range.`} tabs={[
          { id: "power", label: "Power", content: <EnergyPlanner key={`${location.lat}:${location.lon}:${mission.start}`} lat={location.lat} lon={location.lon} at={mission.start} siteName={location.name} embedded onClose={() => setPlannerOpen(false)} /> },
          { id: "heat", label: "Heat & sunlight", content: <SunPanel key={`sun|${location.lat}|${location.lon}|${mission.start}|${mission.end}`} lat={location.lat} lon={location.lon} start={mission.start} end={mission.end} onPick={pickSpot} /> },
          { id: "earth", label: "Earth contact", content: <EarthLinkPanel key={`earth|${location.lat}|${location.lon}|${mission.start}|${mission.end}`} lat={location.lat} lon={location.lon} start={mission.start} end={mission.end} /> },
        ]} /> : <p className="mission-note">{location ? "Enter a valid mission start time first." : "Pick a site first: choose one in the panel or click a pin on the Moon."}</p>} />
    </aside>
  </main>;
}
export default App;
