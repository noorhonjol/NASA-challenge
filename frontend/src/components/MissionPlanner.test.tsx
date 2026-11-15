import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MissionPlanner } from "./MissionPlanner";
import type { LatLon } from "../api/mission";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const regions = {
  title: "NASA Artemis III", accuracy: "Digitized from NASA's map; errors of a few km.", source: {},
  regions: [{ id: "artemis3-haworth", name: "Haworth", program: "Artemis III", center: { lat: -86.8, lon: -22.5 },
    polygon: [[-86.6, -25], [-86.6, -20], [-87, -20], [-87, -25]], size_km: [29.8, 29.3] }],
};
const criteria = [
  { metric: "slope_deg", op: "<=", target: 8, actual: 4.8, pass: true, required: true, weight: 3 },
  { metric: "earth_visible_fraction", op: ">=", target: 0.5, actual: 0.2, pass: false, required: true, weight: 3 },
];
const metrics = {
  slope_deg: { label: "Slope", unit: "°", aspect: "ground" },
  earth_visible_fraction: { label: "Earth visible fraction", unit: "", aspect: "communication" },
};
const cell = (lat: number, lon: number, extra = {}) => ({ lat, lon, illumination_fraction: 0.6, max_darkness_hours: 40,
  solar_energy_kwh_m2: 150, mean_irradiance_wm2: 900, min_temp_K: 70, max_temp_K: 250, mean_temp_K: 160,
  earth_visible_fraction: 0.2, slope_deg: 4.8, elevation_m: 1200, ...extra });
const stat = (v: number) => ({ label: "", unit: "", min: v, mean: v, max: v });
const summary = {
  power: { illumination_fraction: stat(0.6), max_darkness_hours: stat(40), solar_energy_kwh_m2: stat(150) },
  heat: { min_temp_K: stat(70), max_temp_K: stat(250), mean_temp_K: stat(160) },
  communication: { earth_visible_fraction: stat(0.2) }, ground: { slope_deg: stat(4.8), elevation_m: stat(1200) },
};
const point = {
  kind: "point", period: { start: "", end: "", days: 7, power_step_hours: 1, heat_step_minutes: 60 }, preset: "crewed_landing",
  metrics, summary, cells: [cell(-89.45, 129.2, { score: 50, verdict: "FAIL" })], grid: null,
  ranking: [{ lat: -89.45, lon: 129.2, elevation_m: 1200, score: 50, verdict: "FAIL", criteria }], pass_count: 0,
  series: { times: ["2026-12-01T00:00:00Z", "2026-12-08T00:00:00Z"], surface_temp_K: [70, 250], sun_fraction: [0, 1] },
  communication: { summary: { available_fraction: 0.25, longest_blackout_hours: 60, available_windows: 2, unknown_hours: 0 },
    windows: [{ status: "available", start_utc: "2026-12-01T00:00:00Z", end_utc: "2026-12-02T00:00:00Z", duration_hours: 24 }],
    terrain_model: "lola" },
  warnings: ["Example warning."], limitations: ["Screening only."], sources: { power: "Lunar Energy v1" },
};
const region = {
  ...point, kind: "polygon", series: undefined, communication: undefined, pass_count: 1,
  cells: [cell(-86.7, -24, { score: 100, verdict: "PASS", earth_visible_fraction: 0.7 }), cell(-86.9, -21, { score: 50, verdict: "FAIL" })],
  grid: { rows: 1, cols: 2, resolution_m: 3840, cell_rows: [0, 0], cell_cols: [0, 1] },
  ranking: [{ lat: -86.7, lon: -24, elevation_m: 900, score: 100, verdict: "PASS", criteria }],
};

function stubFetch(analysis: object) {
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/mission/regions" ? regions : analysis }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function planner(overrides: Partial<Parameters<typeof MissionPlanner>[0]> = {}) {
  const props = {
    location: { kind: "location" as const, lat: -89.45, lon: 129.2, name: "Selected coordinates" },
    sites: [{ id: 4, slug: "pgda-78-site04", name: "Site04 · Shackleton rim", lat_deg: -89.76, lon_deg: -171.87,
      elevation_m: 1800, frame: "MOON_ME", is_fictional: false, notes: null }],
    mission: { start: "2026-12-01T00:00", end: "2026-12-08T00:00" },
    onMissionChange: vi.fn(), drawn: null as LatLon[] | null, onDraw: vi.fn(), onFly: vi.fn(), onOverlay: vi.fn(), onClose: vi.fn(),
    advanced: <p>Advanced tools here</p>, ...overrides,
  };
  render(<MissionPlanner {...props} />);
  return props;
}

const analyzeBody = (fetch: ReturnType<typeof stubFetch>) =>
  JSON.parse((fetch.mock.calls.find(([url]) => url === "/api/mission/analyze") as unknown as [string, RequestInit])[1].body as string);

