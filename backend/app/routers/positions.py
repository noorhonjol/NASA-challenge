from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

from ..horizons import HorizonsError, positions

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
