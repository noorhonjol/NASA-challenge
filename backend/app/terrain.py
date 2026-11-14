"""Local LOLA raster sampling and geographic Cesium heightmap tiles.

PGDA: south polar stereographic on the 1,737,400 m MOON_ME/DE421 sphere.
PDS baseline: 16 px/degree, north-to-south rows, 0..360 east longitude.
No Earth EPSG CRS is used for either product.
"""
from functools import lru_cache
import json
from pathlib import Path
from io import BytesIO

import numpy as np
from PIL import Image

from .settings import get_settings


class TerrainUnavailable(Exception):
    pass


def data_root():
    return Path(get_settings().terrain_data_dir).resolve()


def local_path(root: Path, relative: str):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise TerrainUnavailable("Invalid local terrain path")
    return path


@lru_cache(maxsize=4)
def _manifest(path: str, mtime: int):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def manifest():
    path = data_root() / "manifest.json"
    try:
        return _manifest(str(path), path.stat().st_mtime_ns)
    except (OSError, ValueError) as exc:
        raise TerrainUnavailable("Terrain is not downloaded. Run scripts/download_terrain.py.") from exc


def public_manifest():
    m = manifest()
    return {
        "version": m["version"], "reference_radius_m": m["reference_radius_m"],
        "tile_size": m["tile_size"], "citation": m["citation"],
        "baseline": {key: m["baseline"][key] for key in ("key", "source", "min_elevation_m", "max_elevation_m")},
        "regions": [{key: region[key] for key in (
            "id", "catalog_key", "region_id", "name", "resolution_m", "bounds_xy_m", "center",
            "min_elevation_m", "max_elevation_m", "frame", "ephemeris",
        )} for region in m["regions"]],
    }


def browser_manifest():
    path = data_root() / "browser-manifest.json"
    try:
        return _manifest(str(path), path.stat().st_mtime_ns)
    except (OSError, ValueError) as exc:
        raise TerrainUnavailable("Browser terrain is not prepared. Run scripts/prepare_browser_terrain.py.") from exc


def public_browser_manifest():
    m = browser_manifest()
    return {
        "version": m["version"], "reference_radius_m": m["reference_radius_m"],
        "tile_size": m["tile_size"], "citation": m["citation"],
        "display_quantization_m": m["display_quantization_m"],
        "baseline": {**{key: value for key, value in m["baseline"].items() if key != "file"},
                     "url": f'/api/terrain/assets/global.bin?v={m["version"]}'},
        "regions": [{**{key: region[key] for key in (
            "id", "catalog_key", "region_id", "name", "resolution_m", "bounds_xy_m", "center",
            "min_elevation_m", "max_elevation_m", "width", "height", "pixel_center_origin_xy_m",
            "scale_m", "nodata", "encoding", "grid_bytes", "compressed_bytes", "imagery_rectangle",
        )}, **{key:region[key] for key in ("product_id","native_resolution_m","coverage_radius_m") if key in region},
            **({"chunks":{**{k:v for k,v in region["chunks"].items() if k != "file_pattern"},
                "url_template": f'/api/terrain/assets/mosaics/{region["id"]}/chunks/{{row}}/{{col}}.bin?v={m["version"]}'}}
               if "chunks" in region else {}),
            "grid_url": f'/api/terrain/assets/regions/{region["id"]}/grid.bin?v={m["version"]}',
            "imagery_url": f'/api/terrain/assets/regions/{region["id"]}/relief.png?v={m["version"]}'}
            for region in m["regions"]],
    }


@lru_cache(maxsize=32)
def _array(path: str):
    return np.load(path, mmap_mode="r", allow_pickle=False)


@lru_cache(maxsize=2)
def _global_array(path: str, height: int, width: int):
    return np.memmap(path, dtype="<i2", mode="r", shape=(height, width))


def bilinear(grid, columns, rows, wrap_x=False):
    height, width = grid.shape
    rows = np.clip(rows, 0, height - 1)
    columns = columns % width if wrap_x else np.clip(columns, 0, width - 1)
    x0 = np.floor(columns).astype(np.int64); y0 = np.floor(rows).astype(np.int64)
    x1 = (x0 + 1) % width if wrap_x else np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = columns - x0; fy = rows - y0
    total = np.zeros_like(columns, dtype=np.float64)
    weights = np.zeros_like(total)
    for values, weight in (
        (grid[y0, x0], (1 - fx) * (1 - fy)), (grid[y0, x1], fx * (1 - fy)),
        (grid[y1, x0], (1 - fx) * fy), (grid[y1, x1], fx * fy),
    ):
        valid = np.isfinite(values)
        total += np.where(valid, values, 0) * weight
        weights += valid * weight
    return np.divide(total, weights, out=np.full_like(total, np.nan), where=weights > 0)


