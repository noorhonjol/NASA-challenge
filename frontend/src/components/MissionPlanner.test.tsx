import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MissionPlanner } from "./MissionPlanner";
import { estimate } from "./missionScores";
import type { LatLon, SearchResult } from "../api/mission";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const regions = {
  title: "NASA Artemis III", accuracy: "Digitized from NASA's map; errors of a few km.", source: {},
  regions: [{ id: "artemis3-haworth", name: "Haworth", program: "Artemis III", center: { lat: -86.8, lon: -22.5 },
    polygon: [[-86.6, -25], [-86.6, -20], [-87, -20], [-87, -25]], size_km: [29.8, 29.3] }],
};
const detail = (power: number, heat: number, comm: number) => ({
  power, heat, comm, site: Math.round((power + heat + comm) / 3), energy_kwh: 400, coverage: 1.2, sunlit_fraction: 0.8, longest_darkness_h: 20,
  fixed_panel_azimuth_deg: null, in_range_fraction: 1, min_temp_K: 120, max_temp_K: 250, earth_visible_fraction: 0.6, longest_blackout_h: 30, slope_ok: true,
});
const spot = (cell: number, lat: number, lon: number, d: ReturnType<typeof detail>) => ({ cell, lat, lon, slope_deg: 4, elevation_m: 1000, ...d });
const cells = [[-86.7, -24], [-86.7, -21], [-86.9, -24], [-86.9, -21]].map(([lat, lon]) => ({ lat, lon, slope_deg: 4, elevation_m: 1000 }));
const cellDetails = [detail(100, 100, 40), detail(60, 100, 90), detail(20, 50, 10), detail(80, 100, 70)];
const makeWindow = (index: number, start: string, end: string, score: number) => ({
  index, start, end, score, parts: { power: 100, heat: 100, comm: 90 },
  base: spot(1, -86.7, -21, cellDetails[1]),
  solar_spots: [spot(0, -86.7, -24, cellDetails[0]), spot(3, -86.9, -21, cellDetails[3]), spot(1, -86.7, -21, cellDetails[1])],
  comm_spots: [spot(1, -86.7, -21, cellDetails[1]), spot(3, -86.9, -21, cellDetails[3]), spot(0, -86.7, -24, cellDetails[0])],
  maps: { site: cellDetails.map(c => c.site), power: cellDetails.map(c => c.power), heat: cellDetails.map(c => c.heat), comm: cellDetails.map(c => c.comm) },
  cells: cellDetails,
});
const needs = { load_w: 1000, panel_area_m2: 10, efficiency: 0.3, tracking: true, battery_hours: 30, min_k: 70, max_k: 380,
  min_visible_fraction: 0.5, max_blackout_hours: 48, max_slope_deg: 15, labels: { power: "Mid power", heat: "Robotic", communication: "Frequent" } };
const regionResult = {
  kind: "polygon", cells, grid: { rows: 2, cols: 2, resolution_m: 3840, cell_rows: [0, 0, 1, 1], cell_cols: [0, 1, 0, 1] },
  timeline: { starts: ["2026-12-01T00:00:00+00:00", "2026-12-02T00:00:00+00:00", "2026-12-20T00:00:00+00:00"],
    score: [96.7, 50, 80], power: [100, 50, 90], heat: [100, 50, 80], comm: [90, 50, 70] },
  windows: [makeWindow(0, "2026-12-01T00:00:00+00:00", "2026-12-15T00:00:00+00:00", 96.7), makeWindow(2, "2026-12-20T00:00:00+00:00", "2027-01-03T00:00:00+00:00", 80)],
  need_kwh: 336, needs, period: { start: "", end: "", mission_days: 14 }, step_hours: 2, window_stride_hours: 24, window_count: 3,
  limitations: ["Screening only."], sources: {},
} as unknown as SearchResult;
const pointResult = { ...regionResult, kind: "point", cells: [cells[1]], grid: null,
  windows: [{ ...regionResult.windows[1], score: 70 }],
  timeline: { ...regionResult.timeline, score: [61, 50, 70], power: [62, 50, 70], heat: [63, 50, 70], comm: [64, 50, 70] } } as unknown as SearchResult;

