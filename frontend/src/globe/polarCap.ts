/**
 * The 87–90° S terrain as its own mesh on a south-polar stereographic quadtree.
 *
 * Cesium's globe tiles follow latitude/longitude, so near the pole they become slivers:
 * about 32,768 tiles cover a 20 km disc at 10 m detail, each built on the main thread.
 * Square tiles in polar x/y need a few hundred at most. The globe itself is told not to
 * draw south of 87° S (Globe.cartographicLimitRectangle), so these tiles replace it there.
 *
 * Tiles have 64 × 64 cells. Level 1 tiles are 163.84 km wide (2.56 km cells); level 10
 * cells are 5 m, the native resolution of the PGDA 81 mosaic. Each vertex is shaded with
 * the same fixed-light hillshade formula that produced the previous relief image.
 */
import * as Cesium from "cesium";
import { MOON_RADIUS_M, polarToLatLon } from "./lolaSampling";

export const QUADS = 64;
export const MAX_LEVEL = 10;
export const ROOT_SIZE_M = 5 * QUADS * 2 ** MAX_LEVEL;          // 327,680 m square centred on the pole
export const DETAIL_LEVEL = 9;                                  // 10 m cells and finer read the 5 m chunks
/** 87° S on the polar stereographic plane; the globe draws everything north of it. */
export const CAP_RADIUS_M = 2 * MOON_RADIUS_M * Math.tan(1.5 * Math.PI / 180);
/** Refine until a tile's cells are at most this many pixels apart on screen. */
export const MAX_CELL_PIXELS = 2;
const BUILD_BUDGET_MS = 10;
const MAX_LIVE_TILES = 700;
// Lunar relief relative to the 1,737.4 km sphere (LOLA: about -9.1 km to +10.8 km), padded.
const RELIEF_MIN_M = -9500, RELIEF_MAX_M = 11000;
/** Depth of the skirt along the 87° S edge (covers steps against coarse globe tiles there). */
const EDGE_SKIRT_M = 4000;

export type Bounds = { left: number; bottom: number; right: number; top: number; size: number; spacing: number };

export function tileBounds(level: number, ix: number, iy: number): Bounds {
  const size = ROOT_SIZE_M / 2 ** level;
  const left = -ROOT_SIZE_M / 2 + ix * size, bottom = -ROOT_SIZE_M / 2 + iy * size;
  return { left, bottom, right: left + size, top: bottom + size, size, spacing: size / QUADS };
}

/** Whether any part of the tile lies within `radius` of the pole. */
export function touchesCap(b: Bounds, radius = CAP_RADIUS_M): boolean {
  const dx = Math.max(b.left, 0, -b.right), dy = Math.max(b.bottom, 0, -b.top);
  return Math.hypot(dx, dy) <= radius;
}

/**
 * Seam with the globe, which is clipped exactly at 87° S. The cap continues past 87° S as a
 * band two cells wide that dips below the true surface: where the globe draws it covers the
 * band; where the globe's coarser edge tiles fall short of the cap's edge (they can differ in
 * height by hundreds of metres at far zoom), the band fills the gap instead of black space.
 * Grid points beyond the band are pulled onto its outer circle and dropped deep, forming a wall.
 */
export const bandWidth = (spacing: number) => 2 * spacing;
export const bandDrop = (spacing: number) => 300 + 0.5 * spacing;
/** Outer radius of the band, plus the chord sag of a straight edge between vertices on it. */
export const edgeRadius = (spacing: number) => {
  const r = CAP_RADIUS_M + bandWidth(spacing);
  return r + spacing * spacing / (4 * r) + 1;
};

/** Moon-fixed Cartesian (m) of polar x/y at height h above the 1,737.4 km sphere. */
export function polarToCartesian(x: number, y: number, h: number, out: Float64Array, offset: number) {
  const [lat, lon] = polarToLatLon(x, y);
  const r = MOON_RADIUS_M + h, c = Math.cos(lat);
  out[offset] = r * c * Math.cos(lon); out[offset + 1] = r * c * Math.sin(lon); out[offset + 2] = r * Math.sin(lat);
}

/** Hillshade of the previous relief image: light from the upper left of the polar grid. */
export function hillshade(dzdx: number, dzdy: number) {
  const dyRow = -dzdy;                       // the relief used row gradients (rows run toward -y)
  const lighting = (0.5 * dzdx + 0.5 * dyRow + Math.SQRT1_2) / Math.sqrt(1 + dzdx * dzdx + dyRow * dyRow);
  return Math.min(1, Math.max(0, 0.18 + 0.82 * Math.max(lighting, 0))) ** 0.75;
}

