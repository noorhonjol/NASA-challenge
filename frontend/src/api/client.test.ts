import { afterEach, expect, test, vi } from "vitest";
import { fetchSites } from "./client";

afterEach(() => vi.unstubAllGlobals());

test("fetchSites requests /api/sites and returns parsed sites", async () => {
  const payload = [
    { id: 1, slug: "a", name: "A (fictional)", lat_deg: -89.45, lon_deg: 129.2, elevation_m: null, frame: "MOON_ME", is_fictional: true, notes: null },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
  await expect(fetchSites()).resolves.toEqual(payload);
  expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/sites");
});

test("fetchSites throws with the status when the backend fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "database unavailable" }) }));
  await expect(fetchSites()).rejects.toThrow("503");
});