def south_polar_xy(latitude_deg, longitude_deg, radius=1737400):
    rho = 2 * radius * np.tan(np.pi / 4 + np.radians(latitude_deg) / 2)
    lon = np.radians(longitude_deg)
    return rho * np.sin(lon), rho * np.cos(lon)


def sample_heights(m, root: Path, latitudes, longitudes):
    latitude, longitude = np.broadcast_arrays(np.asarray(latitudes, dtype=float), np.asarray(longitudes, dtype=float))
    baseline = m["baseline"]
    grid = _global_array(str(local_path(root, baseline["file"])), baseline["height"], baseline["width"])
    # Coordinates refer to pixel centers, including wrap across 0/360 longitude.
    columns = (longitude % 360) * baseline["pixels_per_degree"] - 0.5
    rows = (90 - latitude) * baseline["pixels_per_degree"] - 0.5
    heights = bilinear(grid, columns, rows, wrap_x=True) * baseline["scale"]
    if np.min(latitude) > -70:
        return heights
    x, y = south_polar_xy(np.minimum(latitude, 0), longitude, m["reference_radius_m"])
    # Larger regions first; smaller overlapping 5 m regions take precedence.
    regions = sorted(m["regions"], key=lambda r: r["width"] * r["height"], reverse=True)
    for region in regions:
        left, bottom, right, top = region["bounds_xy_m"]
        inside = (latitude < -70) & (x >= left) & (x <= right) & (y >= bottom) & (y <= top)
        if not np.any(inside):
            continue
        pixels = _array(str(local_path(root, region["file"])))
        origin_x, origin_y = region["pixel_center_origin_xy_m"]
        columns = (x[inside] - origin_x) / region["resolution_m"]
        rows = (origin_y - y[inside]) / region["resolution_m"]
        local = bilinear(pixels, columns, rows)
        # Blend a 250 m perimeter to the coarse baseline to avoid artificial walls.
        edge_distance = np.minimum.reduce([x[inside]-left, right-x[inside], y[inside]-bottom, top-y[inside]])
        weight = np.clip(edge_distance / 250, 0, 1)
        weight = weight * weight * (3 - 2 * weight)
        valid = np.isfinite(local)
        existing = heights[inside]
        heights[inside] = np.where(valid, existing * (1-weight) + np.nan_to_num(local) * weight, existing)
    return heights


@lru_cache(maxsize=512)
def _heightmap(root: str, mtime: int, level: int, x: int, y: int):
    m = _manifest(str(Path(root) / "manifest.json"), mtime)
    size = m["tile_size"]
    columns, rows = 2 ** (level+1), 2 ** level
    west, east = -180 + x*360/columns, -180 + (x+1)*360/columns
    north, south = 90 - y*180/rows, 90 - (y+1)*180/rows
    longitude, latitude = np.meshgrid(np.linspace(west, east, size), np.linspace(north, south, size))
    samples = sample_heights(m, Path(root), latitude, longitude).astype("<f4")
    if not np.isfinite(samples).all():
        raise TerrainUnavailable("Terrain sampling produced invalid heights")
    return samples.tobytes(), float(samples.min()), float(samples.max())


def heightmap(level, x, y):
    root = data_root()
    try:
        return _heightmap(str(root), (root / "manifest.json").stat().st_mtime_ns, level, x, y)
    except OSError as exc:
        raise TerrainUnavailable("Local terrain files are unavailable") from exc


@lru_cache(maxsize=256)
def _hillshade(root: str, mtime: int, level: int, x: int, y: int):
    m = _manifest(str(Path(root) / "manifest.json"), mtime)
    size = 256
    columns, rows = 2 ** (level+1), 2 ** level
    west, east = -180+x*360/columns, -180+(x+1)*360/columns
    north, south = 90-y*180/rows, 90-(y+1)*180/rows
    longitude, latitude = np.meshgrid(
        np.linspace(west, east, size, endpoint=False)+(east-west)/(2*size),
        np.linspace(north, south, size, endpoint=False)-(north-south)/(2*size),
    )
    projected_x, projected_y = south_polar_xy(np.minimum(latitude, 0), longitude)
    alpha = np.zeros((size, size))
    for region in m["regions"]:
        left, bottom, right, top = region["bounds_xy_m"]
        edge = np.minimum.reduce([projected_x-left, right-projected_x, projected_y-bottom, top-projected_y])
        alpha = np.maximum(alpha, np.where(latitude < -70, np.clip(edge / 250, 0, 1), 0))
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    if np.any(alpha):
        elevation = sample_heights(m, Path(root), latitude, longitude)
        radius = m["reference_radius_m"]
        south_step = np.radians((north-south)/size)*radius
        east_step = np.radians((east-west)/size)*radius*np.maximum(np.cos(np.radians(latitude)), 1e-6)
        dy, dx = np.gradient(elevation)
        east_slope, north_slope = dx/east_step, -dy/south_step
        az, alt = np.radians(315), np.radians(35)
        light = (-east_slope*np.sin(az)*np.cos(alt)-north_slope*np.cos(az)*np.cos(alt)+np.sin(alt))/np.sqrt(1+east_slope**2+north_slope**2)
        shade = np.clip(0.22+0.78*np.maximum(light, 0), 0, 1)**0.75
        rgba[:, :, :3] = (shade[:, :, None]*255).astype(np.uint8)
        rgba[:, :, 3] = (alpha*255).astype(np.uint8)
    output = BytesIO()
    Image.fromarray(rgba).save(output, format="PNG")
    return output.getvalue()


