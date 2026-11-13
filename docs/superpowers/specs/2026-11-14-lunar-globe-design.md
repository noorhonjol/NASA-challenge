# Lunar globe viewer (Phase 1.5)

Date: 2026-11-14
Status: approved by "go ahead" on Approach B

## Intent

Replace the labelled placeholder with a real, interactive CesiumJS **lunar** globe. The
user pointed at the 2018 Cesium/React post; its `cesium-react` wrapper is unmaintained
and assumes webpack/CRA, so we use CesiumJS directly inside a React effect (plus
`vite-plugin-cesium` for asset handling). Per the Phase 1 spec, the globe must not be an
Earth globe: it uses the Moon ellipsoid and lunar imagery.

## Goals

- A Cesium viewer showing the Moon (1,737.4 km ellipsoid), one public-domain LRO colour
  mosaic as its base layer, no Earth imagery, no Cesium ion token.
- The three fictional sites appear as pins at their lunar lat/lon/elevation, clickable
  for name, slug and frame.
- Camera opens looking at the lunar south pole region, where the seeded sites sit.
- A clear in-page message if WebGL is unavailable, instead of a blank box.
- Tests cover the site→marker mapping and the component's failure path; `npm run build`
  still passes.

## Non-goals

- Terrain relief, 3D Tiles, Cesium Moon / ion streaming, raster ingestion.
- Any visibility or illumination computation; the banner still says none is computed.
- Earth imagery of any kind.

## Anti-goals

- Shipping a silent blank canvas when Cesium or WebGL fails.
- Hard-coding an ion access token in the client bundle.
- Presenting the mosaic as survey-grade terrain; it is a visual base layer only.

## Constraints

- `cesium` and `vite-plugin-cesium` added to `frontend` only; the backend is untouched.
- The mosaic is NASA/Goddard/Arizona State University LRO imagery (public domain),
  attributed in the UI.
- Cesium is imported dynamically, only when WebGL is available, so jsdom tests and the
  Vite build stay fast and deterministic.
- The existing `Site` shape from `src/api/client.ts` is reused unchanged.

## Approaches considered

1. **Direct CesiumJS + bundled mosaic** (chosen) — one dependency pair, no credentials,
   offline-capable, deterministic tests.
2. **Cesium Moon 3D Tiles via ion** — real LRO terrain, but needs a token, an external
   runtime service, and licence review; deferred to milestone 5, where terrain data
   actually exists in the schema.
3. **`resium` React bindings** — maintained, but adds a second abstraction over Cesium
   for a single viewer; direct calls are fewer moving parts here.

## The build

- `src/globe/siteMarkers.ts` — pure `toSiteMarkers(sites: Site[]): SiteMarker[]`;
  null elevation becomes 0 m height so a pin never disappears.
- `src/globe/createLunarViewer.ts` — creates the `Viewer` (Moon ellipsoid terrain
  provider, single-tile lunar imagery, chrome-free options), adds point+label entities,
  flies to the south pole, disables globe lighting defaults that assume Earth's sun.
- `src/components/LunarGlobe.tsx` — container div, WebGL capability check, dynamic
  import of the viewer factory, error state, unmount cleanup, NASA attribution line.
- `src/App.tsx` — renders `<LunarGlobe sites={sites} />` in place of the placeholder;
  `ViewerPlaceholder` is deleted.
- Tests: `siteMarkers.test.ts` (mapping, null elevation, lunar frame passthrough),
  `LunarGlobe.test.tsx` (fallback message when the factory throws; marker handoff).

## Left to the builder

Exact viewer options, pin styling, and the attribution wording.
