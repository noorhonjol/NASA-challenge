import * as Cesium from "cesium";
import type { SiteMarker } from "./siteMarkers";
import type { Positions } from "../api/client";
import { localDirection } from "./localDirection";
import { makeSkyImages } from "./skyImages";
import { setupOrbitCamera } from "./orbitCamera";
import { centerFrame } from "./orbitCameraMath";
import { loadLolaTerrain } from "./lolaTerrain";
import { createPolarCap, type PolarCap } from "./polarCap";

export type GlobeOptions = {
  body: "moon" | "earth";
  target?: { latitude: number; longitude: number; elevation: number } | null;
  flyToTarget?: number;
  flightMode?: "site" | "terrain";
  terrainEnabled?: boolean;
  terrainRegion?: string;
  pinPlacement?: boolean;
  /** Clicks add polygon corners ("polygon-point" events) instead of selecting sites. */
  drawing?: boolean;
  /** Mission planner area (closed polygon, or open while drawing) and ranked spots. */
  overlay?: {
    polygon: [number, number][] | null;
    closed: boolean;
    spots: { lat: number; lon: number; label: string; pass: boolean }[];
  } | null;
};

export type GlobeHandle = {
  destroy(): void;
  view?: (mode: "globe" | "pole" | "site" | "earth" | "sun" | "center" | "terrain") => void;
  /** Street-level surface view: stand at the screen centre (or below the camera), or rise back to orbit. */
  surface?: (action: "enter" | "exit", at?: { latitude: number; longitude: number }) => void;
  /** In surface view, face an azimuth/elevation in degrees (to keep the Sun or Earth centred). */
  surfaceLook?: (azimuthDeg: number, elevationDeg: number) => void;
  update?: (markers: SiteMarker[], positions?: Positions | null, options?: GlobeOptions) => Promise<void>;
};

export type CreateGlobe = (
  element: HTMLElement,
  markers: SiteMarker[],
  positions?: Positions | null,
  options?: GlobeOptions,
) => Promise<GlobeHandle>;

/** NASA SVS CGI Moon Kit colour map (LRO LROC WAC mosaic), public domain. */
export const MOON_TEXTURE_URL = "/textures/lroc_color_2k.jpg";

const MOON_CREDIT = "NASA SVS / LRO LROC WAC mosaic";
/** Development-only camera readouts of live globes, for automated checks. */
const devReadouts = new Set<() => unknown>();
/** Minimum distance (m) of the sky dome that carries the Sun and Earth discs. */
const SKY_DOME_M = 20_000_000;

/**
 * Build a navigable lunar globe. Everything here is Moon-specific: the
 * ellipsoid is Ellipsoid.MOON (1,737.4 km) for the terrain provider, the
 * imagery rectangle and every entity position, and Earth-only scene effects
 * (atmosphere, fog, sky moon/sun) are switched off.
 */
