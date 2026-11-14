"""Bounded, database-independent lunar power screening using live ephemerides."""
import math
from datetime import datetime, timedelta
from typing import Literal

from starlette.concurrency import run_in_threadpool

from .terrain import surface_elevation
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .horizons import positions


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Point(Input):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class Grid(Input):
    south: float = Field(ge=-90, le=90)
    north: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    east: float = Field(ge=-180, le=180)
    rows: int = Field(default=2, ge=2, le=8)
    columns: int = Field(default=2, ge=2, le=8)

    @model_validator(mode="after")
    def ordered(self):
        if self.south >= self.north or self.west >= self.east:
            raise ValueError("Grid bounds must increase; split areas crossing the antimeridian.")
        return self

    def points(self):
        return [Point(lat=self.south + r * (self.north-self.south)/(self.rows-1),
                      lon=self.west + c * (self.east-self.west)/(self.columns-1))
                for r in range(self.rows) for c in range(self.columns)]


class Equipment(Input):
    load_w: float = Field(gt=0, le=1e7)
    panel_area_m2: float = Field(gt=0, le=1e6)
    panel_efficiency: float = Field(default=0.3, gt=0, le=1)
    system_efficiency: float = Field(default=0.85, gt=0, le=1)
    panel_mode: Literal["horizontal", "sun_tracking"] = "horizontal"
    battery_wh: float = Field(default=0, ge=0, le=1e12)
    usable_battery_fraction: float = Field(default=0.8, gt=0, le=1)
    minimum_earth_elevation_deg: float = Field(default=0, ge=0, le=90)
    require_earth_visibility: bool = True


def valid_date(at):
    if at.tzinfo is None or at.utcoffset() is None or not 1550 <= at.year <= 2649:
        raise ValueError("Use timezone-aware dates between 1550 and 2649.")


class Range(Input):
    start: datetime
    end: datetime
    step_hours: float = Field(default=6, ge=0.25, le=168)

    @model_validator(mode="after")
    def check_range(self):
        valid_date(self.start)
        valid_date(self.end)
        if self.end <= self.start or self.end-self.start > timedelta(days=366):
            raise ValueError("End must follow start, with a maximum range of 366 days.")
        if math.ceil((self.end-self.start).total_seconds()/(self.step_hours*3600))+1 > 128:
            raise ValueError("Maximum 128 epochs; increase step_hours or shorten the range.")
        return self

    def epochs(self):
        count = math.ceil((self.end-self.start).total_seconds()/(self.step_hours*3600))
        return [min(self.start + timedelta(hours=i*self.step_hours), self.end) for i in range(count+1)]


class AnalysisRequest(Range):
    points: list[Point] | None = Field(default=None, min_length=1, max_length=64)
    grid: Grid | None = None
    equipment: Equipment

    @model_validator(mode="after")
    def check_work(self):
        if (self.points is None) == (self.grid is None):
            raise ValueError("Supply exactly one of points or grid.")
        if len(self.locations()) * len(self.epochs()) > 128:
            raise ValueError("Maximum 128 point/epoch combinations per request.")
        return self

    def locations(self):
        return self.points if self.points is not None else self.grid.points()


class PowerRequest(Input):
    point: Point
    at: datetime
    duration_hours: float = Field(default=24, gt=0, le=8784)
    step_hours: float = Field(default=6, ge=0.25, le=168)
    equipment: Equipment


class WindowRequest(Range):
    point: Point
    equipment: Equipment
    minimum_duration_hours: float = Field(default=1, gt=0, le=8784)


ASSUMPTIONS = [
    "Screening estimate, not mission certification. Airless tangent-plane body-center horizon; no terrain shadows, horizon dip or eclipses.",
    "Observer elevations sampled from local LOLA: native product 81 within coverage, global LOLA elsewhere; terrain obstruction is still excluded.",
    "1361 W/m2 at 1 AU, scaled by Horizons Sun range; horizontal or ideal Sun-tracking panels.",
    "Load is constant and user supplied: include heaters, instruments and communications. No thermal model or communication link budget.",
    "Energy uses trapezoidal integration between samples. Battery is ideal within the specified usable fraction; no charge-rate model.",
    "Windows require instantaneous solar power to meet load and optional Earth visibility at both sample endpoints. Transitions are unresolved between samples; batteries do not extend these windows.",
]


