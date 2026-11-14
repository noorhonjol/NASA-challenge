import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { HorizonView } from "./HorizonView";

test("shows returned negative elevations below the horizon without inventing visibility", () => {
  render(<HorizonView data={{ at_utc: "2026-11-14T12:00:00Z", latitude_deg: -89, longitude_deg: 0, elevation_m: 0,
    source: "JPL Horizons", source_url: "https://ssd.jpl.nasa.gov/api/horizons.api", horizon_model: "No terrain obstruction.",
    sun: { azimuth_deg: 120, elevation_deg: 2.1, above_horizon: true },
    earth: { azimuth_deg: 230, elevation_deg: -4.48, above_horizon: false } }} />);
  expect(screen.getByRole("img")).toHaveAccessibleName(/Earth elevation -4.48/);
  expect(screen.getByText(/230.00° azimuth · At or below horizon/)).toBeInTheDocument();
  expect(screen.getByText(/120.00° azimuth · Above horizon/)).toBeInTheDocument();
});
