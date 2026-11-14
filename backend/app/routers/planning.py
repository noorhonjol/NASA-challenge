from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from ..horizons import HorizonsError
from ..planning import AnalysisRequest, PowerRequest, WindowRequest, Range, analyze, metadata
from datetime import timedelta

router = APIRouter(prefix="/api/planning", tags=["planning"])


@router.post("/analysis")
async def area_analysis(request: AnalysisRequest):
    try:
        results = []
        for point in request.locations():
            results.append(await analyze(point, request.epochs(), request.equipment))
        return {**metadata(request.equipment), "results": results}
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/power")
async def mission_power(request: PowerRequest):
    try:
        span = Range(start=request.at, end=request.at+timedelta(hours=request.duration_hours), step_hours=request.step_hours)
    except (ValidationError, OverflowError) as exc:
        raise HTTPException(422, "Use timezone-aware supported dates and at most 128 epochs over 366 days.") from exc
    try:
        return {**metadata(request.equipment), **await analyze(request.point, span.epochs(), request.equipment)}
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/windows")
async def equipment_windows(request: WindowRequest):
    try:
        result = await analyze(request.point, request.epochs(), request.equipment)
        result["operating_windows"] = [w for w in result["operating_windows"] if w["duration_hours"] >= request.minimum_duration_hours]
        return {**metadata(request.equipment), **result}
    except HorizonsError as exc:
        raise HTTPException(502, str(exc)) from exc