export const createLunarGlobe: CreateGlobe = async (element, markers, positions, options) => {
  const isMoon = options?.body !== "earth";
  const ellipsoid = isMoon ? Cesium.Ellipsoid.MOON : Cesium.Ellipsoid.WGS84;

  // Cesium's camera, projection and cartographic conversions default to WGS84.
  // This must happen before the Viewer is constructed or the camera reasons in
  // Earth radii and ends up "below ground" on a 1,737 km sphere.
  Cesium.Ellipsoid.default = ellipsoid;

  const imagery = await Cesium.SingleTileImageryProvider.fromUrl(isMoon ? MOON_TEXTURE_URL : "/textures/earth-blue-marble.jpg", {
    rectangle: Cesium.Rectangle.MAX_VALUE,
    ellipsoid,
    credit: isMoon ? MOON_CREDIT : "NASA Blue Marble / NASA Earth Observatory",
  });
  const lola = isMoon ? await loadLolaTerrain().catch(() => null) : null;
  let terrainEnabled = Boolean(lola && options?.terrainEnabled !== false);
  const flatTerrain = new Cesium.EllipsoidTerrainProvider({ ellipsoid });

  const viewer = new Cesium.Viewer(element, {
    // Cesium omits its default starfield for non-Earth ellipsoids. Explicitly
    // supply the bundled Tycho star catalogue skybox for both bodies.
    skyBox: new Cesium.SkyBox({ sources: {
      positiveX: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_px.jpg"),
      negativeX: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_mx.jpg"),
      positiveY: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_py.jpg"),
      negativeY: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_my.jpg"),
      positiveZ: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_pz.jpg"),
      negativeZ: Cesium.buildModuleUrl("Assets/Textures/SkyBox/tycho2t3_80_mz.jpg"),
    } }),
    baseLayer: new Cesium.ImageryLayer(imagery),
    globe: new Cesium.Globe(ellipsoid),
    terrainProvider: terrainEnabled && lola ? lola.provider : flatTerrain,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
  });

  const scene = viewer.scene;
  // 87–90° S is drawn by a polar mesh instead of globe tiles when the polar mosaic is active.
  let cap: PolarCap | null = null;
  // The Moon as an occluder for pins: a sphere 10 km below the reference radius (under the deepest craters).
  const capOccluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.fromCartesian3(
    new Cesium.Cartesian3(ellipsoid.maximumRadius - 10_000, ellipsoid.maximumRadius - 10_000, ellipsoid.maximumRadius - 10_000)));
  const capAnchor = new Cesium.Cartesian3();
  /** Surface point under the cursor, with LOLA height inside the polar cap. */
  const pickSurface = (position: Cesium.Cartesian2) => {
    if (cap && scene.pickPositionSupported) {
      const point = scene.pickPosition(position);
      const c = point && ellipsoid.cartesianToCartographic(point);
      if (c && Cesium.Math.toDegrees(c.latitude) < -87) {
        c.height = cap.heightAt(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)) ?? c.height;
        return c;
      }
    }
    const ray = scene.camera.getPickRay(position);
    const point = (ray && scene.globe.pick(ray, scene)) ?? scene.camera.pickEllipsoid(position, ellipsoid);
    return point ? ellipsoid.cartesianToCartographic(point) : undefined;
  };
  const pinBuilder = new Cesium.PinBuilder();
  const sitePin = pinBuilder.fromColor(Cesium.Color.fromCssColorString("#69ceff"), 32).toDataURL();
  const selectedPin = pinBuilder.fromColor(Cesium.Color.fromCssColorString("#ffd166"), 36).toDataURL();
  const pinClicks = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  pinClicks.setInputAction((click: {position: Cesium.Cartesian2}) => {
    if (isMoon && options?.drawing) {
      const coordinate = pickSurface(click.position);
      if (!coordinate) return;
      element.dispatchEvent(new CustomEvent("polygon-point", {detail: {
        latitude: Cesium.Math.toDegrees(coordinate.latitude), longitude: Cesium.Math.toDegrees(coordinate.longitude),
      }}));
      return;
    }
    if (isMoon && options?.pinPlacement) {
      const coordinate = pickSurface(click.position);
      if (!coordinate) return;
      element.dispatchEvent(new CustomEvent("pin-placed", {detail: {
        latitude: Cesium.Math.toDegrees(coordinate.latitude), longitude: Cesium.Math.toDegrees(coordinate.longitude), elevation: coordinate.height,
      }}));
      return;
    }
    const picked = scene.pick(click.position);
    const id = picked?.id?.id;
    if (typeof id === "string" && /^site--?\d+$/.test(id) && id !== "site--1") {
      element.dispatchEvent(new CustomEvent("site-selected", {detail:id.slice(5)}));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  // Retain nearby meshes while orbiting; refine the physical relief on approach.
  scene.globe.tileCacheSize = 256;
  scene.globe.maximumScreenSpaceError = 1.5;
  // Moon imagery and elevation are fully local. Only Earth mode streams imagery.
  const detail = !isMoon ? new Cesium.UrlTemplateImageryProvider({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    tilingScheme: new Cesium.WebMercatorTilingScheme({ ellipsoid }),
    maximumLevel: 18,
    credit: "Esri World Imagery; sources: Esri, Maxar, Earthstar Geographics and the GIS User Community",
  }) : null;
  const detailLayer = detail ? viewer.imageryLayers.addImageryProvider(detail) : null;
  let terrainShade: Cesium.ImageryLayer | null = null;
  let activeTerrainRegion = "";
  let tileFailures = 0;
  detail?.errorEvent.addEventListener(() => {
    if (++tileFailures === 4) {
      if (detailLayer) detailLayer.show = false;
      element.dispatchEvent(new CustomEvent("imagery-warning", { detail: "Detailed imagery is unavailable. Showing the bundled NASA global map." }));
    }
  });
  scene.camera.frustum.far = 2e11;
  scene.globe.enableLighting = false;
  // Depth-test 3D objects against the globe instead of clearing its depth. Without this, Cesium
  // clears the globe's depth and, near the ground, draws a depth plane at the reference sphere,
  // which hides the polar cap mesh wherever its terrain lies below the sphere (crater floors) and
  // lets the cap draw over globe mountains in front of it. Pins keep their own depth settings, and
  // lines already show a dashed style where terrain hides them.
  if (isMoon) scene.globe.depthTestAgainstTerrain = true;
  scene.globe.showGroundAtmosphere = false;
  scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.BLACK;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(0, isMoon ? -28 : 20, isMoon ? 5_200_000 : 18_000_000, ellipsoid),
  });
  const navigation = setupOrbitCamera(viewer, ellipsoid, {
    // Inside the cap: the higher of the true terrain and the drawn (possibly coarser) surface,
    // so a camera at eye height never ends up inside the mesh.
    groundHeight: c => {
      if (!cap) return undefined;
      const lat = Cesium.Math.toDegrees(c.latitude), lon = Cesium.Math.toDegrees(c.longitude);
      const terrain = cap.heightAt(lat, lon), drawn = cap.drawnHeightAt(lat, lon);
      return terrain === undefined ? undefined : Math.max(terrain, drawn ?? terrain);
    },
    pickSurface,
    surfaceAllowed: () => isMoon,
    clickTravelEnabled: () => !options?.pinPlacement && !options?.drawing,
    onSurface: status => element.dispatchEvent(new CustomEvent("surface-view", { detail: status })),
  });
  navigation.center();
  // Development-only camera readout for automated checks (the newest live globe answers).
  const readout = () => {
    const c = ellipsoid.cartesianToCartographic(viewer.camera.positionWC);
    if (!c) return null;
    const ground = cap?.heightAt(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)) ?? scene.globe.getHeight(c) ?? 0;
    return { aboveGround: c.height - ground, pitchDeg: Cesium.Math.toDegrees(viewer.camera.pitch), surface: navigation.isSurface(),
      pick: (x: number, y: number) => {
        const position = new Cesium.Cartesian2(x, y);
        const depth = scene.pickPositionSupported ? scene.pickPosition(position) : undefined;
        const hit = pickSurface(position);
        return { depthHit: !!depth, groundHeight: ground, hit: hit ? [Cesium.Math.toDegrees(hit.latitude), Cesium.Math.toDegrees(hit.longitude), hit.height] : null };
      } };
  };
  if (import.meta.env.DEV) {
    devReadouts.add(readout);
    Object.assign(globalThis, { __lunarCamera: () => [...devReadouts].at(-1)?.() ?? null });
  }
  const centeredDestination = (destination: Cesium.Cartesian3) => {
    const frame = centerFrame(destination);
    return { destination, orientation: {
      direction: new Cesium.Cartesian3(frame.direction.x, frame.direction.y, frame.direction.z),
      up: new Cesium.Cartesian3(frame.up.x, frame.up.y, frame.up.z),
    } };
  };
  let revision = 0;
  let destroyed = false;
  let lastFlight = options?.flyToTarget ?? 0;
  let skyImagesPromise: ReturnType<typeof makeSkyImages> | null = null;
  // The Sun and Earth discs live in their own data source and are created once, then only their
  // direction and label change. Removing and re-adding them (every Sky & time step) left Cesium's
  // reused billboard without its texture: the label showed, the disc did not.
  const skySource = new Cesium.CustomDataSource("sky");
  void viewer.dataSources.add(skySource);
  type SkyBody = { entity: Cesium.Entity; unit: Cesium.Cartesian3; rangeM: number; text: string };
  const skyBodies: Partial<Record<"sun" | "earth", SkyBody>> = {};
  const skyBody = (body: "sun" | "earth", color: Cesium.Color, images: Awaited<ReturnType<typeof makeSkyImages>> | null): SkyBody => {
    const existing = skyBodies[body];
    if (existing && (existing.entity.billboard || !images)) return existing;
    if (existing) skySource.entities.remove(existing.entity);       // upgrade a plain point to the image
    const radiusM = body === "earth" ? 6_371_000 : 695_700_000;
    const state: SkyBody = { entity: undefined as unknown as Cesium.Entity, unit: new Cesium.Cartesian3(0, 0, 1), rangeM: 1, text: "" };
    // The disc sits on a sky dome around the camera, in the body's true direction from the site, and
    // always beyond the Moon, so the Moon and its ridges still hide it where they should.
    const position = new Cesium.CallbackPositionProperty((_time, result) => {
      const eye = viewer.camera.positionWC;
      const dome = Math.max(SKY_DOME_M, Cesium.Cartesian3.magnitude(eye) + 4 * ellipsoid.maximumRadius);
      return Cesium.Cartesian3.add(eye, Cesium.Cartesian3.multiplyByScalar(state.unit, dome, new Cesium.Cartesian3()), result ?? new Cesium.Cartesian3());
    }, false);
    state.entity = skySource.entities.add({ name: body, position,
      billboard: images ? { image: images[body],
        // True angular size (from the real range), with a minimum so the body stays findable.
        scale: new Cesium.CallbackProperty(() => {
          const frustum = viewer.camera.frustum;
          const fov = (frustum instanceof Cesium.PerspectiveFrustum ? frustum.fovy : undefined) ?? Math.PI / 3;
          const pixels = 2 * Math.atan(radiusM / state.rangeM) / (Number.isFinite(fov) && fov > 0 ? fov : Math.PI / 3) * scene.canvas.clientHeight;
          return Math.max(body === "sun" ? 14 : 10, pixels) / (body === "sun" ? 36 : 256);
        }, false),
      } : undefined,
      point: images ? undefined : { pixelSize: 15, color },
      label: { text: new Cesium.CallbackProperty(() => state.text, false), font: "15px system-ui", fillColor: color, showBackground: true,
        pixelOffset: new Cesium.Cartesian2(0, body === "sun" ? -38 : 38) },
    });
    skyBodies[body] = state;
    return state;
  };
  const update: NonNullable<GlobeHandle["update"]> = async (nextMarkers, nextPositions, nextOptions) => {
    const current = ++revision;
    let preparedTerrain: Awaited<ReturnType<NonNullable<typeof lola>["select"]>> | null = null;
    const nextTerrainEnabled = Boolean(lola && nextOptions?.terrainEnabled !== false);
    const nextRegion = nextOptions?.terrainRegion ?? "";
    if (lola && nextTerrainEnabled && (nextRegion !== activeTerrainRegion || !terrainEnabled)) {
      element.dispatchEvent(new CustomEvent("terrain-loading", {detail:true}));
      try { preparedTerrain = await lola.select(nextRegion); } catch {
        preparedTerrain = {provider:lola.provider,imagery:null,cap:null};
        if (!destroyed) element.dispatchEvent(new CustomEvent("imagery-warning", {detail:"Could not load the prepared region. Showing global terrain; select the region again to retry."}));
      } finally { if (!destroyed && current === revision) element.dispatchEvent(new CustomEvent("terrain-loading", {detail:false})); }
    } else {
      element.dispatchEvent(new CustomEvent("terrain-loading", {detail:false}));
    }
    let skyImages: Awaited<ReturnType<typeof makeSkyImages>> | null = null;
    if (nextPositions && isMoon) {
      try { skyImages = await (skyImagesPromise ??= makeSkyImages()); } catch {
        skyImagesPromise = null;
        if (!destroyed) element.dispatchEvent(new CustomEvent("imagery-warning", { detail: "Earth texture could not load. Showing labeled body markers." }));
      }
    }
    if (destroyed || current !== revision) return;
    markers = nextMarkers; positions = nextPositions; options = nextOptions;
    const useTerrain = Boolean(lola && options?.terrainEnabled !== false);
    if (preparedTerrain || useTerrain !== terrainEnabled) {
      terrainEnabled = useTerrain;
      if (terrainShade) viewer.imageryLayers.remove(terrainShade, true);
      terrainShade = null;
      cap?.destroy(); cap = null;
      const capSource = useTerrain ? preparedTerrain?.cap ?? null : null;
      if (capSource && lola) {
        // Globe tiles stop at 87° S (no polar slivers); the cap mesh draws the rest.
        viewer.terrainProvider = lola.provider;
        scene.globe.cartographicLimitRectangle = Cesium.Rectangle.fromDegrees(-180, -87, 180, 90);
        cap = createPolarCap(scene, capSource);
        // Development-only hook for performance measurements.
        if (import.meta.env.DEV) Object.assign(globalThis, { __polarCap: cap.stats });
      } else {
        scene.globe.cartographicLimitRectangle = Cesium.Rectangle.MAX_VALUE;
        viewer.terrainProvider = useTerrain && lola ? (preparedTerrain?.provider ?? lola.provider) : flatTerrain;
        terrainShade = preparedTerrain?.imagery ? viewer.imageryLayers.addImageryProvider(preparedTerrain.imagery) : null;
      }
      activeTerrainRegion = useTerrain ? nextRegion : "";
    }
    viewer.entities.removeAll();
    for (const sky of Object.values(skyBodies)) sky.entity.show = false;

  const targetIsNamedSite = isMoon && options?.target && markers.some(marker =>
    Math.abs(marker.latitudeDeg-options!.target!.latitude)<1e-7 && Math.abs(marker.longitudeDeg-options!.target!.longitude)<1e-7);
  const displayedMarkers = [ ...(isMoon ? markers : []), ...(options?.target && !targetIsNamedSite ? [{
    id: -1, name: "Selected coordinates", description: "Coordinate destination",
    longitudeDeg: options.target.longitude, latitudeDeg: options.target.latitude, heightM: options.target.elevation,
  }] : []) ];
  for (const [index, marker] of displayedMarkers.entries()) {
    const markerCap = cap?.heightAt(marker.latitudeDeg, marker.longitudeDeg) === undefined ? null : cap;
    const isSelected = marker.id === -1 || Boolean(options?.target && Math.abs(marker.latitudeDeg - options.target.latitude) < 1e-7
      && Math.abs(marker.longitudeDeg - options.target.longitude) < 1e-7);
    const reference = markerCap ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND;
    // Moon pins are never sliced by nearby terrain (the globe is depth-tested against 3D objects):
    // no per-pixel depth test, and hidden only when the Moon itself is between pin and camera.
    const depthOff = isMoon ? Number.POSITIVE_INFINITY : 200_000;
    const capShow = isMoon ? new Cesium.CallbackProperty(() => {
      capOccluder.cameraPosition = scene.camera.positionWC;
      return capOccluder.isPointVisible(Cesium.Cartesian3.fromDegrees(marker.longitudeDeg, marker.latitudeDeg, 0, ellipsoid, capAnchor));
    }, false) : true;
    viewer.entities.add({
      id: `site-${marker.id}`,
      name: marker.name,
      description: marker.description,
      // Inside the polar cap the globe has no tiles to clamp to: follow the cap's drawn surface instead.
      position: markerCap
        ? new Cesium.CallbackPositionProperty((_time, result) => Cesium.Cartesian3.fromDegrees(marker.longitudeDeg, marker.latitudeDeg,
          markerCap.drawnHeightAt(marker.latitudeDeg, marker.longitudeDeg) ?? marker.heightM, ellipsoid, result), false)
        : Cesium.Cartesian3.fromDegrees(marker.longitudeDeg, marker.latitudeDeg, marker.heightM, ellipsoid),
      billboard: {
        image: marker.id === -1 || (options?.target && Math.abs(marker.latitudeDeg-options.target.latitude)<1e-7 && Math.abs(marker.longitudeDeg-options.target.longitude)<1e-7) ? selectedPin : sitePin,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: reference,
        disableDepthTestDistance: depthOff,
        show: capShow,
      },
      label: {
        text: marker.name,
        // Names of other pins only when the camera is within 400 km: the whole-Moon view stays readable.
        distanceDisplayCondition: isSelected ? undefined : new Cesium.DistanceDisplayCondition(0, 400_000),
        heightReference: reference,
        disableDepthTestDistance: depthOff,
        show: capShow,
        font: "13px system-ui, sans-serif",
        // Keep labels near their pins; use short alternating offsets rather
        // than increasing the displacement for every landmark in the catalog.
        pixelOffset: new Cesium.Cartesian2(16, -28 - (index % 3) * 18),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.6),
        scale: 0.85,
      },
    });
  }

  if (isMoon && options?.overlay) drawOverlay(options.overlay);

  if (positions && isMoon) {
    const origin = Cesium.Cartesian3.fromDegrees(
      positions.longitude_deg, positions.latitude_deg, positions.elevation_m, ellipsoid,
    );
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin, ellipsoid);
    const showGuides = new Cesium.CallbackProperty(() => Cesium.Cartesian3.distance(viewer.camera.positionWC, origin) > 10_000, false);
    const distance = 100_000;
    const project = (east: number, north: number, up: number) =>
      Cesium.Matrix4.multiplyByPoint(frame, new Cesium.Cartesian3(east, north, up), new Cesium.Cartesian3());
    const ring = Array.from({ length: 181 }, (_, index) => {
      const angle = index * Math.PI / 90;
      return project(distance * Math.sin(angle), distance * Math.cos(angle), 0);
    });
    viewer.entities.add({
      name: "Local horizon · elevation 0°",
      polyline: { show: showGuides, positions: ring, arcType: Cesium.ArcType.NONE, width: 2, material: Cesium.Color.WHITE.withAlpha(0.65),
        depthFailMaterial: Cesium.Color.WHITE.withAlpha(0.25) },
    });
    for (const [label, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
      const direction = localDirection(az, 0, distance * 1.12);
      viewer.entities.add({ position: project(direction.east, direction.north, direction.up),
        label: { show: showGuides, text: label, font: "16px system-ui", fillColor: Cesium.Color.WHITE,
          showBackground: true, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    for (const body of ["sun", "earth"] as const) {
      const value = positions[body];
      const color = body === "sun" ? Cesium.Color.fromCssColorString("#ffd166") : Cesium.Color.fromCssColorString("#69ceff");
      const direction = localDirection(value.azimuth_deg, value.elevation_deg, distance);
      const end = project(direction.east, direction.north, direction.up);
      const material = value.above_horizon
        ? new Cesium.PolylineArrowMaterialProperty(color)
        : new Cesium.PolylineDashMaterialProperty({ color });
      viewer.entities.add({ name: `${body} direction`, polyline: { show: showGuides,
        positions: [origin, end], arcType: Cesium.ArcType.NONE, width: 4, material,
        depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.6) }),
      } });
      const rangeM = (value.distance_km ?? (body === "earth" ? 384400 : 149597870.7)) * 1000;
      const skyDirection = localDirection(value.azimuth_deg, value.elevation_deg, rangeM);
      const skyPosition = project(skyDirection.east, skyDirection.north, skyDirection.up);
      {
        const linkColor = value.above_horizon ? color : Cesium.Color.fromCssColorString("#f59c77");
        const bodyName = body === "earth" ? "Earth" : "Sun";
        const linkDirection = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(skyPosition, origin, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        const reference = Math.abs(linkDirection.z) > 0.95 ? Cesium.Cartesian3.UNIT_Y : Cesium.Cartesian3.UNIT_Z;
        const across = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(linkDirection, reference, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        const offset = Cesium.Cartesian3.multiplyByScalar(across, body === "earth" ? 6_371_000 : 695_700_000, new Cesium.Cartesian3());
        const edgeA = Cesium.Cartesian3.add(skyPosition, offset, new Cesium.Cartesian3());
        const edgeB = Cesium.Cartesian3.subtract(skyPosition, offset, new Cesium.Cartesian3());
        // Sight lines and planes are orbit-view guides; at street level they would cut through the view.
        viewer.entities.add({ id: `${body}-moon-link`, name: `${bodyName}–Moon sight line`, polyline: {
          show: showGuides, positions: [origin, skyPosition], arcType: Cesium.ArcType.NONE, width: 2,
          material: new Cesium.PolylineDashMaterialProperty({ color: linkColor, dashLength: 20 }),
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: linkColor.withAlpha(0.2), dashLength: 20 }),
        } });
        viewer.entities.add({ id: `${body}-moon-polygon`, name: `${bodyName}–Moon visual connection plane`, polygon: {
          show: showGuides, hierarchy: new Cesium.PolygonHierarchy([origin, edgeA, edgeB]),
          perPositionHeight: true, arcType: Cesium.ArcType.NONE,
          material: linkColor.withAlpha(0.08),
        } });
        viewer.entities.add({ id: `${body}-moon-boundary`, name: `${bodyName}–Moon connection edges`, polyline: {
          show: showGuides, positions: [edgeA, origin, edgeB], arcType: Cesium.ArcType.NONE, width: 1,
          material: linkColor.withAlpha(0.45),
        } });
      }
      const sky = skyBody(body, color, skyImages);
      Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(skyPosition, origin, new Cesium.Cartesian3()), sky.unit);
      sky.rangeM = rangeM;
      sky.text = `${body === "sun" ? "Sun" : "Earth"}  ${value.elevation_deg.toFixed(2)}°\n${value.above_horizon ? "Above horizon" : "Below horizon"}`;
      sky.entity.show = true;
    }
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(positions.at_utc);
    viewer.clock.shouldAnimate = false;
  }
    // Only the explicit coordinate-flight action changes the camera.
    if ((options?.flyToTarget ?? 0) !== lastFlight) {
      lastFlight = options?.flyToTarget ?? 0;
      view(options?.flightMode ?? "site");
    }
    scene.requestRender();
  };

  /** Ground height: the polar cap's LOLA height inside 87° S, else loaded globe tiles, else the sphere. */
  const groundAt = (lat: number, lon: number) =>
    cap?.heightAt(lat, lon) ?? scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;

  function drawOverlay(overlay: NonNullable<GlobeOptions["overlay"]>) {
    const corners = overlay.polygon ?? [];
    const lift = 150;   // keep the outline just above the terrain it follows
    const path: Cesium.Cartesian3[] = [];
    const edges = overlay.closed ? corners.length : corners.length - 1;
    for (let i = 0; i < edges; i++) {
      const [lat0, lon0] = corners[i], [lat1, lon1] = corners[(i + 1) % corners.length];
      const a = Cesium.Cartesian3.normalize(Cesium.Cartesian3.fromDegrees(lon0, lat0, 0, ellipsoid), new Cesium.Cartesian3());
      const b = Cesium.Cartesian3.normalize(Cesium.Cartesian3.fromDegrees(lon1, lat1, 0, ellipsoid), new Cesium.Cartesian3());
      const angle = Cesium.Cartesian3.angleBetween(a, b);
      const steps = Math.max(1, Math.ceil(angle / 0.0005));      // about 0.9 km per segment
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        // Spherical interpolation along the great circle between the corners.
        const sa = angle > 1e-9 ? Math.sin((1 - t) * angle) / Math.sin(angle) : 1 - t;
        const sb = angle > 1e-9 ? Math.sin(t * angle) / Math.sin(angle) : t;
        const dir = Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(a, sa, new Cesium.Cartesian3()),
          Cesium.Cartesian3.multiplyByScalar(b, sb, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        const c = ellipsoid.cartesianToCartographic(dir);
        if (!c) continue;
        const lat = Cesium.Math.toDegrees(c.latitude), lon = Cesium.Math.toDegrees(c.longitude);
        path.push(Cesium.Cartesian3.fromDegrees(lon, lat, groundAt(lat, lon) + lift, ellipsoid));
      }
    }
    const outline = Cesium.Color.fromCssColorString("#fde725");
    if (path.length > 1) viewer.entities.add({ id: "mission-area", name: "Mission area", polyline: {
      positions: path, width: 3, arcType: Cesium.ArcType.NONE, material: outline,
      depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: outline.withAlpha(0.6) }),
    } });
    corners.forEach(([lat, lon], i) => viewer.entities.add({ id: `mission-corner-${i}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, groundAt(lat, lon) + lift, ellipsoid),
      point: { pixelSize: 8, color: outline, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
    overlay.spots.forEach((spot, i) => viewer.entities.add({ id: `mission-spot-${i}`, name: spot.label,
      position: Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, groundAt(spot.lat, spot.lon) + lift, ellipsoid),
      point: { pixelSize: 11, color: Cesium.Color.fromCssColorString(spot.pass ? "#5fd39a" : "#ff9b8f"),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: spot.label, font: "13px system-ui, sans-serif", pixelOffset: new Cesium.Cartesian2(12, -12),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT, showBackground: true,
        backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.6), disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
  }

  const view: NonNullable<GlobeHandle["view"]> = (mode) => {
    // Programmed flights take the camera out of surface view first.
    navigation.exitSurface(false);
    if (mode === "center") { navigation.center(); return; }
    const target = options?.target ?? (positions && isMoon ? {
      latitude: positions.latitude_deg, longitude: positions.longitude_deg, elevation: positions.elevation_m,
    } : null);
    viewer.camera.cancelFlight();
    if (mode === "globe") {
      viewer.camera.flyTo({ ...centeredDestination(Cesium.Cartesian3.fromDegrees(0, isMoon ? -28 : 20, isMoon ? 5_200_000 : 18_000_000, ellipsoid)), duration: 1.5, complete: navigation.center });
    } else if (mode === "pole" && isMoon) {
      // The 87–90 S cap has a radius of about 91 km. Frame the whole cap
      // directly above the pole, leaving room around the circular boundary.
      viewer.camera.flyTo({
        ...centeredDestination(Cesium.Cartesian3.fromDegrees(0, -90, 320_000, ellipsoid)),
        duration: 1.5, complete: navigation.center,
      });
    } else if (target && mode === "terrain" && isMoon) {
      const ground = Math.max(target.elevation, 0);
      const center = Cesium.Cartesian3.fromDegrees(target.longitude, target.latitude, ground, ellipsoid);
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
        offset: new Cesium.HeadingPitchRange(0, -Math.PI / 6, 28_000), duration: 1.5,
      });
    } else if (target && (mode === "earth" || mode === "sun") && positions && isMoon) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(target.longitude, target.latitude, Math.max(target.elevation, 0) + 250, ellipsoid),
        orientation: { heading: Cesium.Math.toRadians(positions[mode].azimuth_deg), pitch: Cesium.Math.toRadians(2), roll: 0 }, duration: 1.5,
      });
    } else if (target) {
      const destination = Cesium.Cartesian3.fromDegrees(target.longitude, target.latitude, Math.max(target.elevation, 0) + (isMoon ? 100_000 : 40_000), ellipsoid);
      viewer.camera.flyTo({ ...centeredDestination(destination), duration: 1.5, complete: navigation.center });
    }
  };
  await update(markers, positions, options);

  return {
    destroy: () => { destroyed = true; revision++; devReadouts.delete(readout); pinClicks.destroy(); navigation.destroy(); cap?.destroy(); cap = null; viewer.destroy(); },
    view,
    update,
    surfaceLook: (azimuthDeg, elevationDeg) => {
      if (navigation.isSurface()) { navigation.lookAt(azimuthDeg, elevationDeg); return; }
      if (!positions || !isMoon) return;
      // Orbit view: the direction is the one seen from the site; the camera stays where it is.
      const site = Cesium.Cartesian3.fromDegrees(positions.longitude_deg, positions.latitude_deg, positions.elevation_m, ellipsoid);
      const local = localDirection(azimuthDeg, elevationDeg, 1);
      const direction = Cesium.Matrix4.multiplyByPointAsVector(Cesium.Transforms.eastNorthUpToFixedFrame(site, ellipsoid),
        new Cesium.Cartesian3(local.east, local.north, local.up), new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(direction, direction);
      const radial = Cesium.Cartesian3.normalize(viewer.camera.positionWC, new Cesium.Cartesian3());
      const up = Cesium.Cartesian3.subtract(radial, Cesium.Cartesian3.multiplyByScalar(direction, Cesium.Cartesian3.dot(radial, direction), new Cesium.Cartesian3()), new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(up) < 1e-6) return;
      Cesium.Cartesian3.normalize(up, up);
      viewer.camera.cancelFlight();
      viewer.camera.setView({ destination: Cesium.Cartesian3.clone(viewer.camera.positionWC), orientation: { direction, up } });
      scene.requestRender();
    },
    surface: (action, at) => {
      if (action === "exit") { navigation.exitSurface(); return; }
      if (at) { navigation.enterSurface(Cesium.Cartographic.fromDegrees(at.longitude, at.latitude)); return; }
      const middle = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
      navigation.enterSurface(pickSurface(middle));
    },
  };
};
