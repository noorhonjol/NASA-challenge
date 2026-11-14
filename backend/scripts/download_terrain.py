"""Download PGDA 78 LDEMs, retain originals, and build a local terrain manifest.

Run from backend: python scripts/download_terrain.py [--workers 3]
Files are cached outside Git. Restart the API after completing the import.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import numpy as np
import rasterio
from sqlmodel import Session, select

from app.db import engine
from app.models import TerrainDataset
from app.settings import get_settings

ROOT = Path(get_settings().terrain_data_dir).resolve()
GLOBAL_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_16"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, path, expected_size=None):
    if path.is_file() and (expected_size is None or path.stat().st_size == expected_size):
        return digest(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    for attempt in range(3):
        try:
            with httpx.Client(timeout=httpx.Timeout(180, connect=30), follow_redirects=True) as client:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    h = hashlib.sha256()
                    size = 0
                    with partial.open("wb") as file:
                        for chunk in response.iter_bytes(1024 * 1024):
                            file.write(chunk); h.update(chunk); size += len(chunk)
                    required = expected_size or int(response.headers.get("content-length", size))
                    if size != required:
                        raise ValueError(f"Incomplete download: {size}/{required} bytes")
            partial.replace(path)
            return h.hexdigest()
        except (httpx.HTTPError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def atomic_json(path, value):
    temporary = path.with_suffix(".json.partial")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def global_dem():
    folder = ROOT / "global"
    image = folder / "ldem_16.img"
    sha = download(GLOBAL_BASE + ".img", image, 5760 * 2880 * 2)
    download(GLOBAL_BASE + ".lbl", folder / "ldem_16.lbl")
    grid = np.memmap(image, dtype="<i2", mode="r", shape=(2880, 5760))
    record = {
        "key": "lola-global-16ppd", "file": "global/ldem_16.img", "width": 5760, "height": 2880,
        "pixels_per_degree": 16, "scale": 0.5, "sha256": sha,
        "min_elevation_m": float(grid.min()) * 0.5, "max_elevation_m": float(grid.max()) * 0.5,
        "source": GLOBAL_BASE + ".img", "frame": "MOON_ME", "ephemeris": "DE421",
    }
    with Session(engine) as session:
        row = session.exec(select(TerrainDataset).where(TerrainDataset.catalog_key == record["key"])).first()
        if row is None:
            row = TerrainDataset(catalog_key=record["key"], name="LRO LOLA global terrain (16 pixels/degree)")
        row.product = "LDEM_16 V3.1"
        row.file_uri = record["source"]
        row.crs = "+proj=longlat +a=1737400 +b=1737400 +no_defs"
        row.resolution_m = 1895.21
        row.source = GLOBAL_BASE + ".lbl"
        row.retrieved_at = datetime.now(timezone.utc)
        row.license = "NASA PDS LRO LOLA; credit NASA/GSFC/MIT and the LOLA team."
        row.notes = "Global coarse baseline. Heights are DN * 0.5 m above the 1,737,400 m lunar reference sphere."
        row.provenance = {**record, "storage_status": "downloaded", "terrain_ready": True}
        session.add(row); session.commit()
    print("Global LOLA baseline downloaded", flush=True)
    return record


def region_dem(dataset_id):
    with Session(engine) as session:
        row = session.get(TerrainDataset, dataset_id)
        p = row.provenance
        # Downloads can take minutes. Release the DB transaction while doing I/O
        # so hosted Postgres idle-in-transaction limits cannot abort the import.
        session.expunge(row)
        session.rollback()
        region = p["region_id"]
        if not region.isalnum():
            raise ValueError("Unexpected region name")
        folder = ROOT / region
        image = folder / "surface.tif"
        expected = int(p["remote_headers"]["content_range"].split("/")[-1])
        sha = download(row.file_uri, image, expected)
        array_path = folder / "surface.npy"
        info_path = folder / "surface.json"
        if info_path.is_file() and array_path.is_file():
            info = json.loads(info_path.read_text(encoding="utf-8"))
            if info.get("sha256") != sha:
                info = None
        else:
            info = None
        if info is None:
            with rasterio.open(image) as source:
                if source.count != 1 or source.res != (5, 5):
                    raise ValueError(f"Unexpected raster layout: {region}")
                grid = source.read(1).astype("<f4")
                valid = np.isfinite(grid)
                if source.nodata is not None and np.isfinite(source.nodata):
                    grid[grid == source.nodata] = np.nan
                    valid = np.isfinite(grid)
                if not valid.any():
                    raise ValueError(f"No valid elevations: {region}")
                t = source.transform
                if t.b or t.d or t.a != 5 or t.e != -5:
                    raise ValueError("Unsupported affine transform")
                left, bottom, right, top = source.bounds
                x, y = (left + right) / 2, (bottom + top) / 2
                latitude = np.degrees(2 * np.arctan(np.hypot(x, y) / (2 * 1737400)) - np.pi / 2)
                longitude = np.degrees(np.arctan2(x, y))
                center_height = float(grid[source.height // 2, source.width // 2])
                if not np.isfinite(center_height):
                    center_height = float(np.nanmedian(grid))
                info = {
                    "id": row.id, "catalog_key": row.catalog_key, "region_id": region,
                    "name": p["region_name"], "file": f"{region}/surface.npy", "original": f"{region}/surface.tif",
                    "width": source.width, "height": source.height, "resolution_m": 5,
                    "bounds_xy_m": [left, bottom, right, top], "pixel_center_origin_xy_m": [t.c + t.a/2, t.f + t.e/2],
                    "center": {"latitude": float(latitude), "longitude": float(longitude), "elevation": center_height},
                    "min_elevation_m": float(grid[valid].min()), "max_elevation_m": float(grid[valid].max()),
                    "sha256": sha, "size_bytes": image.stat().st_size,
                    "frame": "MOON_ME", "ephemeris": "DE421", "source": row.file_uri,
                }
                temporary = array_path.with_suffix(".npy.partial")
                with temporary.open("wb") as file:
                    np.save(file, grid, allow_pickle=False)
                temporary.replace(array_path)
                atomic_json(info_path, info)
        row.provenance = {**p, "storage_status": "downloaded", "terrain_ready": True,
                          "local": info, "downloaded_at": datetime.now(timezone.utc).isoformat()}
        session.add(row); session.commit()
        print(f"{region}: downloaded and prepared ({image.stat().st_size / 1e6:.1f} MB)", flush=True)
        return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=3, choices=range(1, 5))
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    baseline = global_dem()
    with Session(engine) as session:
        ids = session.exec(select(TerrainDataset.id).where(TerrainDataset.catalog_key.startswith("pgda-78:"))).all()
    if len(ids) != 27:
        raise RuntimeError("Apply the PGDA 78 migration before downloading; expected 27 regions")
    regions = []
    failures = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks = {pool.submit(region_dem, dataset_id): dataset_id for dataset_id in ids}
        for task in as_completed(tasks):
            try:
                regions.append(task.result())
            except Exception as exc:
                failures.append(tasks[task]); print(f"Dataset {tasks[task]} failed: {exc}", flush=True)
    regions.sort(key=lambda value: value["region_id"])
    version = hashlib.sha256("".join([baseline["sha256"], *(r["sha256"] for r in regions)]).encode()).hexdigest()[:16]
    atomic_json(ROOT / "manifest.json", {
        "version": version, "reference_radius_m": 1737400, "tile_size": 65,
        "baseline": baseline, "regions": regions, "created_at": datetime.now(timezone.utc).isoformat(),
        "citation": "Barker et al. (2021), doi:10.1016/j.pss.2020.105119; NASA PDS LRO LOLA global LDEM_16",
    })
    print(f"Terrain manifest ready: {len(regions)}/27 regions, version {version}", flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
