import { expect, test } from "vitest";
import { positionsAt, trackEnd, trackStart, type SkyTrack } from "./skyTrack";

const track: SkyTrack = {
  latitude_deg: -89.44, longitude_deg: 8.13, elevation_m: -427, start_utc: "2026-12-01T00:00:00Z", step_minutes: 30, count: 3,
  sun: { azimuth_deg: [350, 10, 30], elevation_deg: [1, 2, -1], distance_km: [1.5e8, 1.5e8, 1.5e8] },
  earth: { azimuth_deg: [100, 101, 102], elevation_deg: [-3, -2, -1], distance_km: [384000, 385000, 386000] },
  source: "JPL Horizons", source_url: "https://ssd.jpl.nasa.gov/api/horizons.api",
};

test("samples interpolate between Horizons epochs, wrapping azimuth the short way", () => {
  const start = trackStart(track);
  expect(trackEnd(track) - start).toBe(60 * 60000);
  const p = positionsAt(track, start + 15 * 60000);           // halfway between the first two samples
  expect(p.sun.azimuth_deg).toBeCloseTo(0, 9);                  // 350° -> 10° passes through north
  expect(p.sun.elevation_deg).toBeCloseTo(1.5, 9);
  expect(p.earth.distance_km).toBeCloseTo(384500, 6);
  expect(p.at_utc).toBe("2026-12-01T00:15:00.000Z");
  expect(p.latitude_deg).toBe(-89.44);
});

test("times outside the track are clamped and horizon flags follow elevation", () => {
  const before = positionsAt(track, trackStart(track) - 1e6), after = positionsAt(track, trackEnd(track) + 1e6);
  expect(before.sun.azimuth_deg).toBeCloseTo(350, 9);
  expect(after.sun.elevation_deg).toBeCloseTo(-1, 9);
  expect(after.sun.above_horizon).toBe(false);
  expect(positionsAt(track, trackStart(track)).sun.above_horizon).toBe(true);
});
