import { expect, test } from "vitest";
import { scoreRgb, surfaceMesh } from "./scoreSurface";

test("the colour scale runs from dark purple (0) to yellow (100) and clamps", () => {
  expect(scoreRgb(0)).toEqual([68, 1, 84]);
  expect(scoreRgb(100)).toEqual([253, 231, 37]);
  expect(scoreRgb(150)).toEqual(scoreRgb(100));
});

test("a square of four samples becomes a fine mesh with smoothly interpolated scores", () => {
  const input = { cells: [[-89, 0], [-89, 1], [-89.01, 0], [-89.01, 1]] as [number, number][],
    cellRows: [0, 0, 1, 1], cellCols: [0, 1, 0, 1], values: [0, 100, 0, 100] };
  const mesh = surfaceMesh(input, 1e-6);                      // spacing forces the maximum subdivision
  const n = 24;
  expect(mesh.lat).toHaveLength((n + 1) ** 2);
  expect(mesh.indices).toHaveLength(n * n * 6);
  // Scores grow from left to right; the middle column is halfway.
  expect(mesh.score[0]).toBe(0);
  expect(mesh.score[n]).toBe(100);
  expect(mesh.score[n / 2]).toBeCloseTo(50, 6);
  // Corners land on the samples.
  expect(mesh.lat[0]).toBeCloseTo(-89, 9);
  expect(mesh.lon[n]).toBeCloseTo(1, 9);
});

test("edge cells with three neighbours make a triangle; a missing value leaves its area uncoloured", () => {
  const input = { cells: [[-89, 0], [-89, 1], [-89.01, 0]] as [number, number][],
    cellRows: [0, 0, 1], cellCols: [0, 1, 0], values: [50, null, 50] };
  const mesh = surfaceMesh(input, 1);                         // no subdivision
  expect(mesh.indices).toEqual([0, 1, 2]);
  expect(mesh.score).toEqual([50, null, 50]);
  expect(surfaceMesh({ ...input, cells: input.cells.slice(0, 2), cellRows: [0, 0], cellCols: [0, 1], values: [1, 2] }, 1).indices).toEqual([]);
});