test("a site analysis covers power, heat and communication in one request", async () => {
  const fetch = stubFetch(point);
  planner();
  fireEvent.click(screen.getByRole("button", { name: "Analyze site" }));
  expect(await screen.findByText("Power · sunlight")).toBeInTheDocument();
  expect(analyzeBody(fetch)).toEqual({ where: { type: "point", lat: -89.45, lon: 129.2 },
    start: "2026-12-01T00:00:00Z", end: "2026-12-08T00:00:00Z", preset: "crewed_landing" });
  expect(screen.getByText("Heat · surface")).toBeInTheDocument();
  expect(screen.getByText("70 – 250 K")).toBeInTheDocument();
  expect(screen.getByText("25%")).toBeInTheDocument();                 // refined Earth windows
  expect(screen.getByText(/Longest blackout 2.5 days · 2 windows/)).toBeInTheDocument();
  expect(screen.getByText("Does not meet")).toBeInTheDocument();
  expect(screen.getByText(/Earth visible fraction · required/)).toBeInTheDocument();
  expect(screen.getByText("Example warning.")).toBeInTheDocument();
});

test("a known Artemis III region is analyzed as a polygon, mapped, ranked and shown on the globe", async () => {
  const fetch = stubFetch(region);
  const props = planner();
  fireEvent.click(screen.getByRole("radio", { name: /Artemis III region or known site/ }));
  await screen.findByRole("option", { name: /Haworth · 30×29 km/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Region or site" }), { target: { value: "artemis3-haworth" } });
  expect(screen.getByText(/Digitized from NASA's map/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze region" }));
  expect(await screen.findByText("1 of 2 spots meet every required limit.")).toBeInTheDocument();
  expect(analyzeBody(fetch).where).toEqual({ type: "polygon", coordinates: regions.regions[0].polygon });
  expect(screen.getByRole("img", { name: /Mission score map, 2 cells of 3840 m/ })).toBeInTheDocument();
  expect(props.onOverlay).toHaveBeenLastCalledWith({ polygon: regions.regions[0].polygon,
    spots: [{ lat: -86.7, lon: -24, label: "#1 · 100%", pass: true }] });
  fireEvent.click(within(screen.getByRole("list", { name: "Best spots" })).getByRole("button", { name: "Fly here" }));
  expect(props.onFly).toHaveBeenCalledWith(-86.7, -24, 900);
  // The planner stays open beside the globe, and the region's result stays to compare spots.
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByText("1 of 2 spots meet every required limit.")).toBeInTheDocument();
});

test("a known PGDA site is analyzed as a single point", async () => {
  const fetch = stubFetch(point);
  planner();
  fireEvent.click(screen.getByRole("radio", { name: /Artemis III region or known site/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "Region or site" }), { target: { value: "site:4" } });
  fireEvent.click(screen.getByRole("button", { name: "Analyze site" }));
  await screen.findByText("Power · sunlight");
  expect(analyzeBody(fetch).where).toEqual({ type: "point", lat: -89.76, lon: -171.87 });
});

test("drawing hands off to the globe, and a drawn region is sent as a polygon", async () => {
  const drawn: LatLon[] = [[-89, 0], [-89, 20], [-88.8, 20]];
  const fetch = stubFetch(region);
  const props = planner({ drawn });
  expect(screen.getByRole("radio", { name: /Draw a region on the Moon/ })).toBeChecked();
  expect(screen.getByText("3 corners drawn")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Redraw region on the Moon" }));
  expect(props.onDraw).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Analyze region" }));
  await screen.findByText(/spots meet/);
  expect(analyzeBody(fetch).where).toEqual({ type: "polygon", coordinates: drawn });
});

test("dates outside the power model's 2020-2035 range cannot be analyzed", () => {
  stubFetch(point);
  planner({ mission: { start: "2040-01-01T00:00", end: "2040-01-08T00:00" } });
  expect(screen.getByText(/covers 2020–2035/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyze site" })).toBeDisabled();
});

test("complicated tools stay in the Detailed analysis tab", () => {
  stubFetch(point);
  planner();
  expect(screen.queryByText("Advanced tools here")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Detailed analysis" }));
  expect(screen.getByText("Advanced tools here")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Analyze site" })).not.toBeInTheDocument();
});

test("shows the backend's error message", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/mission/regions"
    ? { ok: true, json: async () => regions }
    : { ok: false, status: 422, json: async () => ({ detail: "Area contains no cell centers" }) }));
  planner();
  fireEvent.click(screen.getByRole("button", { name: "Analyze site" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Area contains no cell centers");
});

test("without a selected site, the planner starts on the known regions", async () => {
  stubFetch(region);
  planner({ location: null });
  const selectedSite = screen.getByRole("radio", { name: /Selected site/ });
  expect(selectedSite).toBeDisabled();
  expect(selectedSite).not.toBeChecked();
  expect(screen.getByText(/Pick a site first/)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Artemis III region or known site/ })).toBeChecked();
  expect(await screen.findByRole("option", { name: /Haworth · 30×29 km/ })).toBeInTheDocument();
});
