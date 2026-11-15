import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, test, expect, vi } from "vitest";
import { EnergyPlanner } from "./EnergyPlanner";
const meta = {
  request_id: "test",
  dem_product: "LOLA",
  ephemeris: "DE440",
  computed_in_ms: 12,
  horizon_model: "test horizon",
  limitations: ["sampled terrain"],
};
const mount = () =>
  render(
    <EnergyPlanner
      lat={-89.45}
      lon={-137.3}
      at="2026-12-01T00:00"
      onClose={vi.fn()}
    />,
  );
const run = () =>
  fireEvent.click(screen.getByRole("button", { name: "Run energy analysis" }));
const task = (value: string) =>
  fireEvent.change(screen.getByLabelText("Analysis"), { target: { value } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("point solar analysis needs no equipment and displays terrain and solar data", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        meta,
        location: {
          lat: -89.45,
          lon: -137.3,
          height_m: 2,
          elevation_m: 1900,
          slope_deg: 5,
          aspect_deg: 135,
        },
        sun: { elevation_deg: 2, visible_fraction: 0.5 },
        earth: { elevation_deg: 3, is_visible: true },
        irradiance: {
          toa_w_m2: 1361,
          horizontal_w_m2: 25,
          custom_panel_w_m2: null,
        },
      }),
    });
  vi.stubGlobal("fetch", fetch);
  mount();
  expect(
    screen.queryByLabelText("Operating power (W)"),
  ).not.toBeInTheDocument();
  run();
  expect(
    await screen.findByRole("region", { name: "Energy results" }),
  ).toBeInTheDocument();
  expect(fetch.mock.calls[0][0]).toContain("/v1/solar/point?");
  expect(fetch.mock.calls[0][0]).toContain("height_m=2");
  expect(
    screen.getByRole("heading", { name: "LOLA location" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Lunar latitude (° north)"), {
    target: { value: "-88" },
  });
  expect(
    screen.queryByRole("region", { name: "Energy results" }),
  ).not.toBeInTheDocument();
});

test("mission sizing sends load, panel and storage assumptions to v1", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        meta,
        feasible: true,
        sizing: { min_panel_area_m2: 1 },
        energy: { load_total_wh: 100 },
        solar_conditions: { illumination_pct: 80 },
      }),
    });
  vi.stubGlobal("fetch", fetch);
  mount();
  task("mission");
  run();
  await screen.findByRole("region", { name: "Energy results" });
  expect(fetch.mock.calls[0][0]).toBe("/v1/power/mission");
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload).toMatchObject({
    start: "2026-12-01T00:00:00.000Z",
    duration_hours: 336,
    load: { average_w: 150, survival_w: 40 },
    panel: { mode: "auto", efficiency: 0.3 },
    assumptions: { battery_dod: 0.8, battery_efficiency: 0.95 },
  });
  expect(payload.location).not.toHaveProperty("elevation_m");
});

test("region mode sends circle area and renders metric grid", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        meta,
        grid: { rows: 1, cols: 1, resolution_m: 240, mask: [[true]] },
        metrics: {
          total_energy: {
            unit: "Wh/m2",
            min: 100,
            max: 100,
            mean: 100,
            values: [[100]],
          },
        },
        ranking: {
          by: "total_energy",
          top: [{ row: 0, col: 0, lat: -89, lon: 0, value: 100 }],
        },
      }),
    });
  vi.stubGlobal("fetch", fetch);
  mount();
  task("region");
  fireEvent.change(screen.getByLabelText("Area shape"), {
    target: { value: "circle" },
  });
  run();
  expect(
    await screen.findByRole("img", { name: /heatmap/ }),
  ).toBeInTheDocument();
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload.area.type).toBe("circle");
  expect(payload).not.toHaveProperty("equipment");
});

test("window mode renders no-window state and sends equipment power", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        meta,
        summary: { usable_pct: 0, window_count: 0, total_window_hours: 0 },
        windows: [],
        unsuitable_periods: [],
      }),
    });
  vi.stubGlobal("fetch", fetch);
  mount();
  task("windows");
  run();
  expect(
    await screen.findByText(/No operating windows meet/),
  ).toBeInTheDocument();
  expect(fetch.mock.calls[0][0]).toBe("/v1/power/windows");
  expect(JSON.parse(fetch.mock.calls[0][1].body).equipment.panel.area_m2).toBe(
    1.2,
  );
});

test("v1 structured errors are visible and retryable", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: "DATA_UNAVAILABLE", message: "Install kernels" },
        }),
      }),
  );
  mount();
  run();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "DATA_UNAVAILABLE: Install kernels",
  );
  expect(
    screen.getByRole("button", { name: "Run energy analysis" }),
  ).toBeEnabled();
});

test("cancel aborts outstanding analysis", () => {
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  mount();
  run();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(
    screen.getByRole("button", { name: "Run energy analysis" }),
  ).toBeEnabled();
});

test("typed numbers and dates are checked against their limits before anything is sent", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mount();
  // Text fields, so a browser locale cannot render the digits in another script.
  expect(screen.getByLabelText("Lunar latitude (° north)")).toHaveAttribute("type", "text");
  expect(screen.getByLabelText("Time (UTC)")).toHaveValue("2026-12-01 00:00");
  fireEvent.change(screen.getByLabelText("Lunar latitude (° north)"), { target: { value: "95" } });
  run();
  expect(screen.getByRole("alert")).toHaveTextContent("Lunar latitude (° north): enter a number from -90 up to 90.");
  fireEvent.change(screen.getByLabelText("Lunar latitude (° north)"), { target: { value: "-89.45" } });
  fireEvent.change(screen.getByLabelText("Time (UTC)"), { target: { value: "2040-01-01 00:00" } });
  run();
  expect(screen.getByRole("alert")).toHaveTextContent(/between 2020 and 2035/);
  expect(fetch).not.toHaveBeenCalled();
});
