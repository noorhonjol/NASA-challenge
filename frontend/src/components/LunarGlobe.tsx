import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { Site, Positions } from "../api/client";
import type { CreateGlobe, GlobeHandle, GlobeOptions } from "../globe/createLunarViewer";
import { toSiteMarkers } from "../globe/siteMarkers";
import type { SurfaceStatus } from "../globe/orbitCamera";
import { SkyTimePanel } from "./SkyTimePanel";

const defaultWebglSupported = () => {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
};

// Cesium is loaded only when a globe is actually being created, so tests and
// the initial paint never pull in its bundle.
const loadGlobe: CreateGlobe = async (element, markers, positions, options) => {
  const { createLunarGlobe } = await import("../globe/createLunarViewer");
  return createLunarGlobe(element, markers, positions, options);
};

type Props = {
  children?: ReactNode;
  sites: Site[];
  onSiteSelect?: (id: string) => void;
  onPinPlace?: (point: {latitude: number; longitude: number; elevation: number}) => void;
  onPolygonPoint?: (point: {latitude: number; longitude: number}) => void;
  positions?: Positions | null;
  options?: GlobeOptions;
  createGlobe?: CreateGlobe;
  webglSupported?: () => boolean;
  /** Filled with the globe's camera actions once it is ready (for buttons outside the globe). */
  actionsRef?: MutableRefObject<Pick<GlobeHandle, "view" | "surface"> | null>;
  /** Called when street-level surface view starts (true) or ends (false). */
  onSurfaceChange?: (active: boolean) => void;
  /** Extra settings shown in the collapsed "Display & data" section. */
  dataDetails?: ReactNode;
  /** Camera preset to fly to once the globe is ready. */
  initialView?: "pole";
};