export type TileMesh = { positions: Float64Array; shade: Float32Array; indices: Uint16Array; heights: Float32Array };

/** Grid of (QUADS+1)² vertices plus skirts around the edge that hide cracks between levels. */
export function buildTileMesh(b: Bounds, sample: (x: number, y: number) => number): TileMesh {
  const n = QUADS + 1, s = b.spacing, limit = edgeRadius(s);
  const clamp = (x: number, y: number): [number, number] => {
    const rho = Math.hypot(x, y);
    return rho > limit ? [x * limit / rho, y * limit / rho] : [x, y];
  };
  // Heights on a grid padded by one cell for central differences at the edges.
  const m = n + 2, heights = new Float64Array(m * m), xs = new Float64Array(m * m), ys = new Float64Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const [x, y] = clamp(b.left + (i - 1) * s, b.bottom + (j - 1) * s);
    const k = j * m + i;
    xs[k] = x; ys[k] = y;
    const h = sample(x, y);
    heights[k] = Number.isFinite(h) ? h : 0;
  }
  const border = 4 * (n - 1), skirt = 2 * s + 20;
  const positions = new Float64Array((n * n + border) * 3), shade = new Float32Array(n * n + border);
  const vertexHeights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j + 1) * m + (i + 1), v = j * n + i;
    vertexHeights[v] = heights[k];
    // Neighbours pulled onto the edge circle can nearly coincide; never divide by less than half a cell.
    const dx = Math.max(Math.hypot(xs[k + 1] - xs[k - 1], ys[k + 1] - ys[k - 1]), s / 2);
    const dy = Math.max(Math.hypot(xs[k + m] - xs[k - m], ys[k + m] - ys[k - m]), s / 2);
    shade[v] = hillshade((heights[k + 1] - heights[k - 1]) / dx, (heights[k + m] - heights[k - m]) / dy);
    // Past 87° S: the band dips below the surface (the globe draws over it); beyond the band
    // the vertices sit on its outer circle, dropped deep to form a wall.
    const rho0 = Math.hypot(b.left + i * s, b.bottom + j * s);
    const drop = rho0 > limit + s ? EDGE_SKIRT_M + skirt : rho0 > CAP_RADIUS_M ? bandDrop(s) : 0;
    polarToCartesian(xs[k], ys[k], heights[k] - drop, positions, v * 3);
  }
  // Perimeter in order: bottom row, right column, top row (reversed), left column (reversed).
  const ring: number[] = [];
  for (let i = 0; i < n - 1; i++) ring.push(i);
  for (let j = 0; j < n - 1; j++) ring.push(j * n + n - 1);
  for (let i = n - 1; i > 0; i--) ring.push((n - 1) * n + i);
  for (let j = n - 1; j > 0; j--) ring.push(j * n);
  ring.forEach((v, r) => {
    const j = Math.floor(v / n), i = v % n, k = (j + 1) * m + (i + 1), out = n * n + r;
    polarToCartesian(xs[k], ys[k], heights[k] - skirt, positions, out * 3);
    shade[out] = shade[v];
  });
  const indices = new Uint16Array((n - 1) * (n - 1) * 6 + border * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const v = j * n + i;
    indices.set([v, v + 1, v + n, v + 1, v + n + 1, v + n], p); p += 6;
  }
  for (let r = 0; r < border; r++) {
    const a = ring[r], b2 = ring[(r + 1) % border], sa = n * n + r, sb = n * n + (r + 1) % border;
    indices.set([a, b2, sa, b2, sb, sa], p); p += 6;
  }
  return { positions, shade, indices, heights: vertexHeights };
}

/**
 * Height of the drawn surface of a tile at polar x/y: the same planar interpolation as its
 * triangles (quads split along the (i+1, j)–(i, j+1) diagonal).
 */
export function meshHeightAt(b: Bounds, heights: Float32Array, x: number, y: number): number {
  const n = QUADS + 1;
  const u = Math.min(Math.max((x - b.left) / b.spacing, 0), QUADS), w = Math.min(Math.max((y - b.bottom) / b.spacing, 0), QUADS);
  const i = Math.min(Math.floor(u), QUADS - 1), j = Math.min(Math.floor(w), QUADS - 1);
  const fx = u - i, fy = w - j;
  const h00 = heights[j * n + i], h10 = heights[j * n + i + 1], h01 = heights[(j + 1) * n + i], h11 = heights[(j + 1) * n + i + 1];
  return fx + fy <= 1 ? h00 + fx * (h10 - h00) + fy * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fy) * (h10 - h11);
}

