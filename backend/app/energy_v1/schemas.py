from datetime import datetime, timedelta, timezone
from typing import Literal
import math
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator
from .errors import EnergyError


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def epoch(value):
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Use ISO 8601 timestamps with explicit UTC offset")
    value = value.astimezone(timezone.utc)
    if (
        not datetime(2020, 1, 1, tzinfo=timezone.utc)
        <= value
        < datetime(2036, 1, 1, tzinfo=timezone.utc)
    ):
        raise ValueError("Supported epochs are 2020-01-01 through 2035-12-31 UTC")
    return value


class Location(Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, lt=360)
    height_m: float = Field(default=0, ge=0, le=50)

    @field_validator("lon")
    @classmethod
    def normalize(cls, value):
        return (value + 180) % 360 - 180


class Period(Model):
    start: datetime
    end: datetime
    step_hours: float = Field(default=1, ge=0.25, le=24)

    @model_validator(mode="after")
    def ordered(self):
        self.start, self.end = epoch(self.start), epoch(self.end)
        if self.end <= self.start or self.end - self.start > timedelta(days=731):
            raise ValueError("End must follow start within 731 days (two years)")
        return self

    def times(self):
        count = math.ceil(
            (self.end - self.start).total_seconds() / (3600 * self.step_hours)
        )
        return [
            min(self.start + timedelta(hours=i * self.step_hours), self.end)
            for i in range(count + 1)
        ]


class RegionPeriod(Period):
    step_hours: float = Field(default=6, ge=0.25, le=24)


class Panel(Model):
    mode: Literal[
        "auto", "fixed_horizontal", "fixed_tilt", "vertical_tracking", "full_tracking"
    ] = "auto"
    tilt_deg: float | None = Field(default=None, ge=0, le=90)
    azimuth_deg: float | None = Field(default=None, ge=0, lt=360)
    area_m2: float | None = Field(default=None, gt=0)
    efficiency: float = Field(default=0.3, gt=0, le=1)
    degradation_pct: float = Field(default=0, ge=0, le=50)

    @model_validator(mode="after")
    def fixed(self):
        if self.mode == "fixed_tilt" and (
            self.tilt_deg is None or self.azimuth_deg is None
        ):
            raise ValueError("fixed_tilt requires tilt_deg and azimuth_deg")
        return self


class Assumptions(Model):
    battery_dod: float = Field(default=0.8, gt=0, le=1)
    battery_efficiency: float = Field(default=0.95, gt=0, le=1)
    margin_pct: float = Field(default=20, ge=0, le=200)
    prefer_simple: bool = False
    simplicity_tolerance_pct: float = Field(default=15, ge=0, le=100)
    # Wh capacity cannot imply a discharge rate; optional physical rate limits.
    max_discharge_w: float | None = Field(default=None, gt=0)
    max_charge_w: float | None = Field(default=None, gt=0)


class CustomLoad(Model):
    times: list[datetime] = Field(min_length=2)
    power_w: list[float] = Field(min_length=2)

    @model_validator(mode="after")
    def valid(self):
        self.times = [epoch(t) for t in self.times]
        if len(self.times) != len(self.power_w) or any(
            a >= b for a, b in zip(self.times, self.times[1:])
        ):
            raise ValueError("Custom arrays must align with strictly increasing times")
        if any(not math.isfinite(p) or p < 0 for p in self.power_w):
            raise ValueError("Custom power must be finite and nonnegative")
        return self


