import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SunPanel } from "./SunPanel";
import { distanceKm, nearbyGrid } from "../nearby";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const criteria = [
  { metric: "slope_deg", op: "<=", target: 8, actual: 4.8, pass: true, required: true, weight: 3 },
  { metric: "earth_visible_fraction", op: ">=", target: 0.5, actual: 0.42, pass: false, required: true, weight: 3 },
];
const region = {
  meta: { step_min: 10, n_points: 1, n_times: 3, terrain_model: { type: "lola", site_resolution_m: [50] } },
  times: ["2026-12-01T00:00:00Z", "2026-12-04T12:00:00Z", "2026-12-08T00:00:00Z"],
  region_timeseries: {
    sun_fraction: { mean: [0, 0.5, 1], min: [0, 0.5, 1], max: [0, 0.5, 1] },
    irradiance_wm2: { mean: [0, 1, 2], min: [0, 1, 2], max: [0, 1, 2] },
    surface_temp_K: { mean: [60, 150, 250], min: [60, 150, 250], max: [60, 150, 250] },
  },
  cell_stats: { illumination_fraction: [0.495], max_darkness_hours: [60], min_temp_K: [60.4], max_temp_K: [250.2],
    mean_temp_K: [150], energy_tracking_kwh_m2: [120.25], energy_flat_kwh_m2: [3.5], slope_deg: [4.76], elevation_m: [1234] },
  judge: { criteria: [], summary: { n_cells: 1, n_pass: 0, best_score: 50 },
    ranking: [{ lat: -88.85, lon: 90, elevation_m: 1234, score: 50, verdict: "FAIL", criteria }] },
  warnings: ["Example warning."],
};
const judged = { summary: { n_cells: 49, n_pass: 3, best_score: 100 },
  ranking: [{ lat: -88.8, lon: 91, elevation_m: 900, score: 100, verdict: "PASS", criteria }] };
const panel = (onPick = () => {}) =>
  <SunPanel lat={-88.85} lon={90} start="2026-12-01T00:00" end="2026-12-08T00:00" onPick={onPick} />;

test("checks the site against the mission type in one request and shows the verdict", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => region });
  vi.stubGlobal("fetch", fetch);
  render(panel());
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check sunlight & temperature" }));
  expect(await screen.findByText("50%")).toBeInTheDocument();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("/api/sun/region");
  expect(JSON.parse(init.body)).toEqual({ points: [[-88.85, 90]], start: "2026-12-01T00:00:00Z", stop: "2026-12-08T00:00:00Z",
    step_min: 10, thermal_model: true, grid_series: false, preset: "crewed_landing" });
  expect(screen.getByText("60–250 K", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("120.3 kWh/m²")).toBeInTheDocument();
  expect(screen.getByText("Does not meet")).toBeInTheDocument();
  expect(screen.getByText(/Earth visible fraction · required/)).toBeInTheDocument();
  expect(screen.getByText("Example warning.")).toBeInTheDocument();
});

test("without a mission type no preset is sent and nearby search is hidden", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...region, judge: undefined }) });
  vi.stubGlobal("fetch", fetch);
  render(panel());
  fireEvent.change(screen.getByRole("combobox", { name: "Mission type" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Check sunlight & temperature" }));
  await screen.findByText("50%");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("preset");
  expect(screen.queryByRole("button", { name: /Find better spots/ })).not.toBeInTheDocument();
});

test("nearby search scores a grid around the site and flies to a pick", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => region })
    .mockResolvedValueOnce({ ok: true, json: async () => judged });
  vi.stubGlobal("fetch", fetch);
  const onPick = vi.fn();
  render(panel(onPick));
  fireEvent.click(screen.getByRole("button", { name: "Check sunlight & temperature" }));
  fireEvent.click(await screen.findByRole("button", { name: "Find better spots within 10 km" }));
  expect(await screen.findByText(/3 of 49 nearby points/)).toBeInTheDocument();
  const [url, init] = fetch.mock.calls[1];
  const body = JSON.parse(init.body);
  expect(url).toBe("/api/sun/judge");
  expect(body.points).toHaveLength(49);
  expect(body.preset).toBe("crewed_landing");
  expect(body.top_n).toBe(5);
  const lists = screen.getAllByRole("list");
  fireEvent.click(within(lists[lists.length - 1]).getByRole("button", { name: "Fly here" }));
  expect(onPick).toHaveBeenCalledWith(-88.8, 91, 900);
});

test("shows the backend's error message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: "Too many points" }) }));
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Check sunlight & temperature" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Too many points");
});

test("the nearby grid is centered on the site and spans the requested distance", () => {
  const grid = nearbyGrid(-89.5, 30, 10, 7);
  expect(grid).toHaveLength(49);
  expect(grid[24][0]).toBeCloseTo(-89.5, 5);
  expect(grid[24][1]).toBeCloseTo(30, 5);
  expect(distanceKm(-89.5, 30, grid[0][0], grid[0][1])).toBeCloseTo(Math.SQRT2 * 10, 1);
  expect(distanceKm(-89.5, 30, grid[3][0], grid[3][1])).toBeCloseTo(10, 1);
});
