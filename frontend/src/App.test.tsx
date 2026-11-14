import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import type { ReactNode } from "react";

vi.mock("./components/LunarGlobe", () => ({ LunarGlobe: ({options, children}: {children: ReactNode; options: {body: string; target?: {latitude: number; longitude: number} | null}}) =>
  <>{children}<div data-testid="globe">{options.body}:{options.target?.latitude},{options.target?.longitude}</div></> }));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable: true, value: function (this: HTMLDialogElement) {this.setAttribute("open", "");}});
  Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable: true, value: function (this: HTMLDialogElement) {this.removeAttribute("open");}});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("shows an error state when the backend is unreachable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  render(<App />);
  expect(await screen.findByText(/could not load sites/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});

test("coordinate flights work without querying Horizons and Earth uses its own globe", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => []});
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  fireEvent.change(screen.getByRole("combobox", {name: /^Explore/}), {target: {value: "earth"}});
  fireEvent.change(screen.getByLabelText(/^Latitude/), {target: {value: "40.7"}});
  fireEvent.change(screen.getByLabelText(/^Longitude/), {target: {value: "-74"}});
  fireEvent.click(screen.getByRole("button", {name: "Fly to coordinates"}));
  expect(screen.getByTestId("globe")).toHaveTextContent("earth:40.7,-74");
  expect(screen.queryByRole("button", {name: "Show Sun & Earth"})).not.toBeInTheDocument();
  expect(fetch.mock.calls.every(([url]) => url === "/api/sites" || url === "/api/terrain/browser-manifest")).toBe(true);
});

test("one named location selector flies to PGDA 78 pins over the mosaic", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ok: true, json: async () => url === "/api/sites" ? [
    {id:4,slug:"pgda-78-site04",name:"Site04 · Shackleton rim",lat_deg:-89.76,lon_deg:-171.87,elevation_m:1800,frame:"MOON_ME",is_fictional:false,notes:"Region center"},
    {id:1,slug:"fictional-site",name:"Old fictional point",lat_deg:-88,lon_deg:0},
  ] : {
    version: "fixture", reference_radius_m: 1737400, tile_size: 65,
    regions: [{id: 4, region_id: "Site04", name: "Shackleton rim", center: {latitude: -89.76, longitude: -171.87, elevation: 1800}}],
  }})));
  render(<App />);
  await screen.findByRole("option", {name: /Site04/});
  const select = screen.getByRole("combobox", {name: /Named LOLA location/});
  expect(screen.queryByRole("combobox",{name:/LOLA terrain dataset|Observation site/})).not.toBeInTheDocument();
  expect(screen.queryByRole("option",{name:"Old fictional point"})).not.toBeInTheDocument();
  fireEvent.change(select, {target: {value: "4"}});
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:-89.76,-171.87");
  expect(screen.getByLabelText(/^Latitude/)).toHaveValue(-89.76);
  expect(screen.getByLabelText(/^Altitude/)).toHaveValue(1800);
});

test("product 81 becomes the active dataset without requesting a camera flight",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:true,json:async()=>url==="/api/sites"?[]:{
    version:"mosaic-fixture",reference_radius_m:1737400,tile_size:65,
    regions:[{id:81,region_id:"Mosaic81",product_id:81,name:"South Pole mosaic",resolution_m:50,native_resolution_m:5,
      center:{latitude:-89.5,longitude:0,elevation:1000}}],
  }})));
  render(<App/>);
  expect(await screen.findByText(/Product 81 · Continuous coverage/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox",{name:/LOLA terrain dataset/})).not.toBeInTheDocument();
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:-89.5,0");
});

test("opens a modal from navigation and preserves inputs after closing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => []}));
  render(<App />);
  fireEvent.click(screen.getByRole("button", {name: "Mission planner"}));
  expect(screen.getByRole("region", {name: "Mission power planner"})).toBeInTheDocument();
  expect(screen.getByRole("dialog", {name: "Mission planner"})).toHaveAttribute("open");
  fireEvent.change(screen.getByLabelText("Planning task"), {target: {value: "power"}});
  fireEvent.change(screen.getByLabelText("Continuous load (W)"), {target: {value: "250"}});
  fireEvent.click(screen.getByRole("button", {name: "Close planner"}));
  expect(screen.queryByRole("region", {name: "Mission power planner"})).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Globe explorer"})).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", {name: "Mission planner"}));
  expect(screen.getByLabelText("Continuous load (W)")).toHaveValue(250);
  fireEvent(screen.getByRole("dialog", {name: "Mission planner"}), new Event("cancel", {bubbles: true, cancelable: true}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Mission planner"})).toHaveFocus();
  await screen.findByText(/3D terrain unavailable/);
});
