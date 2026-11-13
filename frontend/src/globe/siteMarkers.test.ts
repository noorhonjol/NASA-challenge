import { expect, test } from "vitest";
import type { Site } from "../api/client";
import { toSiteMarkers } from "./siteMarkers";

const basin: Site = {
  id: 3,
  slug: "de-gerlache-basin-fictional",
  name: "de Gerlache Basin Floor (fictional)",
  lat_deg: -88.5,
  lon_deg: -87.1,
  elevation_m: null,
  frame: "MOON_ME",
  is_fictional: true,
  notes: null,
};

const rim: Site = { ...basin, id: 1, slug: "shackleton-rim-fictional", name: "Shackleton Rim (fictional)", lat_deg: -89.45, lon_deg: 129.2, elevation_m: 1400 };

test("maps lunar coordinates and elevation onto a marker", () => {
  const [marker] = toSiteMarkers([rim]);
  expect(marker.latitudeDeg).toBe(-89.45);
  expect(marker.longitudeDeg).toBe(129.2);
  expect(marker.heightM).toBe(1400);
});

test("uses zero height when elevation is unknown so the pin still renders", () => {
  const [marker] = toSiteMarkers([basin]);
  expect(marker.heightM).toBe(0);
});

test("keeps the lunar frame and identifies each site", () => {
  const markers = toSiteMarkers([rim, basin]);
  expect(markers.map((m) => m.id)).toEqual([1, 3]);
  expect(markers.every((m) => m.frame === "MOON_ME")).toBe(true);
  expect(markers[1].name).toBe("de Gerlache Basin Floor (fictional)");
});
