"""Sunlight, irradiance, surface temperature and site judging (merged from the lunar_sun prototype)."""
from datetime import datetime, timedelta, timezone
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, model_validator

from .. import sun_analysis as sa
from ..horizon_profile import RADIUS_M
from ..horizons import URL, HorizonsError, body_series
from ..sun import body_positions, prepare_sites, reference_site
from .earth_link import _utc

router = APIRouter(prefix="/api/sun", tags=["sunlight"])

FINE_SKYLINE_MAX_POINTS = 25     # up to this many points get a 1 deg skyline, more get 5 deg


class Region(BaseModel):
    lat_min: float = Field(ge=-90, le=90)
    lat_max: float = Field(ge=-90, le=90)
    lon_min: float = Field(ge=-360, le=360)
    lon_max: float = Field(ge=-360, le=360)
    n_lat: int = Field(10, ge=1, le=60)
    n_lon: int = Field(10, ge=1, le=60)


class Area(BaseModel):
    region: Region | None = None
    points: list[tuple[float, float]] | None = Field(None, description="[[lat, lon], ...]")
    start: datetime
    stop: datetime
    step_min: int = Field(60, ge=5, le=1440)

    @model_validator(mode="after")
    def _check(self):
        if not (self.region or self.points):
            raise ValueError("Give 'region' or 'points'.")
        for lat, lon in self.points or []:
            if not (-90 <= lat <= 90 and -360 <= lon <= 360):
                raise ValueError(f"Point ({lat}, {lon}) is outside latitude -90..90 or longitude -360..360.")
        return self


class Criterion(BaseModel):
    metric: str
    op: Literal[">=", "<=", ">", "<", "==", "between"]
    value: float | tuple[float, float]
    weight: float = Field(1.0, ge=0)
    required: bool = False


Preset = Literal["solar_rover", "lander_survival", "ice_cold_trap", "crewed_landing"]


class HeatRequest(Area):
    thermal_model: bool = True
    grid_series: bool = Field(True, description="include [time][lat][lon] cubes")
    earth: bool = Field(False, description="add Earth-visibility statistics per point")
    format: Literal["json", "csv"] = "json"
    preset: Preset | None = Field(None, description="optional: also score the points (adds 'judge')")
    criteria: list[Criterion] = []


class JudgeRequest(Area):
    preset: Preset | None = None
    criteria: list[Criterion] = []
    top_n: int = Field(10, ge=1, le=sa.MAX_POINTS)


def _years(first: datetime, last: datetime):
    if not (1550 <= first.year and last.year <= 2649):
        raise HTTPException(422, "Dates (including one month of heat-model spin-up) must fall between 1550 and 2649.")


async def _track(target: str, sites, times, step_min):
    """Body positions (T, 3) km from one Horizons series at the reference site."""
    ref_lat, ref_lon = reference_site(sites.lat, sites.lon)
    try:
        series = await body_series(target, ref_lat, ref_lon, 0.0, times[0], step_min, len(times))
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc
    source = {"name": "JPL Horizons", "url": URL, "quantities": "4,20 airless apparent",
              "reference_site": {"lat": round(ref_lat, 6), "lon": round(ref_lon, 6)}}
    return body_positions(ref_lat, ref_lon, RADIUS_M, series), source


@router.get("/point", summary="Sun state, irradiance and decisions for one point and time")
async def sun_point(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    time: datetime | None = None,
    power_threshold_wm2: float = Query(50.0, ge=0),
    events: bool = True,
    temperature: bool = False,
):
    t = _utc(time, "time") if time else datetime.now(timezone.utc).replace(microsecond=0)
    step = sa.EVENT_STEP_MIN
    n_spin = sa.spinup_steps(step) if temperature else 0
    start = t - timedelta(minutes=step * n_spin)
    stop = t + timedelta(days=sa.EVENT_DAYS) if events else t
    _years(start, stop)
    times = sa.time_grid(start, stop, step)
    sites = await run_in_threadpool(prepare_sites, [lat], [lon], 1.0)
    sun_km, source = await _track("10", sites, times, step)
    return await run_in_threadpool(sa.point_report, sites, times, sun_km, n_spin, source,
                                   power_threshold_wm2, events, temperature, step)


