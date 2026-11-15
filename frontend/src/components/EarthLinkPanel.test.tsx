import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EarthLinkPanel } from "./EarthLinkPanel";
import { stepFor } from "../api/client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const response = {
  location: { latitude_deg: -85, longitude_deg: 0, ground_elevation_m: 1200, altitude_m: 2 },
  period: { start_utc: "2026-12-01T00:00:00Z", end_utc: "2026-12-08T00:00:00Z", step_minutes: 30, samples: 337, duration_hours: 168 },
  terrain_model: { type: "lola", site_resolution_m: 50, max_range_km: 443.7 },
  summary: { available_hours: 84, available_fraction: 0.5, blocked_hours: 72, unknown_hours: 12,
    available_windows: 1, blocked_windows: 2, unknown_windows: 1,
    longest_usable_window_hours: 84, longest_blackout_hours: 60, first_contact_after_hours: 12 },
  windows: [
    { status: "blocked", start_utc: "2026-12-01T00:00:00Z", end_utc: "2026-12-01T12:00:00Z", duration_hours: 12, clipped_start: true, clipped_end: false, min_clearance_deg: -3, max_clearance_deg: -1, causes: ["terrain"] },
    { status: "available", start_utc: "2026-12-01T12:00:00Z", end_utc: "2026-12-05T00:00:00Z", duration_hours: 84, clipped_start: false, clipped_end: false, min_clearance_deg: 0, max_clearance_deg: 4, causes: [] },
    { status: "unknown", start_utc: "2026-12-05T00:00:00Z", end_utc: "2026-12-05T12:00:00Z", duration_hours: 12, clipped_start: false, clipped_end: false, min_clearance_deg: null, max_clearance_deg: null, causes: [] },
    { status: "blocked", start_utc: "2026-12-05T12:00:00Z", end_utc: "2026-12-08T00:00:00Z", duration_hours: 60, clipped_start: false, clipped_end: true, min_clearance_deg: -5, max_clearance_deg: 0, causes: ["lunar_limb"] },
  ],
  warnings: ["Example warning."],
  rf: { assessed: false, note: "Clear line of sight does not guarantee a radio link." },
};

test("requests the chosen period on demand and shows windows, blackout and unknown time", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
  vi.stubGlobal("fetch", fetch);
  render(<EarthLinkPanel lat={-85} lon={0} start="2026-12-01T00:00" end="2026-12-08T00:00" />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check Earth contact" }));
  expect(await screen.findByText("50%")).toBeInTheDocument();
  const url = new URL(fetch.mock.calls[0][0], "http://x");
  expect(url.pathname).toBe("/api/earth-link");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    lat: "-85", lon: "0", step_minutes: "10", start: "2026-12-01T00:00:00Z", end: "2026-12-08T00:00:00Z" });
  expect(screen.getByText("2.5 days")).toBeInTheDocument();                       // longest blackout
  expect(screen.getByText(/First contact after 12.0 h/)).toBeInTheDocument();
  expect(screen.getByText(/12.0 h could not be decided/)).toBeInTheDocument();
  expect(within(screen.getByRole("list")).getByText(/1 Dec, 12:00 – 5 Dec, 00:00/)).toBeInTheDocument();
  expect(screen.getByText("Example warning.")).toBeInTheDocument();
  expect(screen.getByText(/does not guarantee a radio link/)).toBeInTheDocument();
});

test("a whole-period blockage says why, with the range passed in", async () => {
  const blocked = { ...response, summary: { ...response.summary, available_fraction: 0, available_hours: 0, available_windows: 0, first_contact_after_hours: null },
    windows: [{ ...response.windows[3], start_utc: "2026-12-01T00:00:00Z", end_utc: "2026-12-31T00:00:00Z" }] };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => blocked });
  vi.stubGlobal("fetch", fetch);
  render(<EarthLinkPanel lat={-89.9} lon={0} start="2026-12-01T00:00" end="2026-12-31T00:00" />);
  fireEvent.click(screen.getByRole("button", { name: "Check Earth contact" }));
  expect(await screen.findByText(/Blocked: below the Moon's horizon for the whole period/)).toBeInTheDocument();
  expect(screen.getByText("No contact in this period")).toBeInTheDocument();
  const url = new URL(fetch.mock.calls[0][0], "http://x");
  expect(url.searchParams.get("step_minutes")).toBe("30");
  expect(url.searchParams.get("end")).toBe("2026-12-31T00:00:00Z");
});

test("shows the backend's error message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ detail: "JPL Horizons did not respond" }) }));
  render(<EarthLinkPanel lat={-85} lon={0} start="2026-12-01T00:00" end="2026-12-08T00:00" />);
  fireEvent.click(screen.getByRole("button", { name: "Check Earth contact" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("JPL Horizons did not respond");
});

test("an invalid range cannot be sent and an off-the-hour range is passed exactly", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
  vi.stubGlobal("fetch", fetch);
  const { rerender } = render(<EarthLinkPanel lat={-85} lon={0} start="2026-12-01T00:00" end="2026-11-30T00:00" />);
  expect(screen.getByRole("button", { name: "Check Earth contact" })).toBeDisabled();
  rerender(<EarthLinkPanel lat={-85} lon={0} start="2027-03-10T06:30" end="2027-03-12T18:00" />);
  fireEvent.click(screen.getByRole("button", { name: "Check Earth contact" }));
  await screen.findByText("50%");
  const url = new URL(fetch.mock.calls[0][0], "http://x");
  expect(url.searchParams.get("start")).toBe("2027-03-10T06:30:00Z");
  expect(url.searchParams.get("end")).toBe("2027-03-12T18:00:00Z");
  expect(url.searchParams.get("step_minutes")).toBe("10");
});

test("the ephemeris step grows with the range and stays within the backend sample limit", () => {
  const day = 86400000;
  expect(stepFor(day)).toBe(10);
  expect(stepFor(7 * day)).toBe(10);
  expect(stepFor(30 * day)).toBe(30);
  expect(stepFor(366 * day)).toBe(360);
  for (const d of [0.5, 3, 11, 45, 90, 200, 366]) expect(d * 1440 / stepFor(d * day)).toBeLessThanOrEqual(1500);
});
