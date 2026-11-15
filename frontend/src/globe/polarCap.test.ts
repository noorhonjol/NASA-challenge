import { expect, test } from "vitest";
import {
  CAP_RADIUS_M, MAX_LEVEL, QUADS, ROOT_SIZE_M, bandDrop, buildTileMesh, edgeRadius, hillshade, meshHeightAt,
  tileBounds, touchesCap,
} from "./polarCap";
import { MOON_RADIUS_M, polarToLatLon } from "./lolaSampling";

const radiusOf = (p: Float64Array, v: number) => Math.hypot(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
const polarOf = (p: Float64Array, v: number) => {
  const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
  const lat = Math.asin(z / Math.hypot(x, y, z)), lon = Math.atan2(y, x);
  const rho = 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + lat / 2);
  return [rho * Math.sin(lon), rho * Math.cos(lon)];
};

test("the quadtree reaches the 5 m native resolution and the cap edge is 87 S", () => {
  expect(tileBounds(MAX_LEVEL, 0, 0).spacing).toBeCloseTo(5, 9);
  expect(ROOT_SIZE_M / 2).toBeGreaterThan(CAP_RADIUS_M);
  const [lat] = polarToLatLon(CAP_RADIUS_M, 0);
  expect(lat * 180 / Math.PI).toBeCloseTo(-87, 9);
  // Level-1 quadrants each touch the pole; a far corner tile does not reach the cap.
  for (const [ix, iy] of [[0, 0], [0, 1], [1, 0], [1, 1]]) expect(touchesCap(tileBounds(1, ix, iy))).toBe(true);
  expect(touchesCap(tileBounds(3, 0, 0))).toBe(false);
});

test("shading reproduces the previous relief image's formula", () => {
  // relief: lighting = (-dx*-.5 + dy*.5 + sqrt(.5)) / sqrt(1+dx²+dy²) with dy the row (-y) gradient.
  for (const [dzdx, dzdy] of [[0, 0], [0.3, -0.2], [-1, 0.5], [2, 2]]) {
    const dy = -dzdy;
    const lighting = (dzdx * 0.5 + dy * 0.5 + Math.sqrt(0.5)) / Math.sqrt(1 + dzdx * dzdx + dy * dy);
    expect(hillshade(dzdx, dzdy)).toBeCloseTo(Math.min(1, Math.max(0, 0.18 + 0.82 * Math.max(lighting, 0))) ** 0.75, 12);
  }
});

test("a flat tile lies on the sphere at its heights, with skirts below every edge vertex", () => {
  const b = tileBounds(6, 32, 32);                 // touches the pole, well inside the cap
  const mesh = buildTileMesh(b, () => 250);
  const n = QUADS + 1;
  expect(mesh.shade.length).toBe(n * n + 4 * QUADS);
  expect(mesh.indices.length).toBe(QUADS * QUADS * 6 + 4 * QUADS * 6);
  for (let v = 0; v < n * n; v++) expect(radiusOf(mesh.positions, v)).toBeCloseTo(MOON_RADIUS_M + 250, 3);
  for (let v = n * n; v < n * n + 4 * QUADS; v++) expect(radiusOf(mesh.positions, v)).toBeLessThan(MOON_RADIUS_M + 250 - 2 * b.spacing);
  const [x, y] = polarOf(mesh.positions, 0);
  expect(x).toBeCloseTo(b.left, 3); expect(y).toBeCloseTo(b.bottom, 3);
  expect(Math.max(...mesh.indices)).toBeLessThan(n * n + 4 * QUADS);
  expect(new Set(mesh.shade).size).toBe(1);        // flat ground: uniform shade
});

test("past 87 S the mesh dips into the seam band, then ends in a deep wall on its outer circle", () => {
  const b = tileBounds(3, 6, 4);                   // x 82-123 km, y 0-41 km: straddles the 87 S edge
  const s = b.spacing, n = QUADS + 1;
  const mesh = buildTileMesh(b, () => 0);
  let inside = 0, band = 0, wall = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = j * n + i, rho0 = Math.hypot(b.left + i * s, b.bottom + j * s);
    const [x, y] = polarOf(mesh.positions, v), h = radiusOf(mesh.positions, v) - MOON_RADIUS_M;
    expect(Math.hypot(x, y)).toBeLessThanOrEqual(edgeRadius(s) + 1e-3);
    if (rho0 <= CAP_RADIUS_M) { expect(h).toBeCloseTo(0, 3); inside++; }
    else if (rho0 <= edgeRadius(s) + s) { expect(h).toBeCloseTo(-bandDrop(s), 3); band++; }
    else { expect(h).toBeLessThan(-4000); wall++; }
  }
  expect(inside && band && wall).toBeTruthy();
});

test("pins follow the drawn triangles: interpolation matches each split quad exactly", () => {
  const b = tileBounds(10, 512, 512), n = QUADS + 1;
  const heights = new Float32Array(n * n).map((_, v) => (v % n) * 3 + Math.floor(v / n) * 7);   // a plane
  // On a plane every interpolation is exact.
  expect(meshHeightAt(b, heights, b.left + 12.3 * b.spacing, b.bottom + 40.6 * b.spacing)).toBeCloseTo(12.3 * 3 + 40.6 * 7, 4);
  // A single bumped vertex: the lower-left triangle sees it, the upper-right one does not.
  const bump = new Float32Array(n * n); bump[0] = 10;
  expect(meshHeightAt(b, bump, b.left + 0.25 * b.spacing, b.bottom + 0.25 * b.spacing)).toBeCloseTo(5, 6);
  expect(meshHeightAt(b, bump, b.left + 0.75 * b.spacing, b.bottom + 0.75 * b.spacing)).toBeCloseTo(0, 6);
});
