import { expect, test } from "vitest";
import { localDirection } from "./localDirection";

test("maps Horizons azimuth to north and east, and preserves below-horizon directions", () => {
  expect(localDirection(0, 0, 100)).toEqual({ east: 0, north: 100, up: 0 });
  expect(localDirection(90, 0, 100).east).toBeCloseTo(100);
  expect(localDirection(90, 0, 100).north).toBeCloseTo(0);
  expect(localDirection(180, -30, 100).up).toBeCloseTo(-50);
  expect(localDirection(0, 90, 100).up).toBeCloseTo(100);
});
