"""Live, airless observer positions; no stored ephemeris samples."""
import csv
import math
from datetime import datetime, timedelta, timezone

import httpx

URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
AU_KM = 149597870.7
MONTHS = {name: number for number, name in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), start=1)}


class HorizonsError(Exception):
    pass


def _params(lat: float, lon: float, height_m: float) -> dict:
    """Observer-table parameters shared by single-epoch and series requests."""
    return {
        "format": "json", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{lon},{lat},{height_m / 1000}'",
        "TIME_TYPE": "'UT'", "TIME_DIGITS": "'SECONDS'", "QUANTITIES": "'4,20'", "CAL_TYPE": "'GREGORIAN'",
        "APPARENT": "'AIRLESS'", "CSV_FORMAT": "'YES'", "EXTRA_PREC": "'YES'",
    }


def _rows(result: str) -> list[list[str]]:
    """CSV rows between $$SOE and $$EOE; raises IndexError when the markers are missing."""
    block = result.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    return list(csv.reader(line for line in block.splitlines() if line.strip()))


def _angles(row: list[str]) -> tuple[float, float]:
    # Quantity 4 CSV: calendar date, solar presence, lunar presence, azimuth, elevation.
    azimuth, elevation = map(float, row[3:5])
    if not all(map(math.isfinite, (azimuth, elevation))) or not (0 <= azimuth <= 360 and -90 <= elevation <= 90):
        raise ValueError("Invalid angles")
    return azimuth, elevation


def _range_km(row: list[str]) -> float:
    distance_au = float(row[5])
    if not math.isfinite(distance_au) or distance_au <= 0:
        raise ValueError("Invalid range")
    return distance_au * AU_KM


def _epoch(text: str) -> datetime:
    """'2026-Nov-14 12:00', '...12:00:00' or '...12:00:00.000' as UTC; month names mapped without locale.
    Horizons omits the seconds when the series starts off the hour, even with TIME_DIGITS='SECONDS'."""
    day, clock = text.strip().split()
    year, month, date = day.split("-")
    whole, _, fraction = clock.partition(".")
    parts = whole.split(":")
    if len(parts) == 2:
        parts.append("0")
    hour, minute, second = map(int, parts)
    micro = round(float(f"0.{fraction}") * 1e6) if fraction else 0
    return datetime(int(year), MONTHS[month], int(date), hour, minute, second, tzinfo=timezone.utc) + timedelta(microseconds=micro)


def parse_position(result: str) -> dict:
    try:
        rows = _rows(result)
        if len(rows) != 1:
            raise ValueError("Expected one epoch")
        azimuth, elevation = _angles(rows[0])
        position = {"azimuth_deg": azimuth, "elevation_deg": elevation,
                    "above_horizon": elevation > 0}
        if len(rows[0]) > 6:
            position["distance_km"] = _range_km(rows[0])
        return position
    except (IndexError, ValueError) as exc:
        raise HorizonsError("Horizons returned no usable observer position.") from exc


def parse_series(result: str) -> list[tuple[datetime, float, float, float]]:
    """Rows of (UTC time, azimuth deg, elevation deg, range km); any n.a. or bad value raises."""
    try:
        series = []
        for row in _rows(result):
            azimuth, elevation = _angles(row)
            series.append((_epoch(row[0]), azimuth, elevation, _range_km(row)))
        if not series:
            raise ValueError("No epochs")
        return series
    except (IndexError, KeyError, ValueError) as exc:
        raise HorizonsError("Horizons returned no usable observer series.") from exc


async def _query(client: httpx.AsyncClient, params: dict) -> str:
    try:
        response = await client.get(URL, params=params)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HorizonsError("JPL Horizons is unavailable. Please try again.") from exc
    if payload.get("error"):
        raise HorizonsError("Horizons could not calculate this location and date.")
    return payload.get("result", "")


async def positions(lat: float, lon: float, elevation_m: float, at: datetime) -> dict:
    at = at.astimezone(timezone.utc)
    # Calendar TLIST preserves seconds and requests exactly one UTC epoch.
    common = {**_params(lat, lon, elevation_m),
              "TLIST": f"'{at.strftime('%Y-%m-%d %H:%M:%S')}'", "TLIST_TYPE": "'CAL'"}
    bodies = {}
    # JPL asks clients to serialize requests to its service.
    async with httpx.AsyncClient(timeout=30) as client:
        for name, target in (("sun", "10"), ("earth", "399")):
            bodies[name] = parse_position(await _query(client, {**common, "COMMAND": f"'{target}'"}))
    return {"at_utc": at.isoformat(), "latitude_deg": lat, "longitude_deg": lon,
            "elevation_m": elevation_m, "source": "JPL Horizons", "source_url": URL,
            "horizon_model": "Airless local tangent plane; body centers; no terrain obstruction or horizon dip.",
            **bodies}


async def body_series(target: str, lat: float, lon: float, height_m: float, start: datetime,
                      step_minutes: int, count: int) -> list[tuple[datetime, float, float, float]]:
    """Azimuth/elevation/range of a Horizons body ('10' Sun, '399' Earth) from a lunar site
    at `count` evenly spaced UTC epochs."""
    start = start.astimezone(timezone.utc)
    asked = max(count, 2)          # Horizons needs STOP_TIME after START_TIME
    stop = start + timedelta(minutes=step_minutes * (asked - 1))
    params = {**_params(lat, lon, height_m), "COMMAND": f"'{target}'",
              "START_TIME": f"'{start.strftime('%Y-%m-%d %H:%M:%S')}'",
              "STOP_TIME": f"'{stop.strftime('%Y-%m-%d %H:%M:%S')}'",
              "STEP_SIZE": f"'{step_minutes} m'"}
    async with httpx.AsyncClient(timeout=60) as client:
        series = parse_series(await _query(client, params))
    expected = [start + timedelta(minutes=step_minutes * i) for i in range(asked)]
    if len(series) != asked or any(abs((row[0] - t).total_seconds()) > 1 for row, t in zip(series, expected)):
        raise HorizonsError("Horizons returned an unexpected set of epochs.")
    return series[:count]


async def earth_series(lat: float, lon: float, height_m: float, start: datetime,
                       step_minutes: int, count: int) -> list[tuple[datetime, float, float, float]]:
    """Earth (399) azimuth/elevation/range from a lunar site at `count` evenly spaced UTC epochs."""
    return await body_series("399", lat, lon, height_m, start, step_minutes, count)
