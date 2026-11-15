import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Site } from "../api/client";
import { LunarGlobe } from "./LunarGlobe";

const site: Site = {
  id: 3,
  slug: "de-gerlache-basin-fictional",
  name: "de Gerlache Basin Floor (fictional)",
  lat_deg: -88.5,
  lon_deg: -87.1,
  elevation_m: null,
  frame: "MOON_ME",
  is_fictional: true,
  notes: null,
};

const webgl = () => true;

test("shows a message when the globe fails to start", async () => {
  render(
    <LunarGlobe
      sites={[]}
      webglSupported={webgl}
      createGlobe={async () => {
        throw new Error("no webgl context");
      }}
    />,
  );
  expect(await screen.findByText(/could not start the lunar globe/i)).toBeInTheDocument();
  expect(screen.getByText(/no webgl context/i)).toBeInTheDocument();
});

test("passes the mapped markers to the globe factory", async () => {
  const seen: string[][] = [];
  render(
    <LunarGlobe
      sites={[site]}
      webglSupported={webgl}
      createGlobe={async (_element, markers) => {
        seen.push(markers.map((m) => m.name));
        return { destroy() {} };
      }}
    />,
  );
  await waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toEqual(["de Gerlache Basin Floor (fictional)"]);
});

test("a map pin selection is forwarded to the location selector", async () => {
  const onSiteSelect = vi.fn();
  const {container} = render(<LunarGlobe sites={[site]} webglSupported={webgl} onSiteSelect={onSiteSelect}
    createGlobe={async () => ({destroy() {}})} />);
  const globe = container.querySelector('[aria-label="Interactive Moon globe"]')!;
  globe.dispatchEvent(new CustomEvent("site-selected", {detail: 3}));
  expect(onSiteSelect).toHaveBeenCalledWith("3");
});

test("says so when WebGL is unavailable instead of mounting a blank canvas", () => {
  render(<LunarGlobe sites={[]} webglSupported={() => false} />);
  expect(screen.getByText(/webgl is not available/i)).toBeInTheDocument();
});

test("updates scene objects without rebuilding the viewer or triggering a camera view", async () => {
  const update = vi.fn().mockResolvedValue(undefined);
  const view = vi.fn();
  const destroy = vi.fn();
  const factory = vi.fn(async () => ({ update, view, destroy }));
  const { rerender, unmount } = render(<LunarGlobe sites={[site]} webglSupported={webgl} createGlobe={factory} />);
  await waitFor(() => expect(update).toHaveBeenCalled());
  const changed = { ...site, lat_deg: -86, lon_deg: 2.7 };
  rerender(<LunarGlobe sites={[changed]} options={{body: "moon", target: {latitude: -86, longitude: 2.7, elevation: 5000}}} webglSupported={webgl} createGlobe={factory} />);
  await waitFor(() => expect(update.mock.calls.at(-1)?.[0][0].latitudeDeg).toBe(-86));
  expect(factory).toHaveBeenCalledTimes(1);
  expect(view).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  unmount();
  expect(destroy).toHaveBeenCalledTimes(1);
});

test("forwards a newly placed surface pin to the pin page", async () => {
  const onPinPlace=vi.fn();
  const {container}=render(<LunarGlobe sites={[]} webglSupported={webgl} onPinPlace={onPinPlace} createGlobe={async()=>({destroy(){}})}/>);
  const canvas=container.querySelector('[aria-label="Interactive Moon globe"]')!;
  const point={latitude:-89.5,longitude:22,elevation:1200};
  canvas.dispatchEvent(new CustomEvent('pin-placed',{detail:point}));
  expect(onPinPlace).toHaveBeenCalledWith(point);
});

