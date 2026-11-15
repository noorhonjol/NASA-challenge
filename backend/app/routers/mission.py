"""Mission planner: one request covering power, heat and communication for a site or region."""
import json
import math
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, ValidationError, model_validator

from .. import earth_link, mission as ms, sun_analysis as sa
from ..energy_v1.errors import EnergyError
from ..horizon_profile import RADIUS_M
from ..horizons import HorizonsError, body_series, earth_series
from ..sun import body_positions, prepare_sites, reference_site
from .earth_link import _utc

router = APIRouter(prefix="/api/mission", tags=["mission planner"])
REGIONS_FILE = Path(__file__).resolve().parents[1] / "data" / "artemis_iii_regions.json"
MAX_SPAN = timedelta(days=366)


@lru_cache(maxsize=1)
def _regions() -> dict:
    return json.loads(REGIONS_FILE.read_text(encoding="utf-8"))


@router.get("/regions", summary="Known candidate regions (NASA Artemis III, October 2024)")
def known_regions():
    return _regions()


class Where(BaseModel):
    type: Literal["point", "polygon"]
    lat: float | None = Field(None, ge=-90, le=90)
    lon: float | None = Field(None, ge=-180, le=360)
    coordinates: list[tuple[float, float]] | None = Field(None, description="[[lat, lon], ...] polygon vertices")

    @model_validator(mode="after")
    def _check(self):
        if self.type == "point" and (self.lat is None or self.lon is None):
            raise ValueError("A point needs lat and lon.")
        if self.type == "polygon":
            if not self.coordinates or len(self.coordinates) < 3:
                raise ValueError("A polygon needs at least three [lat, lon] vertices.")
            for lat, lon in self.coordinates:
                if not (-90 <= lat <= 90 and -180 <= lon < 360):
                    raise ValueError(f"Vertex ({lat}, {lon}) is outside latitude -90..90 or longitude -180..360.")
        return self


class AnalyzeRequest(BaseModel):
    where: Where
    start: datetime
    end: datetime
    preset: Literal["crewed_landing", "lander_survival", "solar_rover", "ice_cold_trap"] | None = "crewed_landing"


def _fail(exc: EnergyError):
    raise HTTPException(exc.status if exc.status != 400 else 422, exc.message)


async def _sun_track(sites, start, step_min, count):
    ref_lat, ref_lon = reference_site(sites.lat, sites.lon)
    try:
        rows = await body_series("10", ref_lat, ref_lon, 0.0, start, step_min, count)
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc
    return body_positions(ref_lat, ref_lon, RADIUS_M, rows)


@router.post("/analyze", summary="Power, heat and communication for a site or a drawn region")
async def analyze(req: AnalyzeRequest):
    start, end = _utc(req.start, "start"), _utc(req.end, "end")
    if end <= start:
        raise HTTPException(422, "end must be after start.")
    if end - start > MAX_SPAN:
        raise HTTPException(422, "The mission range can be at most 366 days.")
    try:
        power_period = ms.period(start, end)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors()[0]["msg"].removeprefix("Value error, ")) from exc
    days = (end - start).total_seconds() / 86400

    # 1. Cells.
    grid = None
    if req.where.type == "point":
        lat, lon = np.array([req.where.lat]), np.array([(req.where.lon + 180) % 360 - 180])
    else:
        try:
            lat, lon, rows, cols, ri, ci, resolution, projection = await run_in_threadpool(
                ms.polygon_cells, req.where.coordinates, power_period)
        except EnergyError as exc:
            _fail(exc)
        grid = {"rows": int(rows), "cols": int(cols), "resolution_m": resolution, "projection": projection,
                "cell_rows": ri.tolist(), "cell_cols": ci.tolist()}

    # 2. Power and Earth visibility (Lunar Energy v1, offline SPICE).
    times = power_period.times()

    def power_all():
        return [ms.power_metrics(float(a), float(b), times) for a, b in zip(lat, lon)]
    try:
        power = await run_in_threadpool(power_all)
    except EnergyError as exc:
        _fail(exc)

    # 3. Heat (regolith model; Sun from Horizons, spun up over one lunation before start).
    step_min = ms.heat_step_minutes(days)
    first, n_spin = ms.spinup_start(start, step_min)
    heat_times = sa.time_grid(first, end, step_min)
    sites = await run_in_threadpool(prepare_sites, lat, lon, 1.0 if len(lat) <= ms.FINE_SKYLINE_MAX_CELLS else 5.0)
    sun_km = await _sun_track(sites, first, step_min, len(heat_times))
    heat = await run_in_threadpool(ms.heat_stats, sites, heat_times, sun_km, n_spin, step_min)

    # 4. Merge and score.
    criteria = ms.PRESETS[req.preset] if req.preset else []
    cells, judged = ms.combine(power, heat, criteria)
    result = {
        "kind": req.where.type,
        "where": req.where.model_dump(exclude_none=True),
        "period": {"start": start.isoformat(), "end": end.isoformat(), "days": round(days, 3),
                   "power_step_hours": power_period.step_hours, "heat_step_minutes": step_min},
        "preset": req.preset,
        "criteria": criteria,
        "metrics": {k: {"label": v[0], "unit": v[1], "aspect": v[2]} for k, v in ms.METRICS.items()},
        "summary": ms.aspect_summary(cells),
        "cells": cells,
        "grid": grid,
        "ranking": judged["ranking"][:10] if judged else [],
        "pass_count": judged["summary"]["n_pass"] if judged else None,
        "warnings": list(dict.fromkeys(sites.warnings)),
        "limitations": ms.LIMITATIONS,
        "sources": {
            "power": "Lunar Energy v1: SPICE DE440, LOLA terrain (" + ", ".join(sorted({p["_product"] for p in power})) + ")",
            "heat": "1-D regolith model (Hayne et al. 2017); Sun from JPL Horizons; LOLA skyline",
            "communication": "Lunar Energy v1 Earth-center visibility per cell"
            + ("; refined windows from /api/earth-link with a 2 m antenna" if req.where.type == "point" else ""),
        },
    }

    # 5. A single site: heat time series and refined Earth windows.
    if req.where.type == "point":
        ts = heat["region_timeseries"]
        every = max(1, math.ceil(len(heat["times"]) / 400))
        result["series"] = {"times": heat["times"][::every],
                            "surface_temp_K": ts["surface_temp_K"]["mean"][::every],
                            "sun_fraction": ts["sun_fraction"]["mean"][::every]}
        try:
            obs = await run_in_threadpool(earth_link.observer, float(lat[0]), float(lon[0]), 2.0, "ground")
            link_step = 30 if days <= 31 else 120
            count = math.ceil(days * 1440 / link_step) + 1
            track = await earth_series(min(max(float(lat[0]), -89.9999), 89.9999), float(lon[0]), obs.height_m,
                                       start, link_step, count)
            link = await run_in_threadpool(earth_link.compute, obs, track, start, end, link_step)
            result["communication"] = {"summary": link["summary"], "windows": link["windows"][:40],
                                       "terrain_model": link["terrain_model"]["type"], "rf": link["rf"]}
        except HorizonsError as exc:
            result["warnings"].append(f"Refined Earth windows unavailable: {exc}")
    return result
