import * as Cesium from "cesium";
import { fetchTerrainManifest } from "../api/client";
import { buildLolaHeightmap, decodeGrid, sampleCapXY, type Grid, type RegionGrid } from "./lolaSampling";
import type { CapSource } from "./polarCap";
import { createMosaicDetails } from "./mosaicChunks";

const globalGrids=new Map<string,Promise<Grid>>();

async function loadGrid(url: string, spec: Omit<Grid,"values">): Promise<Grid> {
  // gzip is prepared on disk and decoded by the browser's HTTP stack once.
  const response=await fetch(url,{cache:"force-cache"});
  if(!response.ok) throw new Error(`Local terrain download failed (${response.status})`);
  const buffer=await response.arrayBuffer();
  return {...spec, values:decodeGrid(buffer,spec.width,spec.height,spec.encoding??"int16-le")};
}

export async function loadLolaTerrain() {
  const manifest=await fetchTerrainManifest();
  const ellipsoid=Cesium.Ellipsoid.MOON;
  const tilingScheme=new Cesium.GeographicTilingScheme({ellipsoid});
  let globalPending=globalGrids.get(manifest.baseline.url);
  if(!globalPending) {
    globalPending=loadGrid(manifest.baseline.url,manifest.baseline);
    globalGrids.set(manifest.baseline.url,globalPending);
    if(globalGrids.size>2) globalGrids.delete(globalGrids.keys().next().value!);
    globalPending.catch(()=>globalGrids.delete(manifest.baseline.url));
  }
  const global=await globalPending;
  const providerFor=(region?: RegionGrid,detail?:ReturnType<typeof createMosaicDetails>)=>new Cesium.CustomHeightmapTerrainProvider({
    width:manifest.tile_size,height:manifest.tile_size,tilingScheme,
    credit:"NASA LRO LOLA / South Pole DEM Mosaic (PGDA 81); Barker et al. (2021), doi:10.1016/j.pss.2020.105119",
    callback:(x,y,level)=>{
      const rectangle=tilingScheme.tileXYToRectangle(x,y,level);
      const build=()=>buildLolaHeightmap(global,manifest.baseline.pixels_per_degree,rectangle,manifest.tile_size,region);
      return detail?detail.prepare(rectangle,level,manifest.tile_size).then(build):build();
    },
  });
  const provider=providerFor();
  const cache=new Map<string,Promise<Grid>>();
  // Preserve native chunk caches when a region is disabled and enabled again.
  const details=new Map<string,ReturnType<typeof createMosaicDetails>>();
  const select=async(regionId: string)=>{
    const region=manifest.regions.find(item=>item.region_id===regionId);
    if(!region) return {provider,imagery:null,cap:null};
    let pending=cache.get(regionId);
    if(!pending) {
      pending=loadGrid(region.grid_url,region);
      cache.set(regionId,pending);
      // Keep at most two detailed grids in memory; others remain HTTP-cached.
      if(cache.size>2) cache.delete(cache.keys().next().value!);
      pending.catch(()=>cache.delete(regionId));
    }
    const [west,south,east,north]=region.imagery_rectangle;
    const [grid,imagery]=await Promise.all([pending,Cesium.SingleTileImageryProvider.fromUrl(region.imagery_url,{
      rectangle:Cesium.Rectangle.fromDegrees(west,south,east>180?east-360:east,north),
      ellipsoid,credit:"NASA PGDA 81 DEM-derived shaded relief; fixed light for visual inspection",
    })]);
    let detail=details.get(regionId);
    if(!detail && region.chunks) {
      detail=createMosaicDetails(region,loadGrid);
      details.set(regionId,detail);
    }
    const regionGrid={...grid,...region,sampleDetail:detail?.sample} as RegionGrid;
    // Polar regions are drawn by the polar cap mesh (polarCap.ts) rather than globe tiles.
    const cap: CapSource|null=region.product_id===81?{
      sample:(x,y,useDetail)=>sampleCapXY(global,manifest.baseline.pixels_per_degree,regionGrid,x,y,useDetail),
      prepareDetail:detail?.prepareXY,
    }:null;
    return {provider:providerFor(regionGrid,detail),imagery,cap};
  };
  return {provider,select,manifest};
}
