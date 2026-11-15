import * as Cesium from "cesium";

/** Score 0-100 to an RGB colour: dark purple, blue, teal, green, yellow (brighter is better). */
const STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export function scoreRgb(score: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, score / 100));
  const x = t * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  return STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * f)) as [number, number, number];
}

export type SurfaceInput = { cells: [number, number][]; cellRows: number[]; cellCols: number[]; values: (number | null)[] };
type Vec = { x: number; y: number; z: number };
const RAD = Math.PI / 180;
const unit = (lat: number, lon: number): Vec => ({ x: Math.cos(lat * RAD) * Math.cos(lon * RAD), y: Math.cos(lat * RAD) * Math.sin(lon * RAD), z: Math.sin(lat * RAD) });
const angle = (a: Vec, b: Vec) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));

/**
 * A smooth surface through the sampled cell centres: every square of four neighbouring cells
 * (or three, at the edge) is split into small triangles, with positions and scores interpolated
 * bilinearly, so colours blend smoothly between samples. Returns lat/lon/score per vertex
 * (score null where any corner lacks a value) and triangle indices.
 */
export function surfaceMesh(input: SurfaceInput, maxSpacingRad = 300 / 1_737_400) {
  const at = new Map<string, number>();
  input.cellRows.forEach((r, i) => at.set(`${r},${input.cellCols[i]}`, i));
  const lat: number[] = [], lon: number[] = [], score: (number | null)[] = [], indices: number[] = [];
  const dirs = input.cells.map(([a, b]) => unit(a, b));
  const vertex = (weights: [number, number][]) => {
    let x = 0, y = 0, z = 0, v = 0, missing = false;
    for (const [i, w] of weights) {
      x += dirs[i].x * w; y += dirs[i].y * w; z += dirs[i].z * w;
      const s = input.values[i];
      if (w <= 1e-12) continue;                 // corners that do not contribute cannot blank it
      if (s == null) missing = true; else v += s * w;
    }
    const n = Math.hypot(x, y, z);
    lat.push(Math.asin(z / n) / RAD); lon.push(Math.atan2(y, x) / RAD); score.push(missing ? null : v);
    return lat.length - 1;
  };
  for (let i = 0; i < input.cells.length; i++) {
    const r = input.cellRows[i], c = input.cellCols[i];
    const right = at.get(`${r},${c + 1}`), down = at.get(`${r + 1},${c}`), diag = at.get(`${r + 1},${c + 1}`);
    const corners = [i, right, diag, down];
    const present = corners.filter(k => k !== undefined).length;
    if (present < 3) continue;
    const side = Math.max(...corners.filter((k): k is number => k !== undefined).map(k => angle(dirs[i], dirs[k])));
    const n = Math.max(1, Math.min(24, Math.ceil(side / maxSpacingRad)));
    if (present === 4) {
      const grid: number[][] = [];
      for (let a = 0; a <= n; a++) {
        grid.push([]);
        for (let b = 0; b <= n; b++) {
          const u = b / n, v = a / n;               // u along the row (to "right"), v down the column
          grid[a].push(vertex([[i, (1 - u) * (1 - v)], [right!, u * (1 - v)], [diag!, u * v], [down!, (1 - u) * v]]));
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const p = grid[a][b], q = grid[a][b + 1], s = grid[a + 1][b], t = grid[a + 1][b + 1];
        indices.push(p, q, t, p, t, s);
      }
    } else {
      // Three corners: one triangle, subdivided with barycentric weights.
      const [A, B, C] = corners.filter((k): k is number => k !== undefined);
      const row: number[][] = [];
      for (let a = 0; a <= n; a++) {
        row.push([]);
        for (let b = 0; b <= n - a; b++) {
          const wb = b / n, wc = a / n;
          row[a].push(vertex([[A, 1 - wb - wc], [B, wb], [C, wc]]));
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < n - a; b++) {
        indices.push(row[a][b], row[a][b + 1], row[a + 1][b]);
        if (b < n - a - 1) indices.push(row[a][b + 1], row[a + 1][b + 1], row[a + 1][b]);
      }
    }
  }
  return { lat, lon, score, indices };
}

const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
out vec4 v_color;
void main() {
  vec4 p = czm_computePosition();
  v_color = color;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;
const FRAGMENT_SHADER = `
in vec4 v_color;
void main() {
  if (v_color.a < 0.01) discard;
  out_FragColor = czm_gammaCorrect(v_color);
}`;

/** The surface as a translucent primitive just above the ground (`groundAt` gives heights). */
export function scoreSurfacePrimitive(input: SurfaceInput, ellipsoid: Cesium.Ellipsoid, groundAt: (lat: number, lon: number) => number, lift = 40, alpha = 0.6) {
  const mesh = surfaceMesh(input);
  if (!mesh.indices.length) return null;
  const positions = new Float64Array(mesh.lat.length * 3);
  const colors = new Uint8Array(mesh.lat.length * 4);
  mesh.lat.forEach((la, i) => {
    const p = Cesium.Cartesian3.fromDegrees(mesh.lon[i], la, groundAt(la, mesh.lon[i]) + lift, ellipsoid);
    positions.set([p.x, p.y, p.z], i * 3);
    const s = mesh.score[i];
    if (s != null) colors.set([...scoreRgb(s), Math.round(alpha * 255)], i * 4);
  });
  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions });
  attributes.color = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: colors });
  const geometry = new Cesium.Geometry({ attributes, indices: new Uint32Array(mesh.indices), primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)) });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.Appearance({
      translucent: true, closed: false,
      renderState: { depthTest: { enabled: true }, depthMask: false, blending: Cesium.BlendingState.ALPHA_BLEND, cull: { enabled: false } },
      vertexShaderSource: VERTEX_SHADER, fragmentShaderSource: FRAGMENT_SHADER,
    }),
    asynchronous: false, allowPicking: false, compressVertices: false, releaseGeometryInstances: true, cull: false,
  });
}
