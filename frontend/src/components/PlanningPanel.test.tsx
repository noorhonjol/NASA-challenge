import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlanningPanel } from "./PlanningPanel";

const point = {lat: -89, lon: 0};
const sample = {at_utc: "2026-11-14T00:00:00Z", sun: {elevation_deg: 5}, earth: {elevation_deg: -2}, generated_power_w: 80,
  net_power_w: -20, load_w: 100, panel_irradiance_w_m2: 120, required_panel_area_m2: 5, meets_operating_constraints: false};
const response = {point: {...point, elevation_m: 100}, elevation: {dataset: "LOLA fixture", resolution_m: 5, frame: "MOON_ME"}, source: "JPL Horizons", solar_reference_url: "https://example.com", assumptions: ["No terrain shadows"],
  samples: [sample, {...sample, at_utc: "2026-11-15T00:00:00Z", required_panel_area_m2: null}], operating_windows: [],
  summary: {generated_energy_wh: 1920, load_energy_wh: 2400, net_energy_wh: -480, minimum_initial_usable_energy_wh: 480,
    minimum_nameplate_battery_wh: 600, battery_sufficient_if_initially_full: true}};
const mount = () => render(<PlanningPanel point={point} at="2026-11-14T00:00" sites={[]} onClose={vi.fn()}/>);
const run = () => fireEvent.click(screen.getByRole("button", {name: "Run planning analysis"}));
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

test("submits UTC equipment inputs and renders power, battery and samples", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => response}); vi.stubGlobal("fetch", fetch);
  mount();
  expect(screen.queryByLabelText("Planner elevation (m)")).not.toBeInTheDocument();
  run();
  expect(await screen.findByRole("region", {name: "Planning results"})).toBeInTheDocument();
  expect(fetch.mock.calls[0][0]).toBe("/api/planning/power");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({point, at: "2026-11-14T00:00:00Z", duration_hours: 24, equipment: {panel_efficiency: 0.3, system_efficiency: 0.85}});
  expect(JSON.parse(fetch.mock.calls[0][1].body).point).not.toHaveProperty("elevation_m");
  expect(screen.getByText(/Surface elevation: 100 m · LOLA fixture/)).toBeInTheDocument();
  expect(screen.getByText("Sufficient if full")).toBeInTheDocument();
  expect(screen.getByText(/No operating windows meet/)).toBeInTheDocument();
  expect(screen.getByText("No sunlight")).toBeInTheDocument();
  expect(screen.getByRole("img", {name: /Power over time/})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Continuous load (W)"), {target: {value: "150"}});
  expect(screen.queryByRole("region", {name: "Planning results"})).not.toBeInTheDocument();
});

test("grid mode sends bounds and displays selectable comparisons", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({...response, results: [response, {...response, point: {...point, lat: -88, elevation_m: 150}}]})});
  vi.stubGlobal("fetch", fetch); mount();
  fireEvent.change(screen.getByLabelText("Planning task"), {target: {value: "analysis"}});
  fireEvent.change(screen.getByLabelText("Compare using"), {target: {value: "grid"}}); run();
  await screen.findByRole("region", {name: "Planning results"});
  expect(fetch.mock.calls[0][0]).toBe("/api/planning/analysis");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({grid: {south: -89.5, north: -89, rows: 2, columns: 2}, end: "2026-11-15T00:00:00Z"});
  const second = screen.getByRole("button", {name: "-88°, 0°"}); fireEvent.click(second);
  expect(second).toHaveAttribute("aria-pressed", "true");
});

test("window search sends minimum duration and displays UTC windows", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({...response, operating_windows: [{start: sample.at_utc, end: "2026-11-14T12:00:00Z", duration_hours: 12}]})});
  vi.stubGlobal("fetch", fetch); mount();
  fireEvent.change(screen.getByLabelText("Planning task"), {target: {value: "windows"}});
  fireEvent.change(screen.getByLabelText("Minimum window (hours)"), {target: {value: "8"}}); run();
  expect(await screen.findByText("12 hours")).toBeInTheDocument();
  expect(fetch.mock.calls[0][0]).toBe("/api/planning/windows");
  expect(JSON.parse(fetch.mock.calls[0][1].body).minimum_duration_hours).toBe(8);
});

test("blocks excessive work before calling the API", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); mount();
  fireEvent.change(screen.getByLabelText("Mission duration (hours)"), {target: {value: "1000"}}); run();
  expect(await screen.findByRole("alert")).toHaveTextContent("Maximum 128"); expect(fetch).not.toHaveBeenCalled();
});

test("renders server validation errors and permits retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: false, status: 422, json: async () => ({detail: [{loc: ["body", "start"], msg: "Unsupported date"}]})}));
  mount(); run();
  expect(await screen.findByRole("alert")).toHaveTextContent("start: Unsupported date");
  expect(screen.getByRole("button", {name: "Run planning analysis"})).toBeEnabled();
});

test("cancelling aborts the request and restores submission", () => {
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch); mount(); run();
  fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.getByRole("button", {name: "Run planning analysis"})).toBeEnabled();
});
