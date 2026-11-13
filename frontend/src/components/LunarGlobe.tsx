import { useEffect, useRef, useState } from "react";
import type { Site } from "../api/client";
import type { CreateGlobe, GlobeHandle } from "../globe/createLunarViewer";
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
const loadGlobe: CreateGlobe = async (element, markers) => {
  const { createLunarGlobe } = await import("../globe/createLunarViewer");
  return createLunarGlobe(element, markers);
};

type Props = {
  sites: Site[];
  createGlobe?: CreateGlobe;
  webglSupported?: () => boolean;
};

export function LunarGlobe({
  sites,
  createGlobe = loadGlobe,
  webglSupported = defaultWebglSupported,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(webglSupported);

  useEffect(() => {
    if (!supported) return;
    const element = containerRef.current;
    if (!element) return;

    let handle: GlobeHandle | null = null;
    let cancelled = false;

    createGlobe(element, toSiteMarkers(sites))
      .then((created) => {
        if (cancelled) {
          created.destroy();
        } else {
          handle = created;
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
    };
  }, [sites, createGlobe, supported]);

  return (
    <section className="globe-panel">
      <h2>Lunar globe</h2>

      {!supported ? (
        <p>WebGL is not available in this browser, so the lunar globe cannot be shown.</p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="error">
              Could not start the lunar globe: {error}
            </p>
          ) : null}
          <div ref={containerRef} className="globe-canvas" />
          <p className="attribution">
            Base map: NASA SVS CGI Moon Kit (LRO LROC WAC colour mosaic). Lunar ellipsoid
            1,737.4 km — no Earth imagery is used.
          </p>
        </>
      )}
    </section>
  );
}
