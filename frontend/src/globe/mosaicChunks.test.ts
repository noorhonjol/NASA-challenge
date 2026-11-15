import {expect,test,vi} from "vitest";
import type {TerrainRegion} from "../api/client";
import {createMosaicDetails} from "./mosaicChunks";

const region={scale_m:.5,nodata:-32768,encoding:"int16-le-delta-x",chunks:{
  size:2,width:4,height:4,resolution_m:1,pixel_center_origin_xy_m:[-1.5,1.5],
  available:["0/0","0/1","1/0","1/1"],url_template:"/local/{row}/{col}.bin",
}} as TerrainRegion;
const rectangle={west:0,east:.01,north:-Math.PI/2,south:-Math.PI/2};

test("fine terrain is fetched once from local prepared chunks and reuses its cache",async()=>{
  const load=vi.fn(async(_url:string)=>({width:3,height:3,scale_m:.5,nodata:-32768,values:new Int16Array([2,4,6,8,10,12,14,16,18])}));
  const detail=createMosaicDetails(region,load);
  expect(Number.isNaN(detail.sample(0,0))).toBe(true);
  await detail.prepare(rectangle,10,3);
  expect(load).not.toHaveBeenCalled();
  await Promise.all([detail.prepare(rectangle,11,3),detail.prepare(rectangle,11,3)]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0][0]).toBe("/local/0/0.bin");
  expect(detail.sample(0,0)).toBeCloseTo(7);
  await detail.prepare(rectangle,12,3);
  expect(load).toHaveBeenCalledTimes(1);
  expect(Number.isNaN(detail.sample(100,100))).toBe(true);
});

test("a polar x/y box loads exactly the chunks it overlaps",async()=>{
  const load=vi.fn(async(_url:string)=>({width:3,height:3,scale_m:.5,nodata:-32768,values:new Int16Array(9)}));
  const detail=createMosaicDetails(region,load);
  await detail.prepareXY(-1.6,1,-1,1.6);                       // top-left corner only
  expect(load.mock.calls.map(c=>c[0])).toEqual(["/local/0/0.bin"]);
  await detail.prepareXY(-2,-2,2,2);                           // the whole grid
  expect(load.mock.calls.map(c=>c[0]).sort()).toEqual(["/local/0/0.bin","/local/0/1.bin","/local/1/0.bin","/local/1/1.bin"]);
  await detail.prepareXY(50,50,60,60);                         // outside: nothing
  expect(load).toHaveBeenCalledTimes(4);
});
