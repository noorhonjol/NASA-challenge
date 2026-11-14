"""Prepare product 81 as a local 50 m overview and cached native 5 m detail chunks.

The 3.46 GB original stays on disk; the browser never loads the full raster.
All raster decoding, reprojection and compression happen here, not in the API.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys
from datetime import datetime,timezone

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from PIL import Image
from sqlmodel import Session,select

from app.db import engine
from app.models import TerrainDataset
from app.settings import get_settings
from app.terrain import bilinear,south_polar_xy
from scripts.download_terrain import global_dem
from scripts.prepare_browser_terrain import write_grid

ROOT=Path(get_settings().terrain_data_dir).resolve()
FOLDER=ROOT/'Mosaic81'
RADIUS=1737400
COVERAGE_RADIUS=float(2*RADIUS*np.tan(np.radians(3)/2))
CHUNK=1024


def json_write(path,value):
    temporary=path.with_suffix('.json.partial')
    temporary.write_text(json.dumps(value,indent=2,allow_nan=False),encoding='utf-8')
    temporary.replace(path)


def encode(values):
    valid=np.isfinite(values)
    if valid.any() and (values[valid].min() < -16383.5 or values[valid].max() > 16383.5):
        raise ValueError('Source elevation outside display encoding range')
    return np.where(valid,np.rint(np.nan_to_num(values)*2),-32768).astype('<i2')


def compressed(path,values):
    if path.is_file():return
    delta=values.copy();delta[:,1:]=values[:,1:]-values[:,:-1]
    temporary=path.with_suffix('.gz.partial')
    with temporary.open('wb') as file:
        with gzip.GzipFile(fileobj=file,mode='wb',compresslevel=4,mtime=0) as output:
            output.write(delta.tobytes())
    temporary.replace(path)


def mask_coverage(grid,left,top,resolution,nodata):
    grid=grid.astype('<f4',copy=False)
    if nodata is not None and np.isfinite(nodata):grid[grid==nodata]=np.nan
    x=left+(np.arange(grid.shape[1])+.5)*resolution
    y=top-(np.arange(grid.shape[0])+.5)*resolution
    grid[x[None,:]**2+y[:,None]**2>COVERAGE_RADIUS**2]=np.nan
    return grid


def main():
    original=FOLDER/'surface.tif'
    download=json.loads((FOLDER/'download.json').read_text())
    if original.stat().st_size != download['size_bytes']:raise ValueError('Original GeoTIFF size mismatch')
    global_source=global_dem()
    with Session(engine) as session:
        dataset=session.exec(select(TerrainDataset).where(TerrainDataset.catalog_key=='pgda-81:87S')).one()
        dataset_id=dataset.id
    chunk_folder=FOLDER/f'chunks-{download["sha256"][:12]}'
    chunk_folder.mkdir(exist_ok=True)
    available=[];minimum=float('inf');maximum=float('-inf');largest_error=0.
    with rasterio.Env(GDAL_CACHEMAX=128*1024*1024,GDAL_NUM_THREADS='2'):
      with rasterio.open(original) as source:
        if source.shape!=(40000,40000) or source.count!=1 or source.res!=(5,5):raise ValueError('Unexpected product 81 raster layout')
        if source.bounds != (-100000,-100000,100000,100000):raise ValueError('Unexpected polar bounds')
        crs=source.crs.to_dict()
        if crs.get('proj')!='stere' or crs.get('lat_0')!=-90:raise ValueError('Unexpected lunar projection')
        print('Preparing 50 m overview...',flush=True)
        overview=source.read(1,out_shape=(4000,4000),resampling=Resampling.bilinear)
        overview=mask_coverage(overview,-100000,100000,50,source.nodata)
        np.save(FOLDER/'overview.npy',overview,allow_pickle=False)
        compressed(FOLDER/'overview.delta.i16.gz',encode(overview))
        native_origin=[source.transform.c+2.5,source.transform.f-2.5]
        print('Preparing native 5 m detail chunks (bounded memory)...',flush=True)
        rows=(source.height+CHUNK-1)//CHUNK;cols=(source.width+CHUNK-1)//CHUNK
        for row in range(rows):
            y0=row*CHUNK;h=min(CHUNK+1,source.height-y0)
            band=source.read(1,window=Window(0,y0,source.width,h))
            band=mask_coverage(band,-100000,100000-y0*5,5,source.nodata)
            for col in range(cols):
                x0=col*CHUNK;w=min(CHUNK+1,source.width-x0)
                grid=band[:,x0:x0+w];valid=np.isfinite(grid)
                if not valid.any():continue
                encoded=encode(grid)
                largest_error=max(largest_error,float(np.max(np.abs(encoded[valid]*.5-grid[valid]))))
                minimum=min(minimum,float(grid[valid].min()));maximum=max(maximum,float(grid[valid].max()))
                compressed(chunk_folder/f'{row}-{col}.i16.gz',encoded)
                available.append(f'{row}/{col}')
            print(f'Detail row {row+1}/{rows}: {len(available)} cached chunks',flush=True)
        latitude=-89.5;longitude=0.
        cx,cy=south_polar_xy(latitude,longitude)
        center_height=float(next(source.sample([(float(cx),float(cy))]))[0])
        source_wkt=source.crs.to_wkt()
    print('Preparing local mosaic relief image...',flush=True)
    finite=np.isfinite(overview)
    filled=np.where(finite,overview,0).astype(float)
    dy,dx=np.gradient(filled,50,50)
    lighting=(-dx*-.5+dy*.5+np.sqrt(.5))/np.sqrt(1+dx*dx+dy*dy)
    shade=np.clip(.18+.82*np.maximum(lighting,0),0,1)**.75
    shade[~finite]=np.nan
    width,height=4096,2048
    rgba=np.zeros((height,width,4),dtype=np.uint8)
    for start in range(0,height,64):
        end=min(start+64,height)
        lon,lat=np.meshgrid(-180+(np.arange(width)+.5)*360/width,-87-(np.arange(start,end)+.5)*3/height)
        x,y=south_polar_xy(lat,lon)
        values=bilinear(shade,(x+99975)/50,(99975-y)/50)
        distance=COVERAGE_RADIUS-np.hypot(x,y)
        alpha=np.where(np.isfinite(values),np.clip(distance/250,0,1),0)
        rgba[start:end,:,:3]=(np.clip(np.nan_to_num(values),0,1)[:,:,None]*255).astype(np.uint8)
        rgba[start:end,:,3]=(alpha*255).astype(np.uint8)
    Image.fromarray(rgba).save(FOLDER/'relief.png',optimize=True)
    chunks={
        'size':CHUNK,'width':40000,'height':40000,'resolution_m':5,
        'pixel_center_origin_xy_m':native_origin,'available':available,
        'file_pattern':f'Mosaic81/{chunk_folder.name}/{{row}}-{{col}}.i16.gz',
    }
    info={
        'id':dataset_id,'catalog_key':'pgda-81:87S','region_id':'Mosaic81',
        'name':'South Pole LOLA DEM Mosaic, 87-90 S','product_id':81,
        'file':'Mosaic81/overview.npy','original':'Mosaic81/surface.tif',
        'grid_file':'Mosaic81/overview.delta.i16.gz','imagery_file':'Mosaic81/relief.png',
        'width':4000,'height':4000,'resolution_m':50,'native_resolution_m':5,
        'bounds_xy_m':[-100000,-100000,100000,100000],
        'pixel_center_origin_xy_m':[-99975,99975],'coverage_radius_m':COVERAGE_RADIUS,
        'center':{'latitude':latitude,'longitude':longitude,'elevation':center_height},
        'min_elevation_m':minimum,'max_elevation_m':maximum,'sha256':download['sha256'],
        'source_sha256':download['sha256'],'size_bytes':download['size_bytes'],
        'frame':'MOON_ME','ephemeris':'DE421','crs_wkt':source_wkt,
        'source':download['source'],'encoding':'int16-le-delta-x','scale_m':.5,'nodata':-32768,
        'grid_bytes':4000*4000*2,'compressed_bytes':(FOLDER/'overview.delta.i16.gz').stat().st_size,
        'imagery_rectangle':[-180,-90,180,-87],'imagery_bytes':(FOLDER/'relief.png').stat().st_size,
        'chunks':chunks,'max_display_height_error_m':largest_error,
    }
    json_write(FOLDER/'surface.json',info);json_write(FOLDER/'browser.json',info)
    old=json.loads((ROOT/'manifest.json').read_text()) if (ROOT/'manifest.json').is_file() else {'baseline':global_source,'regions':[]}
    legacy=[r for r in old['regions'] if r.get('catalog_key','').startswith('pgda-78:')]
    if legacy:json_write(ROOT/'legacy-78-cleanup.json',{'regions':legacy})
    if (ROOT/'browser-manifest.json').is_file():
        old_browser=json.loads((ROOT/'browser-manifest.json').read_text())
    else:
        base=np.memmap(ROOT/global_source['file'],dtype='<i2',mode='r',shape=(2880,5760))
        base=np.rint(base.astype(np.float32).reshape(1440,2,2880,2).mean(axis=(1,3))).astype('<i2')
        write_grid(ROOT/'global/grid.delta.i16.gz',base)
        old_browser={'reference_radius_m':RADIUS,'tile_size':65,'display_quantization_m':.5,'max_display_height_error_m':.25,
            'baseline':{'file':'global/grid.delta.i16.gz','width':2880,'height':1440,'pixels_per_degree':8,'scale_m':.5,
                        'encoding':'int16-le-delta-x','nodata':-32768,'source':global_source['source'],
                        'min_elevation_m':global_source['min_elevation_m'],'max_elevation_m':global_source['max_elevation_m']}}
    version=hashlib.sha256((download['sha256']+'-pgda81-browser-v1').encode()).hexdigest()[:16]
    citation='NASA PGDA product 81; Barker et al. (2021), doi:10.1016/j.pss.2020.105119; PDS LOLA LDEM_16'
    json_write(ROOT/'manifest.json',{**old,'reference_radius_m':RADIUS,'tile_size':65,'version':version,'regions':[info],'citation':citation})
    json_write(ROOT/'browser-manifest.json',{**old_browser,'version':version,'regions':[info],'citation':citation})
    with Session(engine) as session:
        row=session.get(TerrainDataset,dataset_id)
        row.retrieved_at=datetime.now(timezone.utc)
        row.provenance={**row.provenance,'storage_status':'downloaded','terrain_ready':True,'browser_ready':True,
                        'local':info,'browser_package':{'version':version,'overview_resolution_m':50,'native_resolution_m':5,'chunk_count':len(available)}}
        session.add(row);session.commit()
    print(f'Product 81 READY: {len(available)} detail chunks; max display error {largest_error} m; version {version}',flush=True)


if __name__=='__main__':main()
