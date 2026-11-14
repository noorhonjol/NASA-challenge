/** Display-only sampling of locally prepared lunar grids. No network or server calls. */
export type Grid = { values: Int16Array; width: number; height: number; scale_m: number; nodata: number; encoding?: string };

export function decodeGrid(buffer: ArrayBuffer, width: number, height: number, encoding: string): Int16Array {
  if(buffer.byteLength !== width*height*2) throw new Error("Invalid prepared terrain grid");
  const values=new Int16Array(buffer);
  if(encoding === "int16-le-delta-x") {
    for(let row=0;row<height;row++) {
      const start=row*width;
      for(let col=1;col<width;col++) values[start+col]=values[start+col-1]+values[start+col];
    }
  } else if(encoding !== "int16-le") throw new Error("Unsupported terrain encoding");
  return values;
}
export type RegionGrid = Grid & { bounds_xy_m: number[]; pixel_center_origin_xy_m: number[]; resolution_m: number;
  coverage_radius_m?: number; sampleDetail?: (x: number,y: number)=>number };

export function sampleGrid(grid: Grid, column: number, row: number, wrap = false): number {
  const {width, height, values, nodata} = grid;
  column = wrap ? ((column % width) + width) % width : Math.max(0, Math.min(width-1, column));
  row = Math.max(0, Math.min(height-1, row));
  const x0 = Math.floor(column), y0 = Math.floor(row);
  const x1 = wrap ? (x0+1)%width : Math.min(x0+1,width-1), y1 = Math.min(y0+1,height-1);
  const fx = column-x0, fy = row-y0;
  let sum=0, weight=0;
  const a=values[y0*width+x0], b=values[y0*width+x1], c=values[y1*width+x0], d=values[y1*width+x1];
  const wa=(1-fx)*(1-fy), wb=fx*(1-fy), wc=(1-fx)*fy, wd=fx*fy;
  if(a!==nodata) {sum+=a*wa; weight+=wa;}
  if(b!==nodata) {sum+=b*wb; weight+=wb;}
  if(c!==nodata) {sum+=c*wc; weight+=wc;}
  if(d!==nodata) {sum+=d*wd; weight+=wd;}
  return weight ? sum/weight*grid.scale_m : NaN;
}

export function sampleLola(global: Grid, pixelsPerDegree: number, latitude: number, longitude: number, region?: RegionGrid): number {
  const degrees = 180/Math.PI;
  const baseline = sampleGrid(global, ((longitude*degrees%360)+360)%360*pixelsPerDegree-.5, (90-latitude*degrees)*pixelsPerDegree-.5, true);
  if (!region || latitude > -70/degrees) return baseline;
  const rho=2*1737400*Math.tan(Math.PI/4+latitude/2);
  const x=rho*Math.sin(longitude), y=rho*Math.cos(longitude);
  const [left,bottom,right,top]=region.bounds_xy_m;
  if(x<left||x>right||y<bottom||y>top) return baseline;
  const detailed=region.sampleDetail?.(x,y);
  const local=Number.isFinite(detailed)?detailed!:sampleGrid(region,(x-region.pixel_center_origin_xy_m[0])/region.resolution_m,(region.pixel_center_origin_xy_m[1]-y)/region.resolution_m);
  if(!Number.isFinite(local)) return baseline;
  const edge=Math.min(x-left,right-x,y-bottom,top-y,region.coverage_radius_m===undefined?Infinity:region.coverage_radius_m-Math.hypot(x,y));
  let weight=Math.min(1,Math.max(0,edge/250)); weight=weight*weight*(3-2*weight);
  return baseline*(1-weight)+local*weight;
}

export function buildLolaHeightmap(global: Grid, ppd: number, rectangle: {west: number; east: number; north: number; south: number}, size: number, region?: RegionGrid) {
  const out=new Float32Array(size*size);
  for(let row=0;row<size;row++) {
    const lat=rectangle.north+(rectangle.south-rectangle.north)*row/(size-1);
    for(let col=0;col<size;col++) out[row*size+col]=sampleLola(global,ppd,lat,rectangle.west+(rectangle.east-rectangle.west)*col/(size-1),region);
  }
  return out;
}