def sample_power(position, equipment):
    sun = position["sun"]
    distance = sun.get("distance_km")
    if distance is None or not math.isfinite(distance) or distance <= 0:
        from .horizons import HorizonsError
        raise HorizonsError("Horizons returned no usable Sun range for power estimation.")
    irradiance = 1361 * (149597870.7 / distance)**2
    factor = (1 if equipment.panel_mode == "sun_tracking" else math.sin(math.radians(sun["elevation_deg"]))) if sun["elevation_deg"] > 0 else 0
    panel_flux = irradiance * factor
    yield_per_m2 = panel_flux * equipment.panel_efficiency * equipment.system_efficiency
    generated = yield_per_m2 * equipment.panel_area_m2
    earth_visible = position["earth"]["elevation_deg"] > equipment.minimum_earth_elevation_deg
    return {**position, "solar_irradiance_normal_w_m2": irradiance,
            "panel_irradiance_w_m2": panel_flux, "generated_power_w": generated,
            "load_w": equipment.load_w, "net_power_w": generated-equipment.load_w,
            "required_panel_area_m2": equipment.load_w/yield_per_m2 if yield_per_m2 > 0 else None,
            "earth_visible": earth_visible,
            "meets_operating_constraints": generated >= equipment.load_w and (earth_visible or not equipment.require_earth_visibility)}


async def analyze(point, epochs, equipment):
    elevation = await run_in_threadpool(surface_elevation, point.lat, point.lon)
    samples = []
    for at in epochs:
        samples.append(sample_power(await positions(point.lat, point.lon, elevation["elevation_m"], at), equipment))
    generated_wh = cumulative = peak = drawdown = initial = 0.0
    windows = []
    for i, (a, b) in enumerate(zip(samples, samples[1:])):
        hours = (epochs[i+1]-epochs[i]).total_seconds()/3600
        energy = (a["generated_power_w"]+b["generated_power_w"])*hours/2
        generated_wh += energy
        net_a, net_b = a["net_power_w"], b["net_power_w"]
        # Include an interior extremum when interpolated generation crosses load.
        fractions = [0.0, 1.0]
        if net_a * net_b < 0:
            fractions.insert(1, -net_a / (net_b-net_a))
        for left, right in zip(fractions, fractions[1:]):
            left_net = net_a + (net_b-net_a)*left
            right_net = net_a + (net_b-net_a)*right
            cumulative += (left_net+right_net)*hours*(right-left)/2
            initial = max(initial, -cumulative)
            peak = max(peak, cumulative)
            drawdown = max(drawdown, peak-cumulative)
        if a["meets_operating_constraints"] and b["meets_operating_constraints"]:
            if windows and windows[-1]["end"] == a["at_utc"]:
                windows[-1]["end"] = b["at_utc"]
                windows[-1]["duration_hours"] += hours
            else:
                windows.append({"start": a["at_utc"], "end": b["at_utc"], "duration_hours": hours})
    duration = (epochs[-1]-epochs[0]).total_seconds()/3600
    return {"point": {**point.model_dump(), "elevation_m": elevation["elevation_m"]}, "elevation": elevation, "samples": samples, "operating_windows": windows,
            "summary": {"duration_hours": duration, "generated_energy_wh": generated_wh,
                        "load_energy_wh": equipment.load_w*duration,
                        "net_energy_wh": cumulative,
                        "minimum_initial_usable_energy_wh": initial,
                        "minimum_usable_storage_wh": drawdown,
                        "minimum_nameplate_battery_wh": drawdown/equipment.usable_battery_fraction,
                        "battery_sufficient_if_initially_full": equipment.battery_wh*equipment.usable_battery_fraction >= drawdown}}


def metadata(equipment):
    return {"source": "JPL Horizons", "solar_reference_url": "https://data.giss.nasa.gov/modelforce/solar.irradiance/",
            "equipment": equipment.model_dump(), "assumptions": ASSUMPTIONS}