/** Conservative bounding sphere of a tile before its heights are known. */
function coarseSphere(b: Bounds) {
  const limit = edgeRadius(b.spacing), pts: Cesium.Cartesian3[] = [], tmp = new Float64Array(3);
  const lowest = RELIEF_MIN_M - EDGE_SKIRT_M - 3 * b.spacing - 20;      // includes the skirts
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) for (const h of [lowest, RELIEF_MAX_M]) {
    let x = b.left + fx * b.size, y = b.bottom + fy * b.size;
    const rho = Math.hypot(x, y);
    if (rho > limit) { x *= limit / rho; y *= limit / rho; }
    polarToCartesian(x, y, h, tmp, 0);
    pts.push(new Cesium.Cartesian3(tmp[0], tmp[1], tmp[2]));
  }
  const sphere = Cesium.BoundingSphere.fromPoints(pts);
  sphere.radius += b.spacing;                // covers the slight bulge between sample points
  return sphere;
}

const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float shade;
in float batchId;
out float v_shade;
void main() {
  vec4 p = czm_computePosition();
  v_shade = shade;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;
const FRAGMENT_SHADER = `
in float v_shade;
void main() {
  out_FragColor = czm_gammaCorrect(vec4(vec3(v_shade), 1.0));
}`;

export type CapSource = {
  /** Terrain height (m) at polar x/y; `useDetail` reads loaded 5 m chunks. */
  sample: (x: number, y: number, useDetail: boolean) => number;
  /** Load the 5 m chunks covering a polar x/y box. */
  prepareDetail?: (left: number, bottom: number, right: number, top: number) => Promise<void>;
};

type Tile = {
  level: number; ix: number; iy: number; b: Bounds; parent?: Tile;
  state: "new" | "loading" | "queued" | "ready";
  sphere: Cesium.BoundingSphere; primitive?: Cesium.Primitive; heights?: Float32Array; children?: Tile[]; used: number;
};

export function createPolarCap(scene: Cesium.Scene, source: CapSource) {
  const collection = scene.primitives.add(new Cesium.PrimitiveCollection()) as Cesium.PrimitiveCollection;
  const appearance = new Cesium.Appearance({
    translucent: false, closed: false,
    // Same as Appearance.getDefaultRenderState(false, false): opaque, depth-tested, both faces drawn.
    renderState: { depthTest: { enabled: true } },
    vertexShaderSource: VERTEX_SHADER, fragmentShaderSource: FRAGMENT_SHADER,
  });
  const make = (level: number, ix: number, iy: number, parent?: Tile): Tile => {
    const b = tileBounds(level, ix, iy);
    return { level, ix, iy, b, parent, state: "new", sphere: coarseSphere(b), used: 0 };
  };
  const roots: Tile[] = [];
  for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) roots.push(make(1, ix, iy));
  const live = new Set<Tile>();
  let frame = 0, shown = new Set<Tile>();
  /** rendered/live/built tiles, and `pending`: tiles wanted but not yet built (0 = fully loaded view). */
  const stats = { rendered: 0, live: 0, built: 0, pending: 0 };

  const childrenOf = (t: Tile) => t.children ??= [0, 1].flatMap(dy => [0, 1].map(dx => make(t.level + 1, t.ix * 2 + dx, t.iy * 2 + dy, t)))
    .filter(c => touchesCap(c.b, edgeRadius(c.b.spacing)));

  const build = (t: Tile) => {
    const useDetail = t.level >= DETAIL_LEVEL;
    const mesh = buildTileMesh(t.b, (x, y) => source.sample(x, y, useDetail));
    const attributes = new Cesium.GeometryAttributes();
    attributes.position = new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: mesh.positions });
    (attributes as unknown as Record<string, Cesium.GeometryAttribute>).shade = new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: mesh.shade });
    const sphere = Cesium.BoundingSphere.fromVertices(Array.from(mesh.positions));
    const geometry = new Cesium.Geometry({ attributes, indices: mesh.indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: sphere });
    t.primitive = collection.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }), appearance,
      asynchronous: false, allowPicking: false, compressVertices: false, releaseGeometryInstances: true,
      // The selection above already culls to the view. Cesium's own culling would also apply its
      // horizon occluder, sized from the globe's loaded terrain: with the cap carved out of the
      // globe that sphere sits above deep crater floors and wrongly hides their tiles.
      cull: false,
    })) as Cesium.Primitive;
    t.primitive.show = false;
    t.sphere = sphere;
    t.heights = mesh.heights;
    t.state = "ready";
    live.add(t);
    stats.built++;
  };

  const evict = () => {
    if (live.size <= MAX_LIVE_TILES) return;
    const keep = new Set<Tile>();
    for (const t of shown) for (let a: Tile | undefined = t; a && !keep.has(a); a = a.parent) keep.add(a);
    const old = [...live].filter(t => !keep.has(t)).sort((a, c) => a.used - c.used);
    for (const t of old.slice(0, live.size - MAX_LIVE_TILES)) {
      collection.remove(t.primitive!);
      t.primitive = undefined; t.heights = undefined; t.state = "new"; live.delete(t);
    }
  };

  const update = () => {
    frame++;
    const camera = scene.camera, frustum = camera.frustum as Cesium.PerspectiveFrustum;
    const culling = frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
    const fovy = frustum.fovy ?? Math.PI / 3;
    const perPixel = 2 * Math.tan(fovy / 2) / Math.max(scene.drawingBufferHeight, 1);
    const render: Tile[] = [], wanted: Tile[] = [];
    const visible = (t: Tile) => culling.computeVisibility(t.sphere) !== Cesium.Intersect.OUTSIDE;
    const distance = (t: Tile) => Math.max(1, Math.sqrt(Cesium.BoundingSphere.distanceSquaredTo(t.sphere, camera.positionWC)));
    const visit = (t: Tile) => {
      t.used = frame;
      if (!visible(t)) return;
      if (t.level < MAX_LEVEL && t.b.spacing / (distance(t) * perPixel) > MAX_CELL_PIXELS) {
        const kids = childrenOf(t).filter(visible);
        if (kids.every(k => k.state === "ready")) { kids.forEach(visit); return; }
        for (const k of kids) if (k.state !== "ready") { k.used = frame; wanted.push(k); }
      }
      if (t.state === "ready") render.push(t); else wanted.push(t);
    };
    roots.forEach(visit);
    const next = new Set(render);
    for (const t of shown) if (!next.has(t) && t.primitive) t.primitive.show = false;
    for (const t of next) t.primitive!.show = true;
    shown = next;
    stats.rendered = next.size;

    // Coarse first, then nearest, within a per-frame time budget.
    wanted.sort((a, c) => a.level - c.level || distance(a) - distance(c));
    const start = performance.now();
    for (const t of wanted) {
      if (t.state === "new") {
        if (t.level >= DETAIL_LEVEL && source.prepareDetail) {
          t.state = "loading";
          source.prepareDetail(t.b.left, t.b.bottom, t.b.right, t.b.top)
            .catch(() => undefined).then(() => { if (t.state === "loading") t.state = "queued"; });
          continue;
        }
        t.state = "queued";
      }
      if (t.state === "queued" && performance.now() - start < BUILD_BUDGET_MS) build(t);
    }
    evict();
    stats.live = live.size;
    stats.pending = new Set(wanted).size;
  };
  scene.preUpdate.addEventListener(update);

  return {
    stats,
    /**
     * Height of the surface as currently drawn (the visible tile's triangles), so markers sit
     * on it like globe-clamped billboards. Falls back to the terrain height.
     */
    drawnHeightAt(latitudeDeg: number, longitudeDeg: number) {
      if (latitudeDeg > -87) return undefined;
      const lat = latitudeDeg * Math.PI / 180, lon = longitudeDeg * Math.PI / 180;
      const rho = 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + lat / 2);
      const x = rho * Math.sin(lon), y = rho * Math.cos(lon);
      const inside = (t: Tile) => x >= t.b.left && x <= t.b.right && y >= t.b.bottom && y <= t.b.top;
      let t = roots.find(inside);
      while (t && !shown.has(t)) t = t.children?.find(inside);
      return t?.heights ? meshHeightAt(t.b, t.heights, x, y) : source.sample(x, y, true);
    },
    /** Terrain height (m) at a latitude/longitude inside the cap, else undefined. */
    heightAt(latitudeDeg: number, longitudeDeg: number) {
      if (latitudeDeg > -87) return undefined;
      const lat = latitudeDeg * Math.PI / 180, lon = longitudeDeg * Math.PI / 180;
      const rho = 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + lat / 2);
      return source.sample(rho * Math.sin(lon), rho * Math.cos(lon), true);
    },
    destroy() {
      scene.preUpdate.removeEventListener(update);
      if (!scene.isDestroyed()) scene.primitives.remove(collection);
    },
  };
}
export type PolarCap = ReturnType<typeof createPolarCap>;
