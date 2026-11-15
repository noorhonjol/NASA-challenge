/** Camera geometry in body-centered Cartesian coordinates. Angles are radians. */
export type Vector = { x: number; y: number; z: number };
export type CameraFrame = { position: Vector; direction: Vector; up: Vector };
const dot = (a: Vector, b: Vector) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Vector, s: number): Vector => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: Vector, b: Vector): Vector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const cross = (a: Vector, b: Vector): Vector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const magnitude = (v: Vector) => Math.hypot(v.x, v.y, v.z);
const unit = (v: Vector) => scale(v, 1 / magnitude(v));

function rotate(v: Vector, axis: Vector, angle: number): Vector {
  // Rodrigues' rotation formula preserves lengths and the camera's spherical path.
  const n = unit(axis), c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(n, v), s)), scale(n, dot(n, v) * (1 - c)));
}

function tangentUp(direction: Vector, preferred: Vector): Vector {
  let up = add(preferred, scale(direction, -dot(preferred, direction)));
  if (magnitude(up) < 1e-8) {
    const fallback = Math.abs(direction.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    up = add(fallback, scale(direction, -dot(fallback, direction)));
  }
  return unit(up);
}

export function centerFrame(position: Vector, preferredUp: Vector = { x: 0, y: 0, z: 1 }): CameraFrame {
  const direction = scale(unit(position), -1);
  return { position: { ...position }, direction, up: tangentUp(direction, preferredUp) };
}

/** Unit vector of `v` with its radial part removed, or null when `v` is nearly radial. */
function tangent(v: Vector, radial: Vector): Vector | null {
  const t = add(v, scale(radial, -dot(v, radial)));
  return magnitude(t) < 1e-6 ? null : unit(t);
}

/**
 * Moves the camera over the sphere as one rigid rotation about the body center,
 * applied to position, direction and up alike. Tilt, roll and look direction
 * relative to the local vertical are therefore unchanged by orbiting.
 * Drag axes follow the screen: vertical drags rotate about the camera's
 * horizontal (right) axis, horizontal drags about the matching tangent axis.
 */
export function orbitFrame(frame: CameraFrame, horizontal: number, vertical: number): CameraFrame {
  const radius = magnitude(frame.position);
  const radial = unit(frame.position);
  const cameraRight = cross(frame.direction, frame.up);
  // A camera rolled so its right axis points straight up or down: use its up axis instead.
  const tangentRight = tangent(cameraRight, radial);
  const yawAxis = tangentRight ? unit(cross(radial, tangentRight)) : tangent(frame.up, radial) ?? centerFrame(frame.position).up;
  const pitchAxis = rotate(tangentRight ?? unit(cross(yawAxis, radial)), yawAxis, horizontal);
  const turn = (v: Vector) => rotate(rotate(v, yawAxis, horizontal), pitchAxis, vertical);
  // Normalize explicitly to avoid accumulating radius or basis drift over many drags.
  const direction = unit(turn(frame.direction));
  return { position: scale(unit(turn(frame.position)), radius), direction, up: tangentUp(direction, turn(frame.up)) };
}

export function lookFrame(frame: CameraFrame, horizontal: number, vertical: number): CameraFrame {
  const up = tangentUp(unit(frame.direction), frame.up);
  const right = unit(cross(frame.direction, up));
  const direction = rotate(frame.direction, up, -horizontal);
  const yawedRight = rotate(right, up, -horizontal);
  return { position: { ...frame.position }, direction: unit(rotate(direction, yawedRight, -vertical)), up: unit(rotate(up, yawedRight, -vertical)) };
}

export function rollFrame(frame: CameraFrame, angle: number): CameraFrame {
  return { position: { ...frame.position }, direction: { ...frame.direction }, up: unit(rotate(frame.up, frame.direction, angle)) };
}

export function zoomFrame(frame: CameraFrame, factor: number, bodyRadius: number, minAltitude: number, maxAltitude: number): CameraFrame {
  const altitude = Math.max(minAltitude, magnitude(frame.position) - bodyRadius);
  const nextRadius = bodyRadius + Math.max(minAltitude, Math.min(maxAltitude, altitude * factor));
  return { ...frame, position: scale(unit(frame.position), nextRadius) };
}

/**
 * Orbit drag speed: radians of rotation about the body centre per dragged pixel, so that the ground
 * below the camera moves with the pointer (grab-and-spin). One pixel spans 2·tan(fovy/2)/height of
 * the view at that ground, i.e. that distance divided by the body radius as an angle. Capped at
 * half a turn per screen height for far views, where the Moon is small.
 */
export function grabScale(fovy: number, heightPx: number, altitudeM: number, bodyRadiusM: number) {
  return Math.min(Math.PI / heightPx, 2 * Math.tan(fovy / 2) / heightPx * altitudeM / bodyRadiusM);
}
