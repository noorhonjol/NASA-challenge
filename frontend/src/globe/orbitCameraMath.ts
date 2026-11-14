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

export function orbitFrame(frame: CameraFrame, horizontal: number, vertical: number): CameraFrame {
  const radius = magnitude(frame.position);
  const centered = centerFrame(frame.position, frame.up);
  const right = unit(cross(centered.direction, centered.up));
  const yawedPosition = rotate(frame.position, centered.up, horizontal);
  const yawedRight = rotate(right, centered.up, horizontal);
  const nextPosition = rotate(yawedPosition, yawedRight, vertical);
  const nextUp = rotate(centered.up, yawedRight, vertical);
  // Normalize explicitly to avoid accumulating radius drift over many drags.
  return centerFrame(scale(unit(nextPosition), radius), nextUp);
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