export function LunarGlobe({
  children,
  sites,
  onSiteSelect,
  onPinPlace,
  onPolygonPoint,
  positions,
  options,
  createGlobe = loadGlobe,
  webglSupported = defaultWebglSupported,
  actionsRef,
  onSurfaceChange,
  dataDetails,
  initialView,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(webglSupported);
  const [panelOpen, setPanelOpen] = useState(true);
  const [surface, setSurface] = useState<SurfaceStatus | null>(null);
  // Sky & time panel: while open, its interpolated Sun/Earth replace the snapshot on the globe.
  const [skyOpen, setSkyOpen] = useState(false);
  const [skyPositions, setSkyPositions] = useState<Positions | null>(null);
  const drawnPositions = skyOpen && skyPositions ? skyPositions : positions;
  const lookAt = useCallback((az: number, el: number) => globeRef.current?.surfaceLook?.(az, el), []);
  // Where the sky is computed: the spot you stand on, else the selected site (orbit views).
  const targetLat = options?.target?.latitude, targetLon = options?.target?.longitude, targetElevation = options?.target?.elevation;
  const siteSky: SurfaceStatus | null = useMemo(() => targetLat === undefined || targetLon === undefined ? null : {
    headingDeg: null, pitchDeg: 0, latitude: targetLat, longitude: targetLon, groundM: targetElevation ?? 0,
    fovDeg: 60, moving: false, transition: null,
  }, [targetLat, targetLon, targetElevation]);
  const skyStatus = surface ?? siteSky;
  const body = options?.body ?? "moon";
  const sceneProps = useRef({ sites, positions, options });
  const selectSiteRef = useRef(onSiteSelect);
  const placePinRef = useRef(onPinPlace);
  useEffect(() => {placePinRef.current=onPinPlace;},[onPinPlace]);
  const polygonPointRef = useRef(onPolygonPoint);
  useEffect(() => {polygonPointRef.current=onPolygonPoint;},[onPolygonPoint]);
  useEffect(() => {selectSiteRef.current=onSiteSelect;},[onSiteSelect]);
  const surfaceChangeRef = useRef(onSurfaceChange);
  useEffect(() => {surfaceChangeRef.current=onSurfaceChange;},[onSurfaceChange]);
  const inSurface = useRef(false);

  useEffect(() => { sceneProps.current = { sites, positions, options }; }, [sites, positions, options]);

  useEffect(() => {
    if (!supported) return;
    const element = containerRef.current;
    if (!element) return;
    setError(null);
    setReady(false); setWarning(null); setTerrainLoading(false);
    const onWarning = (event: Event) => setWarning((event as CustomEvent<string>).detail);
    element.addEventListener("imagery-warning", onWarning);
    const onTerrainLoading = (event: Event) => setTerrainLoading(Boolean((event as CustomEvent).detail));
    element.addEventListener("terrain-loading", onTerrainLoading);
    const onSelected = (event: Event) => selectSiteRef.current?.(String((event as CustomEvent).detail));
    element.addEventListener("site-selected", onSelected);
    const onPlaced = (event: Event) => placePinRef.current?.((event as CustomEvent).detail);
    element.addEventListener("pin-placed", onPlaced);
    const onSurface = (event: Event) => {
      const status = (event as CustomEvent<SurfaceStatus | null>).detail;
      setSurface(status);
      // Standing on the surface gets the whole screen: the panel tucks away and comes back after.
      if (status && !inSurface.current) { inSurface.current = true; setPanelOpen(false); surfaceChangeRef.current?.(true); }
      if (!status && inSurface.current) { inSurface.current = false; setPanelOpen(true); surfaceChangeRef.current?.(false); }
      // The sky panel stays open across views: it works from orbit too.
    };
    element.addEventListener("surface-view", onSurface);
    const onCorner = (event: Event) => polygonPointRef.current?.((event as CustomEvent).detail);
    element.addEventListener("polygon-point", onCorner);

    let handle: GlobeHandle | null = null;
    let cancelled = false;

    const initial = sceneProps.current;
    createGlobe(element, toSiteMarkers(initial.sites), initial.positions, initial.options)
      .then((created) => {
        if (cancelled) {
          created.destroy();
        } else {
          handle = created;
          globeRef.current = created;
          setReady(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      handle?.destroy();
      globeRef.current = null;
      element.removeEventListener("imagery-warning", onWarning);
      element.removeEventListener("terrain-loading", onTerrainLoading);
      element.removeEventListener("site-selected", onSelected);
      element.removeEventListener("pin-placed", onPlaced);
      element.removeEventListener("surface-view", onSurface);
      element.removeEventListener("polygon-point", onCorner);
    };
  }, [body, createGlobe, supported]);

  // Expose camera actions, and open on the requested preset once.
  const openedView = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (actionsRef) actionsRef.current = { view: mode => globeRef.current?.view?.(mode), surface: (a, at) => globeRef.current?.surface?.(a, at) };
    if (initialView && !openedView.current) { openedView.current = true; globeRef.current?.view?.(initialView); }
    return () => { if (actionsRef) actionsRef.current = null; };
  }, [ready, actionsRef, initialView]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    globeRef.current?.update?.(toSiteMarkers(sites), drawnPositions, options).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [sites, drawnPositions, options, ready]);

  return (
    <section className="globe-panel">
      {supported && <div ref={containerRef} className={`globe-canvas ${options?.pinPlacement || options?.drawing ? "is-placing-pin" : ""}`} aria-label={options?.body === "earth" ? "Interactive Earth globe" : "Interactive Moon globe"} />}
      <aside className={`explorer-panel ${panelOpen ? "is-open" : "is-collapsed"}`} aria-label="Explorer controls">
      <div className="panel-heading">
        <span className="panel-brand">Lunar Planner</span>
        <button className="panel-toggle" type="button" aria-expanded={panelOpen} aria-controls="explorer-controls" onClick={() => setPanelOpen(open => !open)}>{panelOpen ? "Hide panel" : "Show panel"}</button>
      </div>
      <div id="explorer-controls" className="panel-content" hidden={!panelOpen}>
      {children}
      {positions && <section className="sky-snapshot" aria-label="Sun and Earth at mission start">
        <p>From the site at {new Date(positions.at_utc).toISOString().slice(0, 16).replace("T", " ")} UTC</p>
        <div className="metrics">{(["sun", "earth"] as const).map(body => <article key={body}>
          <h3>{body === "sun" ? "Sun" : "Earth"}</h3>
          <strong>{positions[body].elevation_deg.toFixed(2)}° elevation</strong>
          <p>{positions[body].azimuth_deg.toFixed(2)}° azimuth · {positions[body].above_horizon ? "Above horizon" : "At or below horizon"}</p>
        </article>)}</div>
      </section>}
      {warning && <p role="status">{warning}</p>}
      {terrainLoading && <p role="status">Loading prepared local region into memory…</p>}
      {!supported && <p>WebGL is not available in this browser, so the lunar globe cannot be shown.</p>}
      {supported && error && <p role="alert" className="error">Could not start the lunar globe: {error}</p>}
      <details className="panel-details">
        <summary>Display &amp; data</summary>
        {dataDetails}
        <p className="attribution">Mouse: left-drag orbits, right-drag looks around, Shift + right-drag rolls, scroll zooms toward the ground; below 800 m you stand on the surface. R over the globe faces the center again.</p>
        <p className="attribution">
          {options?.body === "earth" ? "Earth: Esri World Imagery with NASA Blue Marble fallback; WGS84 ellipsoid." : "Moon: local PGDA 81 south-pole mosaic (87–90°S). A 50 m overview loads once; close-up 5 m detail uses cached local chunks. The rest uses the global LOLA base. Heights are 1×, quantized to 0.5 m for display. Relief lighting is illustrative."}
        </p>
        {positions && <>
          <p className="attribution">Earth and Sun use Horizons bearings and ranges. Earth imagery is an illustrative NASA Blue Marble face; its rotation and phase are not simulated. White ring: local horizon. Short rays mark bearings; bodies below the Moon's surface are hidden.</p>
          <p className="attribution">Long dashed lines and translucent polygons connect the site to Earth and Sun. Blue: Earth above the horizon. Gold: Sun above the horizon. Orange: body below the horizon. Polygons are illustrative sight planes, not communication coverage or terrain-aware illumination.</p>
          <p className="attribution"><a href="https://ssd.jpl.nasa.gov/horizons/">JPL Horizons</a>: {positions.horizon_model} Visibility does not guarantee power generation or a communication link.</p>
        </>}
      </details>
      </div>
      </aside>
      {!surface && <div className="camera-toolbar" role="group" aria-label="Camera views">
        <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("globe")}>Whole Moon</button>
        {options?.body !== "earth" && <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("pole")}>South pole</button>}
        <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("center")}>Center view</button>
        {options?.body !== "earth" && <button type="button" disabled={!ready || !options?.target} onClick={() => globeRef.current?.view?.("terrain")}>Inspect 3D terrain</button>}
        {positions && options?.body !== "earth" && <>
          <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("earth")}>Look toward Earth</button>
          <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("sun")}>Look toward Sun</button>
        </>}
        {options?.body !== "earth" && <button type="button" aria-pressed={skyOpen} disabled={!ready || !siteSky}
          title={siteSky ? "Move through time and watch the Sun and Earth from the selected site" : "Pick a site first"}
          onClick={() => setSkyOpen(open => !open)}>Sky &amp; time</button>}
        {options?.body !== "earth" && <button type="button" className="camera-primary" disabled={!ready} onClick={() => globeRef.current?.surface?.("enter")}>Stand on surface</button>}
      </div>}
      {!surface && supported && <button type="button" className="recentre-button" disabled={!ready} title="Point the camera at the centre of the Moon again (shortcut: R)"
        aria-label="Re-centre the view" onClick={() => globeRef.current?.view?.("center")}><span aria-hidden="true">⌖</span> Re-centre</button>}
      {skyOpen && skyStatus && <SkyTimePanel key={siteSky ? `${siteSky.latitude},${siteSky.longitude}` : "standing"} status={skyStatus}
        onPositions={setSkyPositions} onLook={lookAt} onClose={() => setSkyOpen(false)} />}
      {surface && <SurfaceHud status={surface} skyOpen={skyOpen} onSky={() => setSkyOpen(open => !open)} onExit={() => globeRef.current?.surface?.("exit")} />}
    </section>
  );
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Street-level overlay: where you face, how you look, and the controls. */
function SurfaceHud({ status, skyOpen, onSky, onExit }: { status: SurfaceStatus; skyOpen: boolean; onSky: () => void; onExit: () => void }) {
  const heading = status.headingDeg;
  const label = heading === null ? "at the pole" : `${COMPASS[Math.round(heading / 45) % 8]} ${heading.toFixed(0)}°`;
  return <div className="surface-hud" role="region" aria-label="Surface view">
    <div className="surface-hud-compass" aria-label={`Facing ${label}, looking ${status.pitchDeg >= 0 ? "up" : "down"} ${Math.abs(status.pitchDeg).toFixed(0)}°`}>
      <strong>{label}</strong>
      <span>{status.pitchDeg >= 0 ? "▲" : "▼"} {Math.abs(status.pitchDeg).toFixed(0)}° · {status.latitude.toFixed(4)}°, {status.longitude.toFixed(4)}°</span>
    </div>
    <p>{status.transition === "enter" ? "Landing…" : status.transition === "exit" ? "Rising to orbit view…" : status.transition === "travel" ? "Travelling…"
      : status.exitProgress ? `Keep scrolling out to leave… ${Math.round(status.exitProgress * 100)}%`
      : "Drag to look · W A S D or arrows to walk (Shift: run) · Click a spot to jump there · Scroll: zoom lens; keep scrolling out to leave"}</p>
    <button type="button" aria-pressed={skyOpen} onClick={onSky}>Sky &amp; time</button>
    <button type="button" onClick={onExit}>Leave surface view</button>
  </div>;
}