test("surface view shows a compass overlay with an exit, and the toolbar enters it", async () => {
  const surface = vi.fn();
  const { container } = render(<LunarGlobe sites={[]} webglSupported={webgl} createGlobe={async () => ({ destroy() {}, surface })} />);
  const view = within(container as HTMLElement);
  const enter = await view.findByRole("button", { name: "Stand on surface" });
  await waitFor(() => expect(enter).toBeEnabled());
  enter.click();
  expect(surface).toHaveBeenCalledWith("enter");
  const canvas = container.querySelector('[aria-label="Interactive Moon globe"]')!;
  const status = { headingDeg: 92, pitchDeg: -8, latitude: -89.4403, longitude: 8.1301, fovDeg: 60, moving: false, transition: null };
  canvas.dispatchEvent(new CustomEvent("surface-view", { detail: status }));
  const hud = await view.findByRole("region", { name: "Surface view" });
  expect(hud).toHaveTextContent("E 92°");
  expect(hud).toHaveTextContent("-89.4403°, 8.1301°");
  expect(hud).toHaveTextContent(/W A S D/);
  view.getAllByRole("button", { name: "Leave surface view" })[0].click();
  expect(surface).toHaveBeenLastCalledWith("exit");
  canvas.dispatchEvent(new CustomEvent("surface-view", { detail: null }));
  await waitFor(() => expect(view.queryByRole("region", { name: "Surface view" })).not.toBeInTheDocument());
});

test("a long scroll out is needed to leave: the overlay shows how far it has got", async () => {
  const { container } = render(<LunarGlobe sites={[]} webglSupported={webgl} createGlobe={async () => ({ destroy() {} })} />);
  const view = within(container as HTMLElement);
  await view.findByRole("button", { name: "Stand on surface" });
  const canvas = container.querySelector('[aria-label="Interactive Moon globe"]')!;
  const status = { headingDeg: 0, pitchDeg: 0, latitude: -89, longitude: 0, groundM: 0, fovDeg: 60, moving: false, transition: null, exitProgress: 0.5 };
  canvas.dispatchEvent(new CustomEvent("surface-view", { detail: status }));
  expect(await view.findByRole("region", { name: "Surface view" })).toHaveTextContent("Keep scrolling out to leave… 50%");
});

test("Sky & time also works from orbit views, for the selected site, and stays open across views", async () => {
  const track = { latitude_deg: -88.5, longitude_deg: -87.1, elevation_m: 900, start_utc: "2026-12-01T00:00:00Z", step_minutes: 30, count: 2,
    sun: { azimuth_deg: [100, 99], elevation_deg: [1.4, 1.5], distance_km: [1.5e8, 1.5e8] },
    earth: { azimuth_deg: [348, 348], elevation_deg: [-2, -1.9], distance_km: [384000, 384000] }, source: "JPL Horizons", source_url: "" };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => track });
  vi.stubGlobal("fetch", fetch);
  const surfaceLook = vi.fn();
  const createGlobe = async () => ({ destroy() {}, surfaceLook });
  const { container, rerender } = render(<LunarGlobe sites={[]} webglSupported={webgl} createGlobe={createGlobe} options={{ body: "moon", target: null }} />);
  const view = within(container as HTMLElement);
  await waitFor(() => expect(view.getByRole("button", { name: "Sky & time" })).toBeDisabled());   // no site yet
  rerender(<LunarGlobe sites={[]} webglSupported={webgl} createGlobe={createGlobe} options={{ body: "moon", target: { latitude: -88.5, longitude: -87.1, elevation: 900 } }} />);
  view.getByRole("button", { name: "Sky & time" }).click();
  await view.findByRole("slider", { name: "Time" });
  const url = new URL(fetch.mock.calls[0][0], "http://x");
  expect(url.searchParams.get("lat")).toBe("-88.5");
  view.getByRole("button", { name: "Sun" }).click();
  expect(surfaceLook).toHaveBeenLastCalledWith(100, 1.4);
  // Standing on the surface and leaving again keeps the panel.
  const canvas = container.querySelector('[aria-label="Interactive Moon globe"]')!;
  canvas.dispatchEvent(new CustomEvent("surface-view", { detail: { headingDeg: 0, pitchDeg: 0, latitude: -88.5, longitude: -87.1, groundM: 900, fovDeg: 60, moving: false, transition: null } }));
  await view.findByRole("region", { name: "Surface view" });
  canvas.dispatchEvent(new CustomEvent("surface-view", { detail: null }));
  await waitFor(() => expect(view.queryByRole("region", { name: "Surface view" })).not.toBeInTheDocument());
  expect(view.getByRole("slider", { name: "Time" })).toBeInTheDocument();
  vi.unstubAllGlobals();
});
