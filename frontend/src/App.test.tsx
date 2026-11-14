import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import type { ReactNode } from "react";

vi.mock("./components/LunarGlobe", () => ({ LunarGlobe: ({options, children, onPinPlace}: {children: ReactNode; onPinPlace?: (point:{latitude:number;longitude:number;elevation:number})=>void; options: {body: string; pinPlacement?:boolean; target?: {latitude: number; longitude: number} | null}}) =>
  <>{children}{options.pinPlacement && <button onClick={()=>onPinPlace?.({latitude:-88.123,longitude:42.456,elevation:900})}>Place test pin</button>}<div data-testid="globe">{options.body}:{options.target?.latitude},{options.target?.longitude}</div></> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

test("navigation opens the new energy modal over the existing globe", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable:true,value:function(this:HTMLDialogElement){this.setAttribute("open","");}});
  Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute("open");}});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true,json:async()=>[]}));
  render(<App/>);
  fireEvent.click(screen.getByRole("button",{name:"Mission planner"}));
  expect(screen.getByRole("dialog",{name:"Lunar Energy planner"})).toHaveAttribute("open");
  expect(screen.getByTestId("globe")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Close planner"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await screen.findByText(/3D terrain unavailable/);
});

test("pin tile carries its title, coordinates and first-page UTC time into calculation", async () => {
  Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute("open","");}});
  Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute("open");}});
  const fetch=vi.fn(async (url:string)=>({ok:true,json:async()=>url.startsWith('/v1/')?{meta:{request_id:'pin-test',dem_product:'LOLA',ephemeris:'DE440',computed_in_ms:10,horizon_model:'test',limitations:[]}}:[]}));
  vi.stubGlobal('fetch',fetch);render(<App/>);
  fireEvent.change(screen.getByLabelText(/^Latitude/),{target:{value:'-89.7'}});
  fireEvent.change(screen.getByLabelText(/^Longitude/),{target:{value:'-12.3'}});
  fireEvent.change(screen.getByLabelText('Pin title'),{target:{value:'Rim candidate A'}});
  fireEvent.change(screen.getByLabelText('Date & time (UTC)'),{target:{value:'2026-12-03T05:30'}});
  fireEvent.click(screen.getByRole('button',{name:'Pin these coordinates'}));
  expect(screen.getByRole('article',{name:'Selected mission pin'})).toHaveTextContent('Rim candidate A');
  fireEvent.click(screen.getByRole('button',{name:'Calculate energy for this pin'}));
  let dialog=screen.getByRole('dialog',{name:'Lunar Energy planner'});
  expect(within(dialog).getByLabelText('Lunar latitude (° north)')).toHaveValue(-89.7);
  expect(within(dialog).getByLabelText('Lunar longitude (° east)')).toHaveValue(-12.3);
  expect(within(dialog).getByLabelText('Time (UTC)')).toHaveValue('2026-12-03T05:30');
  fireEvent.click(within(dialog).getByRole('button',{name:'Run energy analysis'}));
  await within(dialog).findByRole('region',{name:'Energy results'});
  const url=fetch.mock.calls.find(([url])=>url.startsWith('/v1/'))?.[0];
  expect(url).toContain('lat=-89.7');expect(url).toContain('lon=-12.3');expect(url).toContain('2026-12-03T05%3A30');
  fireEvent.click(within(dialog).getByRole('button',{name:'Close planner'}));
  fireEvent.change(screen.getByLabelText('Pin title'),{target:{value:'Rim candidate B'}});
  fireEvent.change(screen.getByLabelText('Date & time (UTC)'),{target:{value:'2026-12-05T09:00'}});
  fireEvent.click(screen.getByRole('button',{name:'Add pin on Moon'}));
  fireEvent.click(screen.getByRole('button',{name:'Place test pin'}));
  fireEvent.click(screen.getByRole('button',{name:'Calculate energy for this pin'}));
  dialog=screen.getByRole('dialog',{name:'Lunar Energy planner'});
  expect(within(dialog).getByLabelText('Lunar latitude (° north)')).toHaveValue(-88.123);
  expect(within(dialog).getByLabelText('Time (UTC)')).toHaveValue('2026-12-05T09:00');
  expect(within(dialog).queryByRole('region',{name:'Energy results'})).not.toBeInTheDocument();
  expect(screen.getByRole('option',{name:'Rim candidate A'})).toBeInTheDocument();
});
