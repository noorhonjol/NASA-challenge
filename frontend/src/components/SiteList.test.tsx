import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SiteList } from "./SiteList";

const basin = { id: 3, slug: "basin", name: "Basin (fictional)", lat_deg: -88.5, lon_deg: -87.1, elevation_m: null, frame: "MOON_ME", is_fictional: true, notes: null };

test("renders site name, frame, and an em dash for null elevation", () => {
  render(<SiteList sites={[basin]} />);
  expect(screen.getByText("Basin (fictional)")).toBeInTheDocument();
  expect(screen.getByText("MOON_ME")).toBeInTheDocument();
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("renders an empty message when there are no sites", () => {
  render(<SiteList sites={[]} />);
  expect(screen.getByText(/no sites/i)).toBeInTheDocument();
});
