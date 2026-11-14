"""Freeze PGDA 78 raster centers as navigation landmarks, using mosaic 81 heights.

These centers identify named regions, not surveyed spacecraft landing points.
The original regional rasters are not needed or downloaded.
"""
import json
import math
from pathlib import Path

import rasterio

root = Path(__file__).resolve().parents[2]
catalog = (root / "db/migration/V3__register_pgda78_terrain_catalog.sql").read_text()
records = json.loads(catalog.split("$pgda78$")[1])
rows = []
with rasterio.open(root / "backend/data/terrain/Mosaic81/surface.tif") as mosaic:
    for record in records:
        meta = record["provenance"]
        west, south, east, north = meta["geotiff"]["bounds_xy_m"]
        x, y = (west + east) / 2, (south + north) / 2
        latitude = math.degrees(2 * math.atan(math.hypot(x, y) / (2 * 1737400)) - math.pi / 2)
        longitude = math.degrees(math.atan2(x, y))
        height = None
        if latitude <= -87:
            value = next(mosaic.sample([(x, y)], masked=True))[0]
            if not getattr(value, "mask", False) and math.isfinite(float(value)):
                height = round(float(value), 3)
        rows.append({
            "slug": "pgda-78-" + meta["region_id"].lower(),
            "name": meta["region_id"] + " · " + meta["region_name"],
            "lat_deg": latitude, "lon_deg": longitude, "elevation_m": height,
            "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. "
                "Names and bounds: https://pgda.gsfc.nasa.gov/products/78. "
                + ("Elevation sampled from the installed PGDA 81 5 m mosaic." if height is not None else "Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."),
        })
sql = """-- Named PGDA 78 region centers used as pins over the continuous PGDA 81 terrain.
-- Coordinates are derived from original projected raster bounds, MOON_ME/DE421.
-- No product 78 terrain datasets or raster downloads are reintroduced.
INSERT INTO sites (slug, name, lat_deg, lon_deg, elevation_m, frame, is_fictional, notes)
SELECT item->>'slug', item->>'name', (item->>'lat_deg')::double precision,
       (item->>'lon_deg')::double precision, (item->>'elevation_m')::double precision,
       'MOON_ME', false, item->>'notes'
FROM jsonb_array_elements($landmarks$""" + json.dumps(rows, indent=2, ensure_ascii=False) + """$landmarks$::jsonb) AS item
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lat_deg = EXCLUDED.lat_deg,
    lon_deg = EXCLUDED.lon_deg, elevation_m = EXCLUDED.elevation_m,
    frame = EXCLUDED.frame, is_fictional = false, notes = EXCLUDED.notes;
"""
(root / "db/migration/V6__add_named_lola_navigation_sites.sql").write_text(sql, encoding="utf-8")
print(f"Registered {len(rows)} landmarks; {sum(r['elevation_m'] is not None for r in rows)} inside mosaic coverage")
