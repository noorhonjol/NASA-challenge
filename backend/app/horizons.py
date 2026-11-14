"""Live, airless observer positions; no stored ephemeris samples."""
import csv
import math
from datetime import datetime, timezone

import httpx

URL = "https://ssd.jpl.nasa.gov/api/horizons.api"


class HorizonsError(Exception):
    pass


def parse_position(result: str) -> dict:
    try:
        block = result.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
        rows = list(csv.reader(line for line in block.splitlines() if line.strip()))
        if len(rows) != 1:
            raise ValueError("Expected one epoch")
        # Quantity 4 CSV: calendar date, solar presence, lunar presence, azimuth, elevation.
        azimuth, elevation = map(float, rows[0][3:5])
        if not all(map(math.isfinite, (azimuth, elevation))) or not (0 <= azimuth <= 360 and -90 <= elevation <= 90):
            raise ValueError("Invalid angles")
        position = {"azimuth_deg": azimuth, "elevation_deg": elevation,
                    "above_horizon": elevation > 0}
        if len(rows[0]) > 6:
            distance_au = float(rows[0][5])
            if not math.isfinite(distance_au) or distance_au <= 0:
                raise ValueError("Invalid range")
            position["distance_km"] = distance_au * 149597870.7
        return position
    except (IndexError, ValueError) as exc:
        raise HorizonsError("Horizons returned no usable observer position.") from exc


async def positions(lat: float, lon: float, elevation_m: float, at: datetime) -> dict:
    at = at.astimezone(timezone.utc)
    # Calendar TLIST preserves seconds and requests exactly one UTC epoch.
    common = {
        "format": "json", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{lon},{lat},{elevation_m / 1000}'",
        "TLIST": f"'{at.strftime('%Y-%m-%d %H:%M:%S')}'", "TLIST_TYPE": "'CAL'",
        "TIME_TYPE": "'UT'", "TIME_DIGITS": "'SECONDS'", "QUANTITIES": "'4,20'", "CAL_TYPE": "'GREGORIAN'",
        "APPARENT": "'AIRLESS'", "CSV_FORMAT": "'YES'", "EXTRA_PREC": "'YES'",
    }
    bodies = {}
    # JPL asks clients to serialize requests to its service.
    async with httpx.AsyncClient(timeout=30) as client:
        for name, target in (("sun", "10"), ("earth", "399")):
            try:
                response = await client.get(URL, params={**common, "COMMAND": f"'{target}'"})
                response.raise_for_status()
                payload = response.json()
                if payload.get("error"):
                    raise HorizonsError("Horizons could not calculate this location and date.")
                bodies[name] = parse_position(payload.get("result", ""))
            except (httpx.HTTPError, ValueError) as exc:
                raise HorizonsError("JPL Horizons is unavailable. Please try again.") from exc
    return {"at_utc": at.isoformat(), "latitude_deg": lat, "longitude_deg": lon,
            "elevation_m": elevation_m, "source": "JPL Horizons", "source_url": URL,
            "horizon_model": "Airless local tangent plane; body centers; no terrain obstruction or horizon dip.",
            **bodies}
