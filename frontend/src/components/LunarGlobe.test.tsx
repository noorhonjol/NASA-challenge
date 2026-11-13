import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
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

test("says so when WebGL is unavailable instead of mounting a blank canvas", () => {
  render(<LunarGlobe sites={[]} webglSupported={() => false} />);
  expect(screen.getByText(/webgl is not available/i)).toBeInTheDocument();
});
