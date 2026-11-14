from datetime import datetime
import time as clock
import uuid
from contextvars import ContextVar

import logging
from fastapi import APIRouter, Request, Query
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from ..energy_v1.errors import EnergyError
from ..energy_v1.schemas import (
    Location,
    Region,
    Mission,
    Windows,
    epoch,
    PointOut,
    RegionOut,
    MissionOut,
    WindowsOut,
)
from ..energy_v1 import solar, power
from ..energy_v1.region import region
from threading import BoundedSemaphore

REQUEST_ID = ContextVar("energy_request_id", default="")
WORKERS = BoundedSemaphore(2)


def calculate(function, *args):
    with WORKERS:
        return function(*args)


class EnergyRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request: Request):
            started = clock.perf_counter()
            request_id = uuid.uuid4().hex
            REQUEST_ID.set(request_id)
            try:
                response = await handler(request)
                response.headers["X-Request-ID"] = request_id
                return response
            except EnergyError as exc:
                status, code, message, field = (
                    exc.status,
                    exc.code,
                    exc.message,
                    exc.field,
                )
            except (RequestValidationError, ValidationError) as exc:
                error = exc.errors()[0]
                loc = [str(v) for v in error["loc"] if v not in ("body", "query")]
                field = ".".join(loc)
                message = error["msg"]
                code = (
                    "INVALID_TIME_RANGE"
                    if (
                        error["type"] != "missing"
                        and field.split(".")[-1] in ("start", "end", "time")
                    )
                    or any(
                        k in message.lower()
                        for k in ("epoch", "timestamp", "end must", "mission start")
                    )
                    else "INVALID_PARAMETER"
                )
                status = 400
            except Exception:
                logging.exception("Energy request %s failed", request_id)
                status, code, message, field = (
                    500,
                    "INTERNAL_ERROR",
                    "Unexpected calculation failure",
                    None,
                )
            return JSONResponse(
                status_code=status,
                headers={"X-Request-ID": request_id},
                content={
                    "error": {"code": code, "message": message, "field": field},
                    "meta": {
                        "request_id": request_id,
                        "api_version": "1.0",
                        "dem_product": None,
                        "ephemeris": None,
                        "computed_in_ms": round(
                            (clock.perf_counter() - started) * 1000, 2
                        ),
                    },
                },
            )

        return wrapped


router = APIRouter(prefix="/v1", tags=["Lunar Energy v1"], route_class=EnergyRoute)


def finish(result, started):
    products = result.pop("_products", [])
    result["meta"] = {
        "request_id": REQUEST_ID.get(),
        "api_version": "1.0",
        "dem_product": products[0] if len(products) == 1 else "mixed",
        "dem_products": products,
        "ephemeris": "DE440",
        "frame": "MOON_ME_DE440_ME421",
        "computed_in_ms": round((clock.perf_counter() - started) * 1000, 2),
        "horizon_model": "360 azimuth bins; 5 m near-field to 250 m; 50 m polar overview/global LOLA far-field; curvature-corrected rays to 500 km; interpolated straight-horizon solar disk, diameter 0.53 deg",
        "limitations": [
            "Sampled horizon rays and solar-disk center incidence approximation; narrow ridges/events may be missed",
            "No secondary illumination, eclipses, thermal or radio link-budget model",
            "Interval loads are held; solar power interpolates linearly; usable SOC is 0 at the DoD floor",
            "Round-trip loss split equally between charge and discharge; peak rate unchecked without max_discharge_w",
        ],
    }
    return result


@router.get("/solar/point", response_model=PointOut)
def point(
    lat: float,
    lon: float,
    time: datetime,
    height_m: float = Query(default=0, ge=0, le=50),
    panel_tilt_deg: float | None = Query(default=None, ge=0, le=90),
    panel_azimuth_deg: float | None = Query(default=None, ge=0, lt=360),
):
    started = clock.perf_counter()
    try:
        at = epoch(time)
    except ValueError as exc:
        raise EnergyError("INVALID_TIME_RANGE", str(exc), "time") from exc
    if (panel_tilt_deg is None) != (panel_azimuth_deg is None):
        raise EnergyError(
            "INVALID_PARAMETER",
            "Supply both panel tilt and azimuth",
            "panel_azimuth_deg",
        )
    return finish(
        calculate(
            solar.point,
            Location(lat=lat, lon=lon, height_m=height_m),
            at,
            panel_tilt_deg,
            panel_azimuth_deg,
        ),
        started,
    )


@router.post("/solar/region", response_model=RegionOut)
def solar_region(request: Region):
    started = clock.perf_counter()
    return finish(calculate(region, request), started)


@router.post(
    "/power/mission", response_model=MissionOut, response_model_exclude_unset=True
)
def mission(request: Mission):
    started = clock.perf_counter()
    return finish(calculate(power.mission, request), started)


@router.post(
    "/power/windows", response_model=WindowsOut, response_model_exclude_unset=True
)
def windows(request: Windows):
    started = clock.perf_counter()
    return finish(calculate(power.windows, request), started)
