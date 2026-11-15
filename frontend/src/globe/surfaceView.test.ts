import { expect, test } from "vitest";
import {
  PITCH_LIMIT, cameraFrame, cross, facing, fromCamera, headingDeg, hopHeight, length, look, normalize, travel, travelSeconds, walk,
  type Surface, type Vec,
} from "./surfaceView";

const R = 1737400;
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const latLon = (lat: number, lon: number): Vec => {
  const a = lat * Math.PI / 180, o = lon * Math.PI / 180;
  return { x: Math.cos(a) * Math.cos(o), y: Math.cos(a) * Math.sin(o), z: Math.sin(a) };
};
const northAt = (up: Vec) => normalize({ x: -up.z * up.x, y: -up.z * up.y, z: 1 - up.z * up.z });
const valid = (s: Surface) => {
  expect(length(s.up)).toBeCloseTo(1, 11); expect(length(s.fwd)).toBeCloseTo(1, 11); expect(dot(s.up, s.fwd)).toBeCloseTo(0, 11);
};

test("standing from a camera: facing where it looks, or screen-up when looking straight down", () => {
  const up = latLon(-85, 30), north = northAt(up), east = cross(north, up);
  const oblique = fromCamera({ x: up.x * 2e6, y: up.y * 2e6, z: up.z * 2e6 },
    normalize({ x: east.x - up.x, y: east.y - up.y, z: east.z - up.z }), up);
  valid(oblique);
  expect(headingDeg(oblique)).toBeCloseTo(90, 9);
  expect(oblique.pitch).toBeCloseTo(-Math.PI / 4, 9);
  const nadir = fromCamera(up, { x: -up.x, y: -up.y, z: -up.z }, north);
  expect(headingDeg(nadir)).toBeCloseTo(0, 9);
  expect(nadir.pitch).toBeCloseTo(-Math.PI / 2, 9);
});

test("the camera frame is orthonormal, at the radius, looking along fwd tilted by pitch", () => {
  const s: Surface = { up: latLon(-89.7, -171.9), fwd: northAt(latLon(-89.7, -171.9)), pitch: 0.3 };
  const f = cameraFrame(s, R + 2);
  expect(length(f.position)).toBeCloseTo(R + 2, 6);
  expect(length(f.direction)).toBeCloseTo(1, 12); expect(length(f.up)).toBeCloseTo(1, 12);
  expect(dot(f.direction, f.up)).toBeCloseTo(0, 12);
  expect(Math.asin(dot(f.direction, s.up))).toBeCloseTo(0.3, 12);
});

test("grab-to-look turns about the vertical and clamps the pitch", () => {
  const up = latLon(-87, 0), s: Surface = { up, fwd: northAt(up), pitch: 0 };
  expect(headingDeg(look(s, Math.PI / 2, 0))).toBeCloseTo(90, 9);        // turn right -> east
  expect(headingDeg(look(s, -Math.PI / 2, 0))).toBeCloseTo(270, 9);
  expect(look(s, 0, 10).pitch).toBeCloseTo(PITCH_LIMIT, 12);
  expect(look(s, 0, -10).pitch).toBeCloseTo(-PITCH_LIMIT, 12);
});

test("walking moves the right distance and direction and keeps facing along the path", () => {
  const up = latLon(-86, 45), s: Surface = { up, fwd: northAt(up), pitch: -0.1 };
  const fwd = walk(s, 1000, 0, R);
  valid(fwd);
  expect(Math.acos(dot(up, fwd.up)) * R).toBeCloseTo(1000, 3);        // to the millimetre
  expect(dot(fwd.up, latLon(-85, 45))).toBeGreaterThan(dot(up, latLon(-85, 45)));       // went north
  expect(headingDeg(fwd)).toBeCloseTo(0, 6);                                              // still facing north
  const strafe = walk(s, 0, 500, R);
  expect(Math.acos(dot(up, strafe.up)) * R).toBeCloseTo(500, 3);
  expect(dot(strafe.fwd, s.fwd)).toBeCloseTo(1, 9);                                       // facing unchanged
  expect(walk(s, 0, 0, R)).toBe(s);
});

test("walking straight across the south pole keeps going straight, without flipping", () => {
  const up = latLon(-89.99, 0);
  // Face toward the pole (south along the 0° meridian).
  let s: Surface = { up, fwd: normalize({ x: -northAt(up).x, y: -northAt(up).y, z: -northAt(up).z }), pitch: 0 };
  const start = s.up;
  for (let i = 0; i < 40; i++) { s = walk(s, 25, 0, R); valid(s); }      // 1 km: well past the pole
  // Total path is a single great circle: 1 km from the start, and still heading away from it.
  expect(Math.acos(dot(start, s.up)) * R).toBeCloseTo(1000, 3);
  const ahead = walk(s, 10, 0, R);
  expect(Math.acos(dot(start, ahead.up))).toBeGreaterThan(Math.acos(dot(start, s.up)));
});

test("click-to-travel follows a great circle and keeps the facing direction", () => {
  const up = latLon(-88, 10), s: Surface = { up, fwd: northAt(up), pitch: 0.2 };
  const target = latLon(-88.1, 12);
  const path = travel(s, target);
  expect(dot(path.at(0).up, s.up)).toBeCloseTo(1, 12);
  const end = path.at(1);
  valid(end);
  expect(dot(end.up, target)).toBeCloseTo(1, 12);
  expect(end.pitch).toBe(0.2);
  // The view keeps pointing the same way in space (at the same distant landmarks). Its compass
  // heading shifts only by meridian convergence: about 2° for 2° of longitude this close to the pole.
  expect(dot(end.fwd, s.fwd)).toBeGreaterThan(Math.cos(2.5 * Math.PI / 180));
  const turn = ((headingDeg(end)! - headingDeg(s)! + 540) % 360) - 180;
  expect(Math.abs(turn)).toBeLessThan(2.5);
  expect(travel(s, up).angle).toBeCloseTo(0, 6);
  expect(travel(s, up).at(0.5)).toBe(s);
});

test("travel timing and hop arc are bounded", () => {
  expect(travelSeconds(0)).toBeCloseTo(0.7); expect(travelSeconds(1e6)).toBe(3.5);
  expect(hopHeight(1000, 0)).toBe(0); expect(hopHeight(1000, 1)).toBe(0);
  expect(hopHeight(1000, 0.5)).toBeCloseTo(120); expect(hopHeight(1e6, 0.5)).toBeCloseTo(400);
});

test("facing an azimuth/elevation matches the compass heading and clamps the pitch", () => {
  const up = latLon(-89.4, 8), s: Surface = { up, fwd: northAt(up), pitch: 0 };
  for (const az of [0, 45, 190, 359]) expect(headingDeg(facing(s, az, 0))).toBeCloseTo(az, 9);
  expect(facing(s, 10, 1.5).pitch).toBeCloseTo(1.5 * Math.PI / 180, 12);
  expect(facing(s, 10, 120).pitch).toBeCloseTo(PITCH_LIMIT, 12);
});
