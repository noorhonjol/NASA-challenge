import { render, screen, waitFor } from "@testing-library/react";
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