class Load(Model):
    profile: Literal["constant", "custom"] = "constant"
    average_w: float | None = Field(default=None, gt=0)
    peak_w: float | None = Field(default=None, gt=0)
    survival_w: float = Field(ge=0)
    custom: CustomLoad | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.profile == "constant" and self.average_w is None:
            raise ValueError("Constant load requires average_w")
        if self.profile == "custom" and self.custom is None:
            raise ValueError("Custom profile requires custom times and power_w")
        operating = (
            self.average_w if self.profile == "constant" else max(self.custom.power_w)
        )
        if self.survival_w > operating:
            raise EnergyError(
                "INFEASIBLE_INPUT",
                "survival_w exceeds operating load",
                "load.survival_w",
                422,
            )
        if self.peak_w is None:
            self.peak_w = operating
        if self.peak_w < operating:
            raise EnergyError(
                "INFEASIBLE_INPUT", "peak_w is below operating load", "load.peak_w", 422
            )
        return self


class Mission(Model):
    location: Location
    start: datetime
    duration_hours: float = Field(gt=0, le=8760)
    step_hours: float = Field(default=1, ge=0.25, le=24)
    load: Load
    panel: Panel = Field(default_factory=Panel)
    assumptions: Assumptions = Field(default_factory=Assumptions)

    @model_validator(mode="after")
    def supported(self):
        self.start = epoch(self.start)
        period = self.period()
        if self.load.custom and (
            self.load.custom.times[0] > period.start
            or self.load.custom.times[-1] < period.end
        ):
            raise ValueError("Custom load must cover mission start through end")
        return self

    def period(self):
        return Period(
            start=self.start,
            end=self.start + timedelta(hours=self.duration_hours),
            step_hours=self.step_hours,
        )


class Equipment(Model):
    name: str | None = Field(default=None, max_length=200)
    panel: Panel
    required_power_w: float = Field(gt=0)
    survival_w: float = Field(default=0, ge=0)
    battery_wh: float = Field(default=0, ge=0)
    max_darkness_hours: float | None = Field(default=None, ge=0)
    min_sun_elevation_deg: float = Field(default=0, ge=-90, le=90)
    needs_earth_visibility: bool = False

    @model_validator(mode="after")
    def valid(self):
        if self.panel.area_m2 is None:
            raise ValueError("Equipment panel area_m2 is required")
        if self.survival_w > self.required_power_w:
            raise EnergyError(
                "INFEASIBLE_INPUT",
                "survival_w exceeds required_power_w",
                "equipment.survival_w",
                422,
            )
        return self


class Criteria(Model):
    min_window_hours: float = Field(default=24, gt=0)
    min_power_margin_pct: float = Field(default=0, ge=0)
    max_results: int = Field(default=10, ge=1, le=100)


class Windows(Model):
    location: Location
    search: Period
    equipment: Equipment
    criteria: Criteria = Field(default_factory=Criteria)
    assumptions: Assumptions = Field(default_factory=Assumptions)


METRICS = {
    "illumination_pct": "%",
    "mean_visible_fraction": "1",
    "mean_irradiance": "W/m2",
    "peak_irradiance": "W/m2",
    "total_energy": "Wh/m2",
    "max_darkness_hours": "h",
    "mean_sun_elevation": "deg",
    "earth_visibility_pct": "%",
    "mean_slope": "deg",
}


class Area(Model):
    type: Literal["bbox", "polygon", "circle"]
    min_lat: float | None = Field(default=None, ge=-90, le=90)
    max_lat: float | None = Field(default=None, ge=-90, le=90)
    min_lon: float | None = Field(default=None, ge=-180, lt=360)
    max_lon: float | None = Field(default=None, ge=-180, lt=360)
    coordinates: list[tuple[float, float]] | None = None
    center: Location | None = None
    radius_m: float | None = Field(default=None, gt=0, le=50000)

    @model_validator(mode="after")
    def shape(self):
        if self.type == "bbox":
            if any(
                v is None
                for v in (self.min_lat, self.max_lat, self.min_lon, self.max_lon)
            ):
                raise ValueError("bbox requires min/max latitude and longitude")
            if self.min_lat >= self.max_lat or self.min_lon == self.max_lon:
                raise ValueError(
                    "bbox must have nonzero extent and increasing latitude"
                )
        elif self.type == "polygon":
            if self.coordinates is None or len(self.coordinates) < 3:
                raise ValueError("polygon requires at least three vertices")
            for lat, lon in self.coordinates:
                Location(lat=lat, lon=lon)
        elif self.center is None or self.radius_m is None:
            raise ValueError("circle requires center and radius_m")
        return self


