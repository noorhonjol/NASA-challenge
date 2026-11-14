import {expect,test} from "vitest";
import {buildLolaHeightmap,decodeGrid,sampleGrid,sampleLola,type Grid,type RegionGrid} from "./lolaSampling";

const global: Grid={values:new Int16Array(8).fill(200),width:4,height:2,scale_m:.5,nodata:-32768};

test("delta decoding preserves signed overflow, nodata, and independent rows",()=>{
  const original=new Int16Array([-32768,16000,-16000,50,100,0,-50,-32768]);
  const delta=new Int16Array(original);
  for(let row=0;row<2;row++)for(let col=3;col>0;col--)delta[row*4+col]=original[row*4+col]-original[row*4+col-1];
  expect(decodeGrid(delta.buffer,4,2,"int16-le-delta-x")).toEqual(original);
  expect(()=>decodeGrid(new ArrayBuffer(4),4,2,"int16-le")).toThrow(/Invalid/);
});

test("bilinear sampling ignores missing pixels and wraps the longitude seam",()=>{
  const grid={...global,width:2,values:new Int16Array([2,-32768,6,10])};
  expect(sampleGrid(grid,.5,.5)).toBeCloseTo(3);
  const wrapped={...global,width:2,values:new Int16Array([20,60,20,60])};
  expect(sampleGrid(wrapped,1.5,0,true)).toBeCloseTo(20);
});

test("regional samples use south-polar coordinates and source pixel centers",()=>{
  const values=new Int16Array(401*401);
  for(let row=0;row<401;row++)for(let col=0;col<401;col++)values[row*401+col]=1000+col*6+row*8;
  const region: RegionGrid={values,width:401,height:401,scale_m:.5,nodata:-32768,
    bounds_xy_m:[-1002.5,-1002.5,1002.5,1002.5],pixel_center_origin_xy_m:[-1000,1000],resolution_m:5};
  expect(sampleLola(global,1/90,-Math.PI/2,0,region)).toBeCloseTo(1900);
  expect(sampleLola(global,1/90,0,0,region)).toBeCloseTo(100);
});

test("adjacent in-memory tiles agree on their shared edge",()=>{
  const a=buildLolaHeightmap(global,1/90,{west:-Math.PI,east:0,north:Math.PI/2,south:-Math.PI/2},65);
  const b=buildLolaHeightmap(global,1/90,{west:0,east:Math.PI,north:Math.PI/2,south:-Math.PI/2},65);
  for(let row=0;row<65;row++)expect(a[row*65+64]).toBe(b[row*65]);
  expect(a.length).toBe(65*65);
});

test("the circular mosaic blends to global terrain at its 87 S coverage edge",()=>{
  const region: RegionGrid={values:new Int16Array(16).fill(1000),width:4,height:4,scale_m:.5,nodata:-32768,
    bounds_xy_m:[-1000,-1000,1000,1000],pixel_center_origin_xy_m:[-750,750],resolution_m:500,coverage_radius_m:500};
  const latitude=2*Math.atan(500/(2*1737400))-Math.PI/2;
  expect(sampleLola(global,1/90,latitude,0,region)).toBeCloseTo(100,6);
  expect(sampleLola(global,1/90,-Math.PI/2,0,region)).toBeCloseTo(500,6);
});
