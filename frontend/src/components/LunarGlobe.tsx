import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Site, Positions } from "../api/client";
import type { CreateGlobe, GlobeHandle, GlobeOptions } from "../globe/createLunarViewer";
import { toSiteMarkers } from "../globe/siteMarkers";

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
  positions?: Positions | null;
  options?: GlobeOptions;
  createGlobe?: CreateGlobe;
  webglSupported?: () => boolean;
};

export function LunarGlobe({
  children,
  sites,
  onSiteSelect,
  positions,
  options,
  createGlobe = loadGlobe,
  webglSupported = defaultWebglSupported,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(webglSupported);
  const [panelOpen, setPanelOpen] = useState(true);
  const body = options?.body ?? "moon";
  const sceneProps = useRef({ sites, positions, options });
  const selectSiteRef = useRef(onSiteSelect);
  useEffect(() => {selectSiteRef.current=onSiteSelect;},[onSiteSelect]);

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
    };
  }, [body, createGlobe, supported]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    globeRef.current?.update?.(toSiteMarkers(sites), positions, options).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [sites, positions, options, ready]);

  return (
    <section className="globe-panel">
      {supported && <div ref={containerRef} className="globe-canvas" aria-label={options?.body === "earth" ? "Interactive Earth globe" : "Interactive Moon globe"} />}
      <aside className={`explorer-panel ${panelOpen ? "is-open" : "is-collapsed"}`} aria-label="Explorer controls">
      <div className="panel-heading">
        <span className="panel-brand">Lunar Planner</span>
        <button className="panel-toggle" type="button" aria-expanded={panelOpen} aria-controls="explorer-controls" onClick={() => setPanelOpen(open => !open)}>{panelOpen ? "Hide panel" : "Show panel"}</button>
      </div>
      <div id="explorer-controls" className="panel-content" hidden={!panelOpen}>
      {children}
      <h2>{options?.body === "earth" ? "Earth explorer" : "Moon explorer"}</h2>
      <div className="globe-toolbar" aria-label="Camera views">
        <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("globe")}>Whole globe</button>
        {options?.body !== "earth" && <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("pole")}>South pole · 87–90°S</button>}
        <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("center")}>Center view</button>
        <button type="button" disabled={!ready || (!options?.target && !positions)} onClick={() => globeRef.current?.view?.("site")}>Fly to site</button>
        {options?.body !== "earth" && <button type="button" disabled={!ready || !options?.target} onClick={() => globeRef.current?.view?.("terrain")}>Inspect 3D terrain</button>}
        {positions && options?.body !== "earth" && <>
          <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("earth")}>Look toward Earth</button>
          <button type="button" disabled={!ready} onClick={() => globeRef.current?.view?.("sun")}>Look toward Sun</button>
        </>}
      </div>
      <p className="attribution">Left-drag: orbit at fixed radius, keeping the current tilt and roll. Scroll: radial zoom. Right-drag: look around without moving. Shift + right-drag: roll. Center view or R over the globe: face the center again.</p>
      {warning && <p role="status">{warning}</p>}
      {terrainLoading && <p role="status">Loading prepared local region into memory…</p>}
      {positions && <>
        <p>JPL Horizons · {new Date(positions.at_utc).toISOString().replace("T", " ")} UTC</p>
        <div className="metrics">{(["sun", "earth"] as const).map(body => <article key={body}>
          <h3>{body === "sun" ? "Sun" : "Earth"}</h3>
          <strong>{positions[body].elevation_deg.toFixed(2)}° elevation</strong>
          <p>{positions[body].azimuth_deg.toFixed(2)}° azimuth · {positions[body].above_horizon ? "Above horizon" : "At or below horizon"}</p>
        </article>)}</div>
        <p className="attribution">Earth and Sun use Horizons bearings and ranges. Earth imagery is an illustrative NASA Blue Marble face; its rotation and phase are not simulated. White ring: local horizon. Short rays mark bearings; bodies below the Moon's surface are hidden.</p>
        <p className="attribution">Long dashed lines and translucent polygons connect the site to Earth and Sun. Blue: Earth above the horizon. Gold: Sun above the horizon. Orange: body below the horizon. Polygons are illustrative sight planes, not communication coverage or terrain-aware illumination. Updating data keeps your current camera view.</p>
      </>}

      {!supported ? (
        <p>WebGL is not available in this browser, so the lunar globe cannot be shown.</p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="error">
              Could not start the lunar globe: {error}
            </p>
          ) : null}
          <p className="attribution">
            {options?.body === "earth" ? "Earth: Esri World Imagery with NASA Blue Marble fallback; WGS84 ellipsoid." : "Moon: local PGDA 81 south-pole mosaic (87–90°S). A 50 m overview loads once; close-up 5 m detail uses cached local chunks. The rest uses the global LOLA base. Heights are 1×, quantized to 0.5 m for display. Relief lighting is illustrative."}
          </p>
          {positions && <p className="attribution"><a href="https://ssd.jpl.nasa.gov/horizons/">JPL Horizons</a>: {positions.horizon_model} Visibility does not guarantee power generation or a communication link.</p>}
        </>
      )}
      </div>
      </aside>
      <div className="navigation-hint" aria-hidden="true">{options?.body === "earth" ? "EARTH" : "MOON"}<span>Left: orbit · Right: look · Shift + right: roll · Scroll: zoom</span></div>
    </section>
  );
}