def hillshade(level, x, y):
    root = data_root()
    try:
        return _hillshade(str(root), (root / "manifest.json").stat().st_mtime_ns, level, x, y)
    except OSError as exc:
        raise TerrainUnavailable("Local terrain files are unavailable") from exc


def surface_elevation(latitude: float, longitude: float):
    """Sample science terrain, never the blended/quantized browser surface.

    Native product 81 takes precedence within its circular coverage; elsewhere
    use the local global LOLA raster. Missing native data is not silently replaced.
    """
    import math
    import rasterio
    from rasterio.windows import Window

    try:
        m = manifest()
        root = data_root()
        x, y = south_polar_xy(latitude, longitude)
        for region in m["regions"]:
            if region.get("product_id") != 81 or latitude > -87:
                continue
            left, bottom, right, top = region["bounds_xy_m"]
            if not (left <= x <= right and bottom <= y <= top):
                continue
            if math.hypot(x, y) > region["coverage_radius_m"]:
                continue
            with rasterio.open(local_path(root, region["original"])) as source:
                col, row = (~source.transform) * (float(x), float(y))
                col = float(np.clip(col - .5, 0, source.width - 1))
                row = float(np.clip(row - .5, 0, source.height - 1))
                c0, r0 = math.floor(col), math.floor(row)
                values = source.read(1, window=Window(c0, r0, min(2, source.width-c0), min(2, source.height-r0)), masked=True)
                weights = np.array([[1-(row-r0)], [row-r0]])[:values.shape[0]] * np.array([[1-(col-c0), col-c0]])[:, :values.shape[1]]
                invalid = np.ma.getmaskarray(values) | ~np.isfinite(values.data)
                if np.any(invalid & (weights > 0)):
                    raise TerrainUnavailable("Local LOLA mosaic has no valid elevation at these coordinates.")
                height = float(np.sum(np.where(invalid, 0, values.data) * weights))
                return {"elevation_m": height, "dataset": region["name"],
                        "catalog_key": region["catalog_key"], "resolution_m": region["native_resolution_m"],
                        "source": region.get("source"), "version": m["version"],
                        "method": "Bilinear native raster; no display blending",
                        "reference_radius_m": m["reference_radius_m"], "frame": region["frame"]}
        baseline = m["baseline"]
        grid = _global_array(str(local_path(root, baseline["file"])), baseline["height"], baseline["width"])
        col = (longitude % 360) * baseline["pixels_per_degree"] - .5
        row = float(np.clip((90-latitude)*baseline["pixels_per_degree"]-.5, 0, baseline["height"]-1))
        c0, r0 = math.floor(col), math.floor(row)
        c1, r1 = c0+1, min(r0+1, baseline["height"]-1)
        values = np.array([[grid[r0, c0 % baseline["width"]], grid[r0, c1 % baseline["width"]]],
                           [grid[r1, c0 % baseline["width"]], grid[r1, c1 % baseline["width"]]]], dtype=float)
        weights = np.array([[1-(row-r0)], [row-r0]]) * np.array([[1-(col-c0), col-c0]])
        if np.any(((values == baseline.get("nodata", -32768)) | ~np.isfinite(values)) & (weights > 0)):
            raise TerrainUnavailable("Global LOLA data has no valid elevation at these coordinates.")
        height = float(np.sum(values * weights)*baseline["scale"])
        return {"elevation_m": height, "dataset": "Global LOLA", "catalog_key": baseline["key"],
                "resolution_deg": 1/baseline["pixels_per_degree"], "source": baseline["source"],
                "version": m["version"], "method": "Bilinear global raster; no display blending",
                "reference_radius_m": m["reference_radius_m"], "frame": baseline.get("frame", "MOON_ME")}
    except (OSError, ValueError, KeyError, rasterio.errors.RasterioError) as exc:
        raise TerrainUnavailable("Local LOLA elevation data is unavailable or invalid. Prepare the terrain data and retry.") from exc