type Body = Record<string, unknown> & { where: { type: string } };
function stubFetch(result: SearchResult = regionResult, failWith?: string) {
  const posted: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/mission/regions") return { ok: true, json: async () => regions };
    if (url === "/api/mission/search/options") return { ok: false, status: 404, json: async () => ({}) };     // built-in defaults
    if (url === "/api/mission/search" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      if (failWith) return { ok: false, status: 422, json: async () => ({ detail: failWith }) };
      return { ok: true, json: async () => ({ id: `job${posted.length}`, cells: 4 }) };
    }
    const body = posted[Number(url.split("/").pop()?.replace("job", "")) - 1];
    return { ok: true, json: async () => ({ status: "done", progress: 1, cells: 4,
      result: body?.where.type === "point" && result === regionResult ? pointResult : result }) };
  }));
  return posted;
}

function planner(overrides: Partial<Parameters<typeof MissionPlanner>[0]> = {}) {
  const props: Parameters<typeof MissionPlanner>[0] = {
    location: { kind: "location", lat: -86.7, lon: -21, name: "Selected coordinates" },
    sites: [{ id: 4, slug: "pgda-78-site04", name: "Site04 · Shackleton rim", lat_deg: -89.76, lon_deg: -171.87,
      elevation_m: 1800, frame: "MOON_ME", is_fictional: false, notes: null }],
    mission: { start: "2026-12-01T00:00", end: "2027-01-30T00:00" },
    onMissionChange: vi.fn(), drawn: null, onDraw: vi.fn(), onFly: vi.fn(), onOverlay: vi.fn(), onClose: vi.fn(),
    advanced: <p>Advanced tools here</p>, probing: false, onProbe: vi.fn(), probe: null,
    ...overrides,
  };
  const view = render(<MissionPlanner {...props} />);
  return { props, rerender: (next: Partial<typeof props>) => view.rerender(<MissionPlanner {...props} {...next} />) };
}
const find = () => fireEvent.click(screen.getByRole("button", { name: "Find the best windows" }));
const results = () => screen.findByText(/Best 14-day window/, {}, { timeout: 3000 });

test("a site search sends the period, mission length and the three basic criteria, and ranks windows", async () => {
  const posted = stubFetch(pointResult);
  planner();
  find();
  await results();
  expect(posted[0]).toEqual({ where: { type: "point", lat: -86.7, lon: -21 }, start: "2026-12-01T00:00:00Z", end: "2027-01-30T00:00:00Z",
    mission_days: 14, power: { tier: "mid", tracking: true }, heat: { profile: "robotic" }, comm: { frequency: "mid" }, max_slope_deg: 15 });
  const list = screen.getByRole("list", { name: "Best windows" });
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  expect(list).toHaveTextContent("20 Dec 2026 – 3 Jan 2027");
  // Point results: no map, but the numbers behind the scores.
  expect(screen.queryByRole("combobox", { name: "Map on the Moon" })).not.toBeInTheDocument();
  expect(screen.getByText("Energy from panels")).toBeInTheDocument();
  expect(screen.getByText("400 kWh")).toBeInTheDocument();
});

