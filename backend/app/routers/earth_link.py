import math
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from .. import earth_link
from ..horizons import HorizonsError, earth_series

router = APIRouter(prefix="/api/earth-link", tags=["communications"])

MAX_SAMPLES = 20000
MAX_SPAN = timedelta(days=366)
LAT_LIMIT = 89.9999   # azimuth is undefined at the exact pole


def _utc(value: datetime, name: str) -> datetime:
    if value.tzinfo is None:
        raise HTTPException(422, f"Use a timezone-aware {name} (e.g. 2026-11-15T00:00:00Z).")
    # Horizons epochs are whole seconds.
    return value.astimezone(timezone.utc).replace(microsecond=0)


@router.get("")
async def get_earth_link(
    start: datetime,
    end: datetime,
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    step_minutes: int = Query(default=30, ge=1, le=1440),
    altitude_m: float = Query(default=2, ge=0, le=100000),
    altitude_reference: Literal["ground", "sphere"] = "ground",
    min_clearance_deg: float = Query(default=0, ge=-1, le=10),
    min_window_minutes: float = Query(default=0, ge=0, le=366 * 1440),
    min_availability_fraction: float | None = Query(default=None, ge=0, le=1),
    max_blackout_hours: float | None = Query(default=None, ge=0, le=366 * 24),
    max_first_contact_hours: float | None = Query(default=None, ge=0, le=366 * 24),
    include_samples: bool = False,
    include_skyline: bool = False,
):
    start, end = _utc(start, "start"), _utc(end, "end")
    if end <= start:
        raise HTTPException(422, "end must be after start.")
    if end - start > MAX_SPAN:
        raise HTTPException(422, "The period can be at most 366 days.")
    span_minutes = (end - start).total_seconds() / 60
    count = math.ceil(span_minutes / step_minutes) + 1          # last sample reaches or passes end
    if count > MAX_SAMPLES:
        suggested = math.ceil(span_minutes / (MAX_SAMPLES - 1))
        raise HTTPException(422, f"{count} samples requested; the limit is {MAX_SAMPLES}. "
                                 f"Use step_minutes >= {suggested}.")
    stop = start + timedelta(minutes=step_minutes * (count - 1))
    if not (1550 <= start.year and stop.year <= 2649):
        raise HTTPException(422, "Dates must fall between 1550 and 2649.")

    effective_lat = min(max(lat, -LAT_LIMIT), LAT_LIMIT)
    try:
        obs = await run_in_threadpool(earth_link.observer, effective_lat, lon, altitude_m, altitude_reference)
    except earth_link.BelowGround as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        series = await earth_series(effective_lat, lon, obs.height_m, start, step_minutes, count)
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc
    criteria = {"min_window_minutes": min_window_minutes,
                "min_availability_fraction": min_availability_fraction,
                "max_blackout_hours": max_blackout_hours,
                "max_first_contact_hours": max_first_contact_hours}
    result = await run_in_threadpool(
        earth_link.compute, obs, series, start, end, step_minutes,
        min_clearance_deg, criteria, include_samples, include_skyline)
    result["location"]["requested_latitude_deg"] = lat
    if effective_lat != lat:
        result["warnings"].insert(0, f"Latitude {lat} was moved to {effective_lat} because azimuth is "
                                     "undefined at the exact pole.")
    return result
