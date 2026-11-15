/**
 * Street-view style camera on the lunar surface: pure vector math, no Cesium.
 *
 * State is a unit radial vector `up` (where you stand), a unit tangent `fwd` (the horizontal
 * direction you face) and a `pitch` (look up/down). Moving rotates `up` and `fwd` together
 * about an axis through the Moon's centre, which carries the facing direction along the
 * surface (parallel transport). Unlike heading/latitude/longitude this stays smooth across
 * the south pole, where most of the app's sites are.
 */
export type Vec = { x: number; y: number; z: number };

export const EYE_HEIGHT_M = 20;             // a little above an astronaut's eye level, so nearby bumps do not fill the view
export const ENTER_ALTITUDE_M = 800;       // zooming in below this (above ground) switches to surface view
export const EXIT_ALTITUDE_M = 1500;       // leaving surface view rises to this, above the entry height
export const WALK_SPEED_M_S = 30;
export const RUN_SPEED_M_S = 240;          // with Shift
export const PITCH_LIMIT = 85 * Math.PI / 180;
export const ARRIVAL_PITCH = -8 * Math.PI / 180;    // slightly below the horizon after landing

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const length = (a: Vec) => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec): Vec => scale(a, 1 / length(a));

export function rotate(v: Vec, axis: Vec, angle: number): Vec {
  const n = normalize(axis), c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(n, v), s)), scale(n, dot(n, v) * (1 - c)));
}

/** `v` with its radial part removed and normalised, or undefined when `v` is (nearly) radial. */
export function horizontal(v: Vec, up: Vec): Vec | undefined {
  const h = add(v, scale(up, -dot(v, up)));
  return length(h) < 1e-9 ? undefined : normalize(h);
}

export type Surface = { up: Vec; fwd: Vec; pitch: number };

/** Surface state from a camera: stand below it, facing where it looks (screen-up when looking straight down). */
export function fromCamera(position: Vec, direction: Vec, cameraUp: Vec): Surface {
  const up = normalize(position);
  const fwd = horizontal(direction, up) ?? horizontal(cameraUp, up) ?? horizontal({ x: 0, y: 0, z: 1 }, up) ?? { x: 1, y: 0, z: 0 };
  return { up, fwd, pitch: Math.asin(Math.max(-1, Math.min(1, dot(normalize(direction), up)))) };
}

/** Camera basis for a surface state at distance `radius` from the Moon's centre. */
export function cameraFrame(s: Surface, radius: number) {
  const c = Math.cos(s.pitch), si = Math.sin(s.pitch);
  return {
    position: scale(s.up, radius),
    direction: add(scale(s.fwd, c), scale(s.up, si)),
    up: add(scale(s.fwd, -si), scale(s.up, c)),
  };
}

/** Grab-to-look: turn right by `yaw` (rad) and raise the view by `dPitch`, within ±85°. */
export function look(s: Surface, yaw: number, dPitch: number): Surface {
  return { up: s.up, fwd: normalize(rotate(s.fwd, s.up, -yaw)),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, s.pitch + dPitch)) };
}

/** Walk `forward` and `right` metres along the surface of a sphere of `radius`, keeping the facing direction. */
export function walk(s: Surface, forward: number, right: number, radius: number): Surface {
  const rightDir = cross(s.fwd, s.up);
  const step = add(scale(s.fwd, forward), scale(rightDir, right));
  const dist = length(step);
  if (dist < 1e-9) return s;
  const axis = cross(s.up, scale(step, 1 / dist));
  const angle = dist / radius;
  return { up: normalize(rotate(s.up, axis, angle)), fwd: normalize(rotate(s.fwd, axis, angle)), pitch: s.pitch };
}

/** Great-circle path from `s` to `target` (a radial direction); `at(f)` keeps the facing direction transported along it. */
export function travel(s: Surface, target: Vec) {
  const to = normalize(target);
  let axis = cross(s.up, to);
  // atan2 stays accurate for tiny angles, where acos of a dot product near 1 does not.
  const angle = Math.atan2(length(axis), dot(s.up, to));
  if (length(axis) < 1e-12) axis = cross(s.up, s.fwd);           // same point (or antipode): no turn
  return {
    angle,
    at(f: number): Surface {
      if (angle < 1e-9) return s;                                   // under ~2 mm: already there
      return { up: normalize(rotate(s.up, axis, angle * f)), fwd: normalize(rotate(s.fwd, axis, angle * f)), pitch: s.pitch };
    },
  };
}

/** Compass heading (deg, clockwise from north) of the facing direction; undefined exactly at a pole. */
export function headingDeg(s: Surface): number | undefined {
  const north = horizontal({ x: 0, y: 0, z: 1 }, s.up);
  if (!north) return undefined;
  const east = cross(north, s.up);
  return (Math.atan2(dot(s.fwd, east), dot(s.fwd, north)) * 180 / Math.PI + 360) % 360;
}

/** Face compass azimuth `azimuthDeg` (clockwise from north) at elevation `elevationDeg` (within ±85°). */
export function facing(s: Surface, azimuthDeg: number, elevationDeg: number): Surface {
  const north = horizontal({ x: 0, y: 0, z: 1 }, s.up) ?? s.fwd;
  const east = cross(north, s.up), a = azimuthDeg * Math.PI / 180;
  return { up: s.up, fwd: normalize(add(scale(north, Math.cos(a)), scale(east, Math.sin(a)))),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, elevationDeg * Math.PI / 180)) };
}

export const easeInOut = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Seconds for a click-to-travel hop of `metres`: short hops are quick, long ones capped. */
export const travelSeconds = (metres: number) => Math.min(3.5, Math.max(0.7, 0.7 + metres / 1500));

/** Extra height of a travel hop at fraction f: a gentle arc that clears small rises. */
export const hopHeight = (metres: number, f: number) => 4 * Math.min(metres * 0.12, 400) * f * (1 - f);
