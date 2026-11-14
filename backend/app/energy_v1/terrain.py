"""LOLA science sampling and height-aware, curvature-corrected horizon caches."""

from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import tempfile
import numpy as np
import rasterio
from rasterio.windows import Window
from .. import terrain as dem
from .errors import EnergyError

R = 1737400.0


def basis(lat, lon):
    p, l = np.radians([lat, lon])
    u = np.array([np.cos(p) * np.cos(l), np.cos(p) * np.sin(l), np.sin(p)])
    e = np.array([-np.sin(l), np.cos(l), 0.0])
    return e, np.cross(u, e), u


def coordinates(v):
    return np.degrees(
        np.arctan2(v[..., 2], np.hypot(v[..., 0], v[..., 1]))
    ), np.degrees(np.arctan2(v[..., 1], v[..., 0]))


class Surface:
    def __init__(self):
        try:
            self.root, self.m = dem.data_root(), dem.manifest()
            b = self.m["baseline"]
            self.b = b
            self.global_grid = dem._global_array(
                str(dem.local_path(self.root, b["file"])), b["height"], b["width"]
            )
            self.regions = [r for r in self.m["regions"] if r.get("product_id") == 81]
        except (OSError, KeyError, ValueError, dem.TerrainUnavailable) as exc:
            raise EnergyError(
                "DATA_UNAVAILABLE",
                "Local LOLA manifest or global DEM unavailable",
                status=503,
            ) from exc

    def sample(self, lat, lon, native=False):
        lat, lon = np.broadcast_arrays(np.asarray(lat, float), np.asarray(lon, float))
        shape = lat.shape
        lat, lon = lat.ravel(), lon.ravel()
        b = self.b
        cols = (lon % 360) * b["pixels_per_degree"] - 0.5
        rows = np.clip((90 - lat) * b["pixels_per_degree"] - 0.5, 0, b["height"] - 1)
        z = dem.bilinear(self.global_grid, cols, rows, True) * b["scale"]
        c = np.floor(cols).astype(int)
        r = np.floor(rows).astype(int)
        for dc, dr in ((0, 0), (1, 0), (0, 1), (1, 1)):
            invalid = self.global_grid[
                np.minimum(r + dr, b["height"] - 1), (c + dc) % b["width"]
            ] == b.get("nodata", -32768)
            z[invalid] = np.nan
        x, y = dem.south_polar_xy(lat, lon)
        for region in self.regions:
            left, bottom, right, top = region["bounds_xy_m"]
            inside = (
                (lat <= -87)
                & (x >= left)
                & (x <= right)
                & (y >= bottom)
                & (y <= top)
                & (np.hypot(x, y) <= region["coverage_radius_m"])
            )
            if not inside.any():
                continue
            try:
                if native:
                    with rasterio.open(
                        dem.local_path(self.root, region["original"])
                    ) as source:
                        for i in np.where(inside)[0]:
                            rr, cc = source.index(float(x[i]), float(y[i]), op=float)
                            col = float(np.clip(cc - 0.5, 0, source.width - 1))
                            row = float(np.clip(rr - 0.5, 0, source.height - 1))
                            c0, r0 = math.floor(col), math.floor(row)
                            grid = (
                                source.read(
                                    1,
                                    window=Window(
                                        c0,
                                        r0,
                                        min(2, source.width - c0),
                                        min(2, source.height - r0),
                                    ),
                                    masked=True,
                                )
                                .astype(float)
                                .filled(np.nan)
                            )
                            z[i] = dem.bilinear(
                                grid, np.array([col - c0]), np.array([row - r0])
                            )[0]
                else:
                    grid = dem._array(str(dem.local_path(self.root, region["file"])))
                    ox, oy = region["pixel_center_origin_xy_m"]
                    local = dem.bilinear(
                        grid,
                        (x[inside] - ox) / region["resolution_m"],
                        (oy - y[inside]) / region["resolution_m"],
                    )
                    z[inside] = np.where(np.isfinite(local), local, z[inside])
            except (OSError, ValueError, rasterio.errors.RasterioError) as exc:
                raise EnergyError(
                    "DATA_UNAVAILABLE", "Installed LOLA mosaic unavailable", status=503
                ) from exc
        if not np.isfinite(z).all():
            raise EnergyError(
                "OUT_OF_COVERAGE",
                "Invalid terrain in the analysis footprint",
                status=404,
            )
        return z.reshape(shape)

    def product(self, lat):
        return (
            self.regions[0]["catalog_key"]
            if lat <= -87 and self.regions
            else self.b["key"]
        )

    def location(self, loc):
        e, n, u = basis(loc.lat, loc.lon)
        step = (
            5.0
            if loc.lat <= -87 and self.regions
            else np.pi * R / (180 * self.b["pixels_per_degree"])
        )
        rays = np.array(
            [
                u,
                u * np.cos(step / R) + e * np.sin(step / R),
                u * np.cos(step / R) - e * np.sin(step / R),
                u * np.cos(step / R) + n * np.sin(step / R),
                u * np.cos(step / R) - n * np.sin(step / R),
            ]
        )
        lat, lon = coordinates(rays)
        z = self.sample(lat, lon, True)
        de, dn = (z[1] - z[2]) / (2 * step), (z[3] - z[4]) / (2 * step)
        normal = np.array([-de, -dn, 1.0])
        normal /= np.linalg.norm(normal)
        slope = float(np.degrees(np.arctan(np.hypot(de, dn))))
        return {
            **loc.model_dump(),
            "elevation_m": float(z[0]),
            "slope_deg": slope,
            "aspect_deg": (
                float(np.degrees(np.arctan2(-de, -dn)) % 360) if slope > 1e-9 else 0.0
            ),
        }, normal

    def horizons(self, loc, elevation):
        key = hashlib.sha256(
            json.dumps(
                ["rays-v1-500km-512", self.m["version"], loc.model_dump()],
                sort_keys=True,
            ).encode()
        ).hexdigest()
        folder = self.root / "energy-horizons"
        path = folder / (key + ".npy")
        if path.is_file():
            try:
                values = np.load(path, allow_pickle=False)
                if values.shape == (360,) and np.isfinite(values).all():
                    return values
            except (OSError, ValueError):
                pass
        e, n, u = basis(loc.lat, loc.lon)
        az = np.radians(np.arange(360))
        distances = np.unique(
            np.r_[np.arange(5, 255, 5), np.geomspace(250, 500000, 512)]
        )
        direction = np.sin(az)[:, None] * e + np.cos(az)[:, None] * n
        theta = distances / R
        rays = (
            u[None, None, :] * np.cos(theta)[None, :, None]
            + direction[:, None, :] * np.sin(theta)[None, :, None]
        )
        lat, lon = coordinates(rays)
        z = self.sample(lat, lon)
        if loc.lat <= -87 and self.regions:
            near = distances <= 250
            x, y = dem.south_polar_xy(lat[:, near], lon[:, near])
            region = self.regions[0]
            try:
                with rasterio.open(
                    dem.local_path(self.root, region["original"])
                ) as source:
                    cc = (x - source.transform.c) / source.transform.a - 0.5
                    rr = (y - source.transform.f) / source.transform.e - 0.5
                    left = max(0, int(np.floor(cc.min())))
                    top = max(0, int(np.floor(rr.min())))
                    width = min(source.width - left, int(np.ceil(cc.max())) - left + 1)
                    height = min(source.height - top, int(np.ceil(rr.max())) - top + 1)
                    if width > 0 and height > 0:
                        grid = (
                            source.read(
                                1, window=Window(left, top, width, height), masked=True
                            )
                            .astype(float)
                            .filled(np.nan)
                        )
                        local = dem.bilinear(grid, cc - left, rr - top)
                        z[:, near] = np.where(np.isfinite(local), local, z[:, near])
            except (OSError, rasterio.errors.RasterioError) as exc:
                raise EnergyError(
                    "DATA_UNAVAILABLE", "Native horizon terrain unavailable", status=503
                ) from exc
        if not np.isfinite(z).all():
            raise EnergyError("OUT_OF_COVERAGE", "Missing horizon terrain", status=404)
        values = np.degrees(
            np.arctan2(
                (R + z) * np.cos(theta) - (R + elevation + loc.height_m),
                (R + z) * np.sin(theta),
            )
        ).max(axis=1)
        far_bound = np.degrees(
            np.arctan2(
                (R + 12000) * np.cos(500000 / R) - (R + elevation + loc.height_m),
                (R + 12000) * np.sin(500000 / R),
            )
        )
        if np.any(values < far_bound):
            raise EnergyError(
                "OUT_OF_COVERAGE",
                "Horizon extent insufficient for this low site",
                status=404,
            )
        try:
            folder.mkdir(exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=folder, suffix=".npy", delete=False
            ) as output:
                np.save(output, values, allow_pickle=False)
                temporary = output.name
            Path(temporary).replace(path)
        except OSError as exc:
            raise EnergyError(
                "DATA_UNAVAILABLE", "Cannot save horizon cache", status=503
            ) from exc
        return values


@lru_cache(maxsize=2)
def surface(version):
    return Surface()


def get_surface():
    try:
        return surface(dem.manifest()["version"])
    except dem.TerrainUnavailable as exc:
        raise EnergyError("DATA_UNAVAILABLE", str(exc), status=503) from exc
