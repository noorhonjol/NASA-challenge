import type {TerrainRegion} from "../api/client";
import {sampleGrid,type Grid} from "./lolaSampling";

type Rectangle={west:number;east:number;north:number;south:number};
type LoadGrid=(url:string,spec:Omit<Grid,"values">)=>Promise<Grid>;

/** Small, prebuilt local detail files; no runtime GeoTIFF processing or NASA access. */
export function createMosaicDetails(region:TerrainRegion,loadGrid:LoadGrid) {
  const spec=region.chunks!;
  const available=new Set(spec.available);
  const cache=new Map<string,Grid>();
  const pending=new Map<string,Promise<void>>();
  const native=(x:number,y:number)=>({column:(x-spec.pixel_center_origin_xy_m[0])/spec.resolution_m,row:(spec.pixel_center_origin_xy_m[1]-y)/spec.resolution_m});
  const keyAt=(column:number,row:number)=>`${Math.floor(Math.max(0,row)/spec.size)}/${Math.floor(Math.max(0,column)/spec.size)}`;
  const ensure=(key:string)=>{
    if(cache.has(key)||!available.has(key))return Promise.resolve();
    const existing=pending.get(key);if(existing)return existing;
    const [row,col]=key.split('/').map(Number);
    const url=spec.url_template.replace('{row}',String(row)).replace('{col}',String(col));
    const request=loadGrid(url,{
      width:Math.min(spec.size+1,spec.width-col*spec.size),height:Math.min(spec.size+1,spec.height-row*spec.size),
      scale_m:region.scale_m,nodata:region.nodata,encoding:region.encoding,
    }).then(grid=>{
      cache.set(key,grid);
      while(cache.size>64)cache.delete(cache.keys().next().value!);
    }).finally(()=>pending.delete(key));
    pending.set(key,request);return request;
  };
  const sample=(x:number,y:number)=>{
    const {column,row}=native(x,y);
    if(column<0||row<0||column>=spec.width||row>=spec.height)return NaN;
    const key=keyAt(column,row),grid=cache.get(key);if(!grid)return NaN;
    cache.delete(key);cache.set(key,grid);
    return sampleGrid(grid,column%spec.size,row%spec.size);
  };
  const prepare=async(rectangle:Rectangle,level:number,size:number)=>{
    if(level<11)return;
    const keys=new Set<string>();
    for(let row=0;row<size;row++) {
      const latitude=rectangle.north+(rectangle.south-rectangle.north)*row/(size-1);
      if(latitude> -87*Math.PI/180)continue;
      const rho=2*1737400*Math.tan(Math.PI/4+latitude/2);
      for(let col=0;col<size;col++) {
        const longitude=rectangle.west+(rectangle.east-rectangle.west)*col/(size-1);
        const pixel=native(rho*Math.sin(longitude),rho*Math.cos(longitude));
        if(pixel.column>=0&&pixel.row>=0&&pixel.column<spec.width&&pixel.row<spec.height)keys.add(keyAt(pixel.column,pixel.row));
      }
    }
    await Promise.all([...keys].map(ensure));
  };
  return {sample,prepare};
}
