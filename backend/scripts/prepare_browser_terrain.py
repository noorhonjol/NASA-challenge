"""Prepare static compressed grids and georeferenced PNGs for browser-only sampling.

Run after download_terrain.py. The original GeoTIFFs remain untouched. Browser
grids quantize heights to 0.5 m (maximum 0.25 m display error); source spacing is
preserved at 5 m. No ephemeris or horizon calculations use the display grids.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from PIL import Image
from sqlmodel import Session

from app.db import engine
from app.models import TerrainDataset
from app.settings import get_settings
from app.terrain import bilinear, south_polar_xy

ROOT = Path(get_settings().terrain_data_dir).resolve()


def write_json(path, value):
    temporary = path.with_suffix(".json.partial")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def write_grid(path, grid):
    if path.is_file():
        return
    delta = grid.copy()
    delta[:, 1:] = grid[:, 1:] - grid[:, :-1]
    temporary = path.with_suffix(path.suffix + ".partial")
    with temporary.open("wb") as file:
        with gzip.GzipFile(fileobj=file, mode="wb", compresslevel=4, mtime=0) as compressed:
            compressed.write(delta.tobytes())
    temporary.replace(path)


def geographic_rectangle(bounds):
    left, bottom, right, top = bounds
    closest_x = np.clip(0, left, right); closest_y = np.clip(0, bottom, top)
    min_rho = np.hypot(closest_x, closest_y)
    max_rho = max(np.hypot(x,y) for x in (left,right) for y in (bottom,top))
    lat = lambda rho: float(np.degrees(2*np.arctan(rho/(2*1737400))-np.pi/2))
    south, north = lat(min_rho), lat(max_rho)
    if min_rho == 0:
        return [-180., south, 180., north]
    angles = sorted(float(np.degrees(np.arctan2(x,y)) % 360) for x in (left,right) for y in (bottom,top))
    gaps = [(angles[(i+1)%4] + (360 if i==3 else 0) - angles[i], i) for i in range(4)]
    _, i = max(gaps)
    west = angles[(i+1)%4]
    east = angles[i]
    if east < west: east += 360
    if west > 180: west -= 360; east -= 360
    return [west, south, east, north]


def prepare_region(info):
    folder = ROOT / info["region_id"]
    output = folder / "browser.json"
    if output.is_file():
        cached = json.loads(output.read_text())
        if cached.get("source_sha256") == info["sha256"] and (ROOT/cached["grid_file"]).is_file() and (folder/"relief.png").is_file():
            if cached.get("encoding") != "int16-le-delta-x":
                with gzip.open(ROOT/cached["grid_file"], "rb") as file:
                    grid = np.frombuffer(file.read(), dtype="<i2").reshape((cached["height"],cached["width"]))
                write_grid(folder/"grid.delta.i16.gz",grid)
                cached["grid_file"] = f'{info["region_id"]}/grid.delta.i16.gz'
                cached["encoding"] = "int16-le-delta-x"
                cached["compressed_bytes"] = (folder/"grid.delta.i16.gz").stat().st_size
                write_json(output,cached)
                print(f'{info["region_id"]}: optimized browser grid {cached["compressed_bytes"]/1e6:.1f} MB',flush=True)
            return cached
    source = np.load(ROOT / info["file"], mmap_mode="r", allow_pickle=False)
    finite = np.isfinite(source)
    if source[finite].min() < -16383.5 or source[finite].max() > 16383.5:
        raise ValueError("Elevations outside display encoding range")
    encoded = np.where(finite, np.rint(np.nan_to_num(source)*2), -32768).astype("<i2")
    write_grid(folder/"grid.delta.i16.gz", encoded)
    # Shade in source stereographic coordinates; fixed light is for visual inspection.
    coarse = source[::4, ::4].astype(float)
    dy, dx = np.gradient(coarse, 20, 20)
    light = (-dx*-0.5 + dy*0.5 + np.sqrt(.5))/np.sqrt(1+dx*dx+dy*dy)
    shade = np.clip(.18+.82*np.maximum(light,0),0,1)**.75
    rect = geographic_rectangle(info["bounds_xy_m"])
    west,south,east,north=rect
    width,height=2048,1024
    rgba=np.zeros((height,width,4),dtype=np.uint8)
    left,bottom,right,top=info["bounds_xy_m"]
    origin_x,origin_y=info["pixel_center_origin_xy_m"]
    # Chunked reprojection keeps preprocessing memory bounded.
    for start in range(0,height,64):
        end=min(start+64,height)
        lon,lat=np.meshgrid(west+(np.arange(width)+.5)*(east-west)/width,
                           north-(np.arange(start,end)+.5)*(north-south)/height)
        x,y=south_polar_xy(lat,lon)
        values=bilinear(shade,(x-origin_x)/20,(origin_y-y)/20)
        distance=np.minimum.reduce([x-left,right-x,y-bottom,top-y])
        alpha=np.clip(distance/250,0,1)
        rgba[start:end,:,:3]=(np.clip(np.nan_to_num(values),0,1)[:,:,None]*255).astype(np.uint8)
        rgba[start:end,:,3]=(alpha*255).astype(np.uint8)
    Image.fromarray(rgba).save(folder/"relief.png",optimize=True)
    record={**info,"source_sha256":info["sha256"],"grid_file":f'{info["region_id"]}/grid.delta.i16.gz',
            "imagery_file":f'{info["region_id"]}/relief.png',"imagery_rectangle":rect,
            "encoding":"int16-le-delta-x","scale_m":.5,"nodata":-32768,
            "grid_bytes":encoded.nbytes,"compressed_bytes":(folder/"grid.delta.i16.gz").stat().st_size,
            "imagery_bytes":(folder/"relief.png").stat().st_size}
    write_json(output,record)
    print(f'{info["region_id"]}: browser package {(record["compressed_bytes"]+record["imagery_bytes"])/1e6:.1f} MB',flush=True)
    return record


def main():
    manifest=json.loads((ROOT/"manifest.json").read_text())
    global_source=manifest["baseline"]
    global_raw=np.memmap(ROOT/global_source["file"],dtype="<i2",mode="r",shape=(2880,5760))
    # 8 px/degree global backdrop; full 16 ppd original remains on disk.
    global_grid=np.rint(global_raw.astype(np.float32).reshape(1440,2,2880,2).mean(axis=(1,3))).astype("<i2")
    write_grid(ROOT/"global/grid.delta.i16.gz",global_grid)
    baseline={"file":"global/grid.delta.i16.gz","width":2880,"height":1440,"pixels_per_degree":8,
              "source":global_source["source"],"min_elevation_m":global_source["min_elevation_m"],"max_elevation_m":global_source["max_elevation_m"],
              "scale_m":.5,"encoding":"int16-le-delta-x","nodata":-32768,"compressed_bytes":(ROOT/"global/grid.delta.i16.gz").stat().st_size}
    regions=[prepare_region(info) for info in manifest["regions"]]
    version=hashlib.sha256((manifest["version"]+"-browser-v2").encode()).hexdigest()[:16]
    write_json(ROOT/"browser-manifest.json",{
        "version":version,"reference_radius_m":1737400,"tile_size":65,
        "baseline":baseline,"regions":regions,"citation":manifest["citation"],
        "display_quantization_m":.5,"max_display_height_error_m":.25,
    })
    with Session(engine) as session:
        for region in regions:
            row=session.get(TerrainDataset,region["id"])
            row.provenance={**row.provenance,"browser_ready":True,"browser_package":{
                "grid_file":region["grid_file"],"imagery_file":region["imagery_file"],
                "encoding":"int16-le-delta-x","scale_m":.5,"version":version}}
            session.add(row)
        session.commit()
    print(f'Static browser terrain ready: {len(regions)} regions; version {version}',flush=True)


if __name__=="__main__":
    main()
