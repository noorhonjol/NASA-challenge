import * as Cesium from "cesium";
import type { SiteMarker } from "./siteMarkers";

export type GlobeHandle = {
  destroy(): void;
};

export type CreateGlobe = (
  element: HTMLElement,
  markers: SiteMarker[],
) => Promise<GlobeHandle>;

/** NASA SVS CGI Moon Kit colour map (LRO LROC WAC mosaic), public domain. */
export const MOON_TEXTURE_URL = "/textures/lroc_color_2k.jpg";

const MOON_CREDIT = "NASA SVS / LRO LROC WAC mosaic";

/**
 * Build a navigable lunar globe. Everything here is Moon-specific: the
 * ellipsoid is Ellipsoid.MOON (1,737.4 km) for the terrain provider, the
 * imagery rectangle and every entity position, and Earth-only scene effects
 * (atmosphere, fog, sky moon/sun) are switched off.
 */
export const createLunarGlobe: CreateGlobe = async (element, markers) => {
  const ellipsoid = Cesium.Ellipsoid.MOON;

  // Cesium's camera, projection and cartographic conversions default to WGS84.
  // This must happen before the Viewer is constructed or the camera reasons in
  // Earth radii and ends up "below ground" on a 1,737 km sphere.
  Cesium.Ellipsoid.default = ellipsoid;

  const imagery = await Cesium.SingleTileImageryProvider.fromUrl(MOON_TEXTURE_URL, {
    rectangle: Cesium.Rectangle.MAX_VALUE,
    ellipsoid,
    credit: MOON_CREDIT,
  });

  const viewer = new Cesium.Viewer(element, {
    baseLayer: new Cesium.ImageryLayer(imagery),
    globe: new Cesium.Globe(ellipsoid),
    terrainProvider: new Cesium.EllipsoidTerrainProvider({ ellipsoid }),
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
  });

  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.BLACK;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  for (const [index, marker] of markers.entries()) {
    viewer.entities.add({
      id: `site-${marker.id}`,
      name: marker.name,
      description: marker.description,
      position: Cesium.Cartesian3.fromDegrees(
        marker.longitudeDeg,
        marker.latitudeDeg,
        marker.heightM,
        ellipsoid,
      ),
      point: {
        pixelSize: 9,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: marker.name,
        font: "13px system-ui, sans-serif",
        // The seeded sites are within a few degrees of each other, so labels
        // are staggered or they overlap at the default framing.
        pixelOffset: new Cesium.Cartesian2(0, -22 - index * 20),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.6),
        scale: 0.85,
      },
    });
  }

  // The seeded sites sit near the south pole, so open there rather than over
  // the near side. The altitude keeps the whole disc inside the 2:1 panel.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(0, -89.9, 4_800_000, ellipsoid),
  });

  return {
    destroy: () => viewer.destroy(),
  };
};