test("basic choices and advanced fields go into the request", async () => {
  const posted = stubFetch(pointResult);
  planner();
  fireEvent.click(screen.getByRole("radio", { name: /High power/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Panels turn to follow the Sun" }));
  fireEvent.click(screen.getByText("Advanced power"));
  fireEvent.change(screen.getByLabelText("Panel efficiency (%)"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Energy needed over the mission (kWh)"), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("radio", { name: "Crewed" }));
  fireEvent.click(screen.getByText("Advanced heat"));
  fireEvent.change(screen.getByLabelText("Highest surface temperature (K)"), { target: { value: "300" } });
  fireEvent.click(screen.getByRole("radio", { name: /Very frequent/ }));
  fireEvent.click(screen.getByText("Advanced communication"));
  fireEvent.change(screen.getByLabelText("Earth in view at least (%)"), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  find();
  await results();
  expect(posted[0]).toMatchObject({ mission_days: 7, max_slope_deg: 15,
    power: { tier: "high", tracking: false, efficiency: 0.25, energy_kwh: 5000 },
    heat: { profile: "crewed", max_k: 300 }, comm: { frequency: "high", min_visible_fraction: 0.8 } });
});

test("a region search draws a smooth score map on the Moon, with base, panel and antenna spots per window", async () => {
  const posted = stubFetch();
  const { props } = planner();
  fireEvent.click(screen.getByRole("radio", { name: /Artemis III region or known site/ }));
  await screen.findByRole("option", { name: /Haworth · 30×29 km/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Region or site" }), { target: { value: "artemis3-haworth" } });
  find();
  await results();
  expect(posted[0].where).toEqual({ type: "polygon", coordinates: regions.regions[0].polygon });
  const overlay = () => vi.mocked(props.onOverlay).mock.lastCall![0];
  expect(overlay().polygon).toEqual(regions.regions[0].polygon);
  expect(overlay().surface).toMatchObject({ cellRows: [0, 0, 1, 1], cellCols: [0, 1, 0, 1], values: cellDetails.map(c => c.site) });
  expect(overlay().spots.map(s => s.label)).toEqual(["Base · 83", "Solar panels · 100", "Antenna · 90"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Map on the Moon" }), { target: { value: "power" } });
  expect(overlay().surface?.values).toEqual([100, 60, 20, 80]);
  // A second window from the ranking.
  fireEvent.click(within(screen.getByRole("list", { name: "Best windows" })).getAllByRole("button")[1]);
  expect(screen.getByText(/does in window #2/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Fly here" })[1]);
  expect(props.onFly).toHaveBeenCalledWith(-86.7, -24, 1000);
  expect(props.onClose).not.toHaveBeenCalled();
});

test("another spot gets an estimate from the samples at once, and an exact result on request", async () => {
  const posted = stubFetch();
  const drawn: LatLon[] = [[-86.6, -25], [-86.6, -20], [-87, -20]];
  const { props, rerender } = planner({ drawn });
  find();
  await results();
  fireEvent.click(screen.getByRole("button", { name: "Pick a spot on the Moon" }));
  expect(props.onProbe).toHaveBeenCalledWith(true);
  rerender({ probing: true, probe: { lat: -86.7, lon: -24, elevation: 900 } });
  const table = await screen.findByRole("table", { name: "Compared spots" });
  expect(within(table).getByText("Spot A")).toBeInTheDocument();
  expect(table).toHaveTextContent("80 est.");                                   // exactly on sample 0: its site score
  fireEvent.click(within(table).getByRole("button", { name: "Compute exactly" }));
  expect(await within(table).findByText(/20 Dec 2026 – 3 Jan 2027 · 70/, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(posted[1].where).toEqual({ type: "point", lat: -86.7, lon: -24 });
  expect(table).toHaveTextContent("61");                                         // its exact score in window #1
});

test("estimates weight the nearest samples by inverse distance", () => {
  const pts = [{ lat: -89, lon: 0 }, { lat: -89, lon: 10 }];
  expect(estimate(pts, [0, 100], -89, 0)).toBe(0);
  expect(estimate(pts, [0, 100], -89, 5)).toBeCloseTo(50, 0);
  expect(estimate(pts, [null, null], -89, 5)).toBeNull();
});

test("a mission longer than the search period, or outside the ephemeris, cannot be searched", () => {
  stubFetch();
  const { rerender } = planner({ mission: { start: "2026-12-01T00:00", end: "2026-12-08T00:00" } });
  expect(screen.getByText("The mission must fit inside the search period.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Find the best windows" })).toBeDisabled();
  rerender({ mission: { start: "2020-01-10T00:00", end: "2020-03-10T00:00" } });
  expect(screen.getByText(/covers 2020–2035/)).toBeInTheDocument();
});

test("shows the backend's error message", async () => {
  stubFetch(regionResult, "The search period can be at most 180 days.");
  planner();
  find();
  expect(await screen.findByRole("alert")).toHaveTextContent("at most 180 days");
});

test("drawing hands off to the globe", () => {
  stubFetch();
  const { props } = planner({ drawn: [[-89, 0], [-89, 20], [-88.8, 20]] });
  expect(screen.getByRole("radio", { name: /Draw a region on the Moon/ })).toBeChecked();
  expect(screen.getByText("3 corners drawn")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Redraw region on the Moon" }));
  expect(props.onDraw).toHaveBeenCalled();
});

test("complicated tools stay in the Detailed analysis tab", () => {
  stubFetch();
  planner();
  expect(screen.queryByText("Advanced tools here")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Detailed analysis" }));
  expect(screen.getByText("Advanced tools here")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Find the best windows" })).not.toBeInTheDocument();
});

test("without a selected site, the planner starts on the known regions", async () => {
  stubFetch();
  planner({ location: null });
  expect(screen.getByRole("radio", { name: /Selected site/ })).toBeDisabled();
  expect(screen.getByRole("radio", { name: /Artemis III region or known site/ })).toBeChecked();
  expect(await screen.findByRole("option", { name: /Haworth · 30×29 km/ })).toBeInTheDocument();
});