def _points(req: Area):
    if req.points:
        p = np.asarray(req.points, float)
        return p[:, 0], p[:, 1], None
    r = req.region
    la = np.linspace(r.lat_min, r.lat_max, r.n_lat)
    lo = np.linspace(r.lon_min, r.lon_max, r.n_lon)
    LA, LO = np.meshgrid(la, lo, indexing="ij")
    return LA.ravel(), LO.ravel(), (la, lo)


async def _region(req: Area, thermal_model: bool, grid_series: bool, earth: bool) -> dict:
    start, stop = _utc(req.start, "start"), _utc(req.stop, "stop")
    if stop < start:
        raise HTTPException(422, "stop must not be before start.")
    lat, lon, axes = _points(req)
    if len(lat) > sa.MAX_POINTS:
        raise HTTPException(422, f"Too many points ({len(lat)}); the limit is {sa.MAX_POINTS}.")
    n_spin = sa.spinup_steps(req.step_min) if thermal_model else 0
    first = start - timedelta(minutes=req.step_min * n_spin)
    _years(first, stop)
    times = sa.time_grid(first, stop, req.step_min)
    if len(times) > sa.MAX_STEPS:
        raise HTTPException(422, f"{len(times)} time steps (including {n_spin} for heat-model spin-up); "
                                 f"the limit is {sa.MAX_STEPS}. Increase step_min.")
    if len(times) * len(lat) > sa.MAX_CELLS:
        raise HTTPException(422, f"{len(lat)} points x {len(times)} time steps is too large "
                                 f"(limit {sa.MAX_CELLS:,}). Use fewer points or a larger step_min.")
    step_deg = 1.0 if len(lat) <= FINE_SKYLINE_MAX_POINTS else 5.0
    sites = await run_in_threadpool(prepare_sites, lat, lon, step_deg)
    sun_km, source = await _track("10", sites, times, req.step_min)
    earth_km = None
    if earth:   # JPL asks clients to serialize requests, so the two queries run one after the other
        earth_km, _ = await _track("399", sites, times, req.step_min)
    return await run_in_threadpool(sa.region_series, sites, times, sun_km, n_spin, req.step_min, source,
                                   thermal_model, grid_series, axes, earth_km)


def _criteria(req) -> tuple[list[dict], bool, bool]:
    """Preset plus custom criteria, checked; returns (criteria, temperature needed, Earth needed)."""
    criteria = (sa.PRESETS[req.preset] if req.preset else []) + [c.model_dump() for c in req.criteria]
    for c in criteria:
        if c["op"] == "between" and not isinstance(c["value"], (list, tuple)):
            raise HTTPException(422, f"'between' needs a [low, high] value for {c['metric']}.")
        if c["op"] != "between" and isinstance(c["value"], (list, tuple)):
            raise HTTPException(422, f"Only 'between' takes a [low, high] value ({c['metric']}).")
    try:
        need_temp, need_earth = sa.needs(criteria)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return criteria, need_temp, need_earth


@router.post("/region", summary="Sunlight, irradiance and temperature series for an area or points")
async def sun_region(req: HeatRequest):
    criteria, need_temp, need_earth = _criteria(req)
    res = await _region(req, req.thermal_model or need_temp, req.grid_series and req.format == "json",
                        req.earth or need_earth)
    if req.format == "csv":
        return PlainTextResponse(sa.to_csv(res), media_type="text/csv")
    res.pop("_raw")
    if criteria:
        scored = sa.judge(criteria, res, sa.MAX_POINTS)
        res["judge"] = {"criteria": criteria, "summary": scored["summary"], "ranking": scored["ranking"]}
    return res


@router.post("/judge", summary="Score points or an area against mission criteria")
async def sun_judge(req: JudgeRequest):
    criteria, need_temp, need_earth = _criteria(req)
    if not criteria:
        raise HTTPException(422, "Give 'criteria' or 'preset'.")
    res = await _region(req, need_temp, False, need_earth)
    return sa.judge(criteria, res, req.top_n)


@router.get("/metrics", summary="Metrics usable in judge criteria, and the presets")
def sun_metrics():
    return {"metrics": sa.METRICS, "temperature_metrics": sa.TEMP_METRICS,
            "earth_metrics": sa.EARTH_METRICS, "presets": sa.PRESETS}
