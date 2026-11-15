import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import type { ReactNode } from "react";

type MockProps = { children: ReactNode; dataDetails?: ReactNode; onPinPlace?: (point: {latitude:number;longitude:number;elevation:number}) => void;
  onSurfaceChange?: (active: boolean) => void;
  options: { body: string; pinPlacement?: boolean; target?: {latitude: number; longitude: number} | null } };
vi.mock("./components/LunarGlobe", () => ({ LunarGlobe: ({options, children, dataDetails, onPinPlace, onSurfaceChange}: MockProps) =>
  <>{children}{dataDetails}{options.pinPlacement && <button onClick={()=>onPinPlace?.({latitude:-88.123,longitude:42.456,elevation:900})}>Place test pin</button>}
    <button onClick={() => onSurfaceChange?.(true)}>Test enter surface</button>
    <div data-testid="globe">{options.body}:{options.target?.latitude},{options.target?.longitude}</div></> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const site04 = {id:4,slug:"pgda-78-site04",name:"Site04 · Shackleton rim",lat_deg:-89.76,lon_deg:-171.87,elevation_m:1800,frame:"MOON_ME",is_fictional:false,notes:"Region center"};

test("shows an error state when the backend is unreachable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  render(<App />);
  expect(await screen.findByText(/could not load sites/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});

test("typed coordinates fly to the spot without querying Horizons, and bad input is explained", async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => []});
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", {name: /^Explore/})).not.toBeInTheDocument();     // the Moon only
  fireEvent.click(screen.getByText("Enter coordinates…"));
  fireEvent.change(screen.getByLabelText(/^Latitude/), {target: {value: "-88.5"}});
  fireEvent.change(screen.getByLabelText(/^Longitude/), {target: {value: "-74"}});
  fireEvent.click(screen.getByRole("button", {name: "Fly to coordinates"}));
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:-88.5,-74");
  expect(screen.getByRole("article", {name: "Selected site"})).toHaveTextContent("Entered coordinates");
  expect(fetch.mock.calls.every(([url]) => ["/api/sites", "/api/terrain/browser-manifest", "/api/mission/regions", "/api/mission/search/options"].includes(url))).toBe(true);
  fireEvent.change(screen.getByLabelText(/^Latitude/), {target: {value: "95"}});
  fireEvent.click(screen.getByRole("button", {name: "Fly to coordinates"}));
  expect(screen.getByRole("alert")).toHaveTextContent(/latitude between −90 and 90/);
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:-88.5,-74");
});

test("the site selector flies to PGDA 78 pins and shows the site card", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ok: true, json: async () => url === "/api/sites" ? [
    site04, {id:1,slug:"fictional-site",name:"Old fictional point",lat_deg:-88,lon_deg:0},
  ] : {
    version: "fixture", reference_radius_m: 1737400, tile_size: 65,
    regions: [{id: 4, region_id: "Site04", name: "Shackleton rim", center: {latitude: -89.76, longitude: -171.87, elevation: 1800}}],
  }})));
  render(<App />);
  await screen.findByRole("option", {name: /Site04/});
  expect(screen.queryByRole("article", {name: "Selected site"})).not.toBeInTheDocument();
  const select = screen.getByRole("combobox", {name: "Site"});
  expect(screen.queryByRole("option",{name:"Old fictional point"})).not.toBeInTheDocument();
  fireEvent.change(select, {target: {value: "4"}});
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:-89.76,-171.87");
  const card = screen.getByRole("article", {name: "Selected site"});
  expect(card).toHaveTextContent("Site04 · Shackleton rim");
  expect(card).toHaveTextContent("1800 m");
  expect(card).toHaveTextContent("Region center");
  expect(screen.getByLabelText(/^Latitude/)).toHaveValue("-89.76");
  expect(screen.getByLabelText(/^Elevation/)).toHaveValue("1800");
});

test("product 81 becomes the active dataset without dropping a pin or flying the camera",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:true,json:async()=>url==="/api/sites"?[]:{
    version:"mosaic-fixture",reference_radius_m:1737400,tile_size:65,
    regions:[{id:81,region_id:"Mosaic81",product_id:81,name:"South Pole mosaic",resolution_m:50,native_resolution_m:5,
      center:{latitude:-89.5,longitude:0,elevation:1000}}],
  }})));
  render(<App/>);
  expect(await screen.findByText(/Product 81 · Continuous coverage/)).toBeInTheDocument();
  expect(screen.getByTestId("globe")).toHaveTextContent("moon:,");
});