class Region(Model):
    area: Area
    resolution_m: float = Field(default=240, gt=0)
    height_m: float = Field(default=0, ge=0, le=50)
    period: RegionPeriod
    panel_mode: Literal[
        "horizontal", "terrain", "vertical_tracking", "full_tracking"
    ] = "horizontal"
    metrics: list[str] = Field(default_factory=lambda: list(METRICS), min_length=1)
    include_timeseries: bool = False

    @field_validator("metrics")
    @classmethod
    def known(cls, value):
        if len(value) != len(set(value)) or any(m not in METRICS for m in value):
            raise ValueError("metrics must contain unique supported metric names")
        return value


# Public response envelopes also validate calculations before JSON serialization.
class EnrichedLocation(Location):
    elevation_m: float
    slope_deg: float
    aspect_deg: float


class Meta(Model):
    request_id: str
    api_version: str
    dem_product: str
    dem_products: list[str]
    ephemeris: str
    frame: str
    computed_in_ms: float
    horizon_model: str
    limitations: list[str]


class SunOut(Model):
    elevation_deg: float
    azimuth_deg: float
    distance_au: float
    horizon_elevation_deg: float
    visible_fraction: float = Field(ge=0, le=1)
    is_illuminated: bool
    incidence_angle_deg: float


class IrradianceOut(Model):
    toa_w_m2: float = Field(ge=0)
    horizontal_w_m2: float = Field(ge=0)
    terrain_w_m2: float = Field(ge=0)
    vertical_tracking_w_m2: float = Field(ge=0)
    full_tracking_w_m2: float = Field(ge=0)
    custom_panel_w_m2: float | None


class EarthOut(Model):
    elevation_deg: float
    is_visible: bool


class PointOut(Model):
    location: EnrichedLocation
    time: datetime
    sun: SunOut
    irradiance: IrradianceOut
    earth: EarthOut
    meta: Meta


class GridOut(Model):
    rows: int
    cols: int
    resolution_m: float
    projection: str
    lat: list[list[float | None]]
    lon: list[list[float | None]]
    mask: list[list[bool]]


class MetricOut(Model):
    unit: str
    min: float | None
    max: float | None
    mean: float | None
    values: list[list[float | None]]


class RegionOut(Model):
    grid: GridOut
    period: dict
    metrics: dict[str, MetricOut]
    ranking: dict
    timeseries: dict | None
    meta: Meta


class SizingOut(Model):
    min_panel_area_m2: float | None
    min_battery_wh: float | None
    recommended_panel_area_m2: float | None
    recommended_battery_wh: float | None
    limiting_factor: Literal["total_energy", "darkness_survival", "peak_power"]


class MissionOut(Model):
    location: EnrichedLocation
    period: dict
    solar_conditions: dict
    energy: dict
    sizing: SizingOut
    panel_recommendation: dict | None = None
    feasible: bool
    warnings: list[dict]
    timeline: dict
    meta: Meta


class WindowOut(Model):
    rank: int
    start: datetime
    end: datetime
    duration_hours: float
    score: float = Field(ge=0, le=1)
    mean_power_w: float
    min_power_w: float
    power_margin_pct: float
    illumination_pct: float
    longest_darkness_hours: float
    min_battery_soc_pct: float = Field(ge=0, le=100)


class WindowsOut(Model):
    equipment: dict
    location: EnrichedLocation
    search: dict
    summary: dict
    windows: list[WindowOut]
    unsuitable_periods: list[dict]
    panel_recommendation: dict | None = None
    timeline: dict
    meta: Meta
