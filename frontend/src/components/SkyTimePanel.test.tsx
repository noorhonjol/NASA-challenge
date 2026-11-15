import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SkyTimePanel } from "./SkyTimePanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = { headingDeg: 180, pitchDeg: -8, latitude: -89.44, longitude: 8.13, groundM: -427, fovDeg: 60, moving: false, transition: null };
const track = {
  latitude_deg: -89.44, longitude_deg: 8.13, elevation_m: -427, start_utc: "2026-12-01T00:00:00Z", step_minutes: 30, count: 3,
  sun: { azimuth_deg: [100, 99, 98], elevation_deg: [1.4, 1.5, 1.6], distance_km: [1.5e8, 1.5e8, 1.5e8] },
  earth: { azimuth_deg: [348, 348, 348], elevation_deg: [-2, -1.9, -1.8], distance_km: [384000, 384000, 384000] },
  source: "JPL Horizons", source_url: "https://ssd.jpl.nasa.gov/api/horizons.api",
};

test("loads the sky for the standing spot, draws it, and keeps the chosen body centred", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => track });
  vi.stubGlobal("fetch", fetch);
  const onPositions = vi.fn(), onLook = vi.fn();
  render(<SkyTimePanel status={status} onPositions={onPositions} onLook={onLook} onClose={() => {}} />);
  const slider = await screen.findByRole("slider", { name: "Time" });
  const url = new URL(fetch.mock.calls[0][0], "http://x");
  expect(url.pathname).toBe("/api/positions/track");
  expect(url.searchParams.get("lat")).toBe("-89.44");
  expect(url.searchParams.get("elevation_m")).toBe("-427");
  expect(onPositions).toHaveBeenLastCalledWith(expect.objectContaining({ at_utc: "2026-12-01T00:00:00.000Z" }));
  expect(onLook).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Sun" }));
  expect(onLook).toHaveBeenLastCalledWith(100, 1.4);
  fireEvent.change(slider, { target: { value: String(Date.parse("2026-12-01T00:30:00Z")) } });
  expect(onLook).toHaveBeenLastCalledWith(99, 1.5);
  expect(screen.getByText("2026-12-01 00:30 UTC")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Earth" }));
  expect(onLook).toHaveBeenLastCalledWith(348, expect.closeTo(-1.9, 9));
  fireEvent.click(screen.getByRole("button", { name: "Off" }));
  const calls = onLook.mock.calls.length;
  fireEvent.change(slider, { target: { value: String(Date.parse("2026-12-01T01:00:00Z")) } });
  expect(onLook.mock.calls.length).toBe(calls);                       // no longer following
});

test("shows the backend error, and clears the drawn sky when closed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ detail: "JPL Horizons is unavailable." }) }));
  const onPositions = vi.fn();
  const { unmount } = render(<SkyTimePanel status={status} onPositions={onPositions} onLook={() => {}} onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("JPL Horizons is unavailable.");
  unmount();
  expect(onPositions).toHaveBeenLastCalledWith(null);
});