test("the mission planner opens beside the globe and closes again", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true,json:async()=>[]}));
  render(<App/>);
  expect(screen.queryByRole("complementary",{name:"Mission planner"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Open mission planner"}));
  const drawer = screen.getByRole("complementary",{name:"Mission planner"});
  expect(within(drawer).getByRole("button",{name:"Find the best windows"})).toBeInTheDocument();
  // Nothing picked yet: the planner starts on the known regions.
  expect(within(drawer).getByRole("radio",{name:/Selected site/})).toBeDisabled();
  expect(screen.getByTestId("globe")).toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole("button",{name:"Close planner"}));
  expect(screen.queryByRole("complementary",{name:"Mission planner"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Open mission planner"}));
  fireEvent.click(screen.getByRole("button",{name:"Test enter surface"}));       // standing on the Moon gets the screen
  expect(screen.queryByRole("complementary",{name:"Mission planner"})).not.toBeInTheDocument();
  await screen.findByText(/3D terrain unavailable/);
});

test("Check this site opens the planner on the pin, and a newly dropped pin replaces it", async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  render(<App/>);
  fireEvent.click(screen.getByText("Enter coordinates…"));
  fireEvent.change(screen.getByLabelText(/^Latitude/),{target:{value:'-89.7'}});
  fireEvent.change(screen.getByLabelText(/^Longitude/),{target:{value:'-12.3'}});
  fireEvent.click(screen.getByRole('button',{name:'Pin these coordinates'}));
  expect(screen.getByRole('article',{name:'Selected site'})).toHaveTextContent('Mission site 1');
  fireEvent.click(screen.getByRole('button',{name:'Check this site'}));
  let drawer=screen.getByRole('complementary',{name:'Mission planner'});
  expect(within(drawer).getByRole('radio',{name:/Selected site/})).toBeChecked();
  expect(drawer).toHaveTextContent('Mission site 1 · -89.7000°, -12.3000°');
  expect(within(drawer).queryByRole('tab',{name:'Detailed analysis'})).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button',{name:'Drop a pin'}));
  fireEvent.change(screen.getByLabelText('Pin name (optional)'),{target:{value:'Rim candidate B'}});
  fireEvent.click(screen.getByRole('button',{name:'Place test pin'}));
  expect(screen.getByRole('article',{name:'Selected site'})).toHaveTextContent('Rim candidate B');
  fireEvent.click(screen.getByRole('button',{name:'Check this site'}));
  drawer=screen.getByRole('complementary',{name:'Mission planner'});
  expect(drawer).toHaveTextContent('Rim candidate B · -88.1230°, 42.4560°');
  expect(screen.getByRole('option',{name:'Mission site 1'})).toBeInTheDocument();
});

test("one mission time range drives Show Sun & Earth and the planner", async () => {
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith("/api/positions") ? {
    at_utc: "2027-03-10T06:30:00Z", latitude_deg: -85, longitude_deg: 0, elevation_m: 0, source: "JPL Horizons",
    source_url: "", horizon_model: "", sun: { azimuth_deg: 1, elevation_deg: 1, above_horizon: true },
    earth: { azimuth_deg: 2, elevation_deg: 2, above_horizon: true } } : url === "/api/sites" ? [site04] : [] }));
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  expect(screen.queryByLabelText(/^Date & time/)).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Search from (UTC)")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Search from (UTC)"), { target: { value: "2027-03-10 06:30" } });
  await screen.findByRole("option", {name: /Site04/});
  fireEvent.change(screen.getByRole("combobox", {name: "Site"}), {target: {value: "4"}});
  fireEvent.click(screen.getByRole("button", { name: "Show Sun & Earth" }));
  await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.startsWith("/api/positions"))).toBe(true));
  const positions = new URL(fetch.mock.calls.find(([url]) => url.startsWith("/api/positions"))![0], "http://x");
  expect(positions.searchParams.get("at")).toBe("2027-03-10T06:30:00Z");
  expect(positions.searchParams.get("lat")).toBe("-89.76");
  fireEvent.click(screen.getByRole("button", { name: "Open mission planner" }));
  const drawer = screen.getByRole("complementary", { name: "Mission planner" });
  expect(within(drawer).getByLabelText("Search from (UTC)")).toHaveValue("2027-03-10 06:30");
});
