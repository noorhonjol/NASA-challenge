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
