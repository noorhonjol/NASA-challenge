import { expect, test } from "vitest";
import { centerFrame, lookFrame, magnitude, orbitFrame, rollFrame, zoomFrame, type CameraFrame } from "./orbitCameraMath";

const dot = (a: {x: number; y: number; z: number}, b: {x: number; y: number; z: number}) => a.x * b.x + a.y * b.y + a.z * b.z;
const initial = () => centerFrame({ x: 0, y: 0, z: 2_000_000 });

test("orbit stays on the same shell and looks exactly at the center through repeated pole crossings", () => {
  let frame = initial();
  for (let i = 0; i < 1500; i++) {
    frame = orbitFrame(frame, 0.017, -0.029);
    expect(magnitude(frame.position)).toBeCloseTo(2_000_000, 5);
    expect(dot(frame.position, frame.direction) / magnitude(frame.position)).toBeCloseTo(-1, 12);
    expect(dot(frame.direction, frame.up)).toBeCloseTo(0, 12);
    expect(magnitude(frame.up)).toBeCloseTo(1, 12);
  }
});

test("dragging left or up moves along the sphere in the requested camera-relative direction", () => {
  const start: CameraFrame = { position: {x: 0, y: 0, z: 2}, direction: {x: 0, y: 0, z: -1}, up: {x: 0, y: 1, z: 0} };
  expect(orbitFrame(start, -0.1, 0).position.x).toBeLessThan(0);
  expect(orbitFrame(start, 0, -0.1).position.y).toBeGreaterThan(0);
});

test("free-look changes orientation without translating the camera", () => {
  const start = initial(), looked = lookFrame(start, 0.3, -0.2);
  expect(looked.position).toEqual(start.position);
  expect(looked.direction).not.toEqual(start.direction);
  expect(dot(looked.direction, looked.up)).toBeCloseTo(0, 12);
});

test("roll only rotates around the viewing ray", () => {
  const start = initial(), rolled = rollFrame(start, Math.PI / 2);
  expect(rolled.position).toEqual(start.position);
  expect(rolled.direction).toEqual(start.direction);
  expect(dot(rolled.up, start.up)).toBeCloseTo(0, 12);
});

test("radial zoom preserves look and roll and enforces altitude limits", () => {
  const start = lookFrame(initial(), 0.2, 0.1);
  const zoomed = zoomFrame(start, 0.5, 1_700_000, 40, 10_000_000);
  expect(magnitude(zoomed.position)).toBeCloseTo(1_850_000, 6);
  expect(zoomed.direction).toEqual(start.direction);
  expect(zoomed.up).toEqual(start.up);
  expect(magnitude(zoomFrame(start, 0, 1_700_000, 40, 10_000_000).position)).toBeCloseTo(1_700_040, 6);
  expect(magnitude(zoomFrame(start, 1e10, 1_700_000, 40, 10_000_000).position)).toBeCloseTo(11_700_000, 6);
});

test("center reset restores center lock without changing camera position, even at a pole", () => {
  const looked = rollFrame(lookFrame(initial(), 1, 0.8), 0.5);
  const reset = centerFrame(looked.position);
  expect(reset.position).toEqual(looked.position);
  expect(dot(reset.position, reset.direction) / magnitude(reset.position)).toBeCloseTo(-1, 12);
  expect(magnitude(reset.up)).toBeCloseTo(1, 12);
});

test("orbit keeps tilt, roll and look direction relative to the local vertical", () => {
  // Looked around and rolled, so the camera no longer faces the center.
  let frame = rollFrame(lookFrame(initial(), 0.7, -0.4), 0.3);
  const radialDot = (f: CameraFrame) => [f.direction, f.up].map(v => dot(v, f.position) / magnitude(f.position));
  const [tilt, roll] = radialDot(frame);
  expect(tilt).toBeGreaterThan(-0.99);                 // really tilted away from straight down
  for (let i = 0; i < 1500; i++) {
    frame = orbitFrame(frame, 0.013, -0.021);
    const [t, r] = radialDot(frame);
    expect(t).toBeCloseTo(tilt, 9);
    expect(r).toBeCloseTo(roll, 9);
    expect(magnitude(frame.position)).toBeCloseTo(2_000_000, 5);
    expect(dot(frame.direction, frame.up)).toBeCloseTo(0, 12);
    expect(magnitude(frame.direction)).toBeCloseTo(1, 12);
  }
});

test("a horizontal view stays horizontal; dragging up moves forward and left moves sideways", () => {
  // Standing on the surface looking north along +y, up is the local vertical.
  const start: CameraFrame = { position: {x: 0, y: 0, z: 2}, direction: {x: 0, y: 1, z: 0}, up: {x: 0, y: 0, z: 1} };
  const forward = orbitFrame(start, 0, -0.1), sideways = orbitFrame(start, -0.1, 0);
  expect(forward.position.y).toBeGreaterThan(0);
  expect(Math.abs(forward.position.x)).toBeLessThan(1e-12);
  expect(sideways.position.x).toBeLessThan(0);
  expect(Math.abs(sideways.position.y)).toBeLessThan(1e-12);
  for (const f of [forward, sideways]) {
    expect(dot(f.direction, f.position)).toBeCloseTo(0, 12);   // still level with the horizon
    expect(dot(f.up, f.position) / magnitude(f.position)).toBeCloseTo(1, 12);
  }
});

test("a camera rolled onto its side still orbits without breaking", () => {
  const start: CameraFrame = { position: {x: 0, y: 0, z: 2}, direction: {x: 0, y: 1, z: 0}, up: {x: 1, y: 0, z: 0} };
  const next = orbitFrame(start, 0.1, 0.1);
  for (const v of [next.position, next.direction, next.up]) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
  expect(magnitude(next.position)).toBeCloseTo(2, 12);
  expect(dot(next.direction, next.up)).toBeCloseTo(0, 12);
});
