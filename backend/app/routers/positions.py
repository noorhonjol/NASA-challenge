from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from ..horizons import HorizonsError, body_series, positions

router = APIRouter(prefix="/api/positions", tags=["positions"])


@router.get("")
async def get_positions(
    at: datetime,
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    elevation_m: float = Query(default=0, ge=-20000, le=20000),
):
    if at.tzinfo is None or not 1550 <= at.year <= 2649:
        raise HTTPException(422, "Use a timezone-aware date between 1550 and 2649.")
    try:
        return await positions(lat, lon, elevation_m, at)
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc


MAX_TRACK_SAMPLES = 3000


@router.get("/track")
async def get_track(
    start: datetime,
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    elevation_m: float = Query(default=0, ge=-20000, le=20000),
    days: float = Query(default=30, gt=0, le=60),
    step_minutes: int = Query(default=30, ge=5, le=1440),
):
    """Sun and Earth azimuth/elevation/range from a lunar site every `step_minutes` for `days`,
    for a time slider: one Horizons series per body (asked one after the other)."""
    if start.tzinfo is None:
        raise HTTPException(422, "Use a timezone-aware start (e.g. 2026-11-15T00:00:00Z).")
    start = start.astimezone(timezone.utc).replace(second=0, microsecond=0)
    count = int(days * 1440 // step_minutes) + 1
    if count > MAX_TRACK_SAMPLES:
        raise HTTPException(422, f"{count} samples requested; the limit is {MAX_TRACK_SAMPLES}. Use a larger step_minutes.")
    stop = start + timedelta(minutes=step_minutes * (count - 1))
    if not (1550 <= start.year and stop.year <= 2649):
        raise HTTPException(422, "Dates must fall between 1550 and 2649.")
    site_lat = min(max(lat, -89.9999), 89.9999)       # azimuth is undefined at the exact pole
    try:
        sun = await body_series("10", site_lat, lon, elevation_m, start, step_minutes, count)
        earth = await body_series("399", site_lat, lon, elevation_m, start, step_minutes, count)
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc
    def columns(rows):
        return {"azimuth_deg": [round(r[1], 4) for r in rows], "elevation_deg": [round(r[2], 4) for r in rows],
                "distance_km": [round(r[3], 1) for r in rows]}
    return {"latitude_deg": lat, "longitude_deg": lon, "elevation_m": elevation_m,
            "start_utc": start.isoformat().replace("+00:00", "Z"), "step_minutes": step_minutes, "count": count,
            "sun": columns(sun), "earth": columns(earth),
            "source": "JPL Horizons", "source_url": "https://ssd.jpl.nasa.gov/api/horizons.api"}
