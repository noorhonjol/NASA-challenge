"""Mission analysis: power, heat and communication for one site or a drawn region, in one result.

Pure computation (no network); the router fetches Horizons series and calls these steps.

- Cells: a single point, or cell centres of a polygon on the Lunar Energy v1 grid
  (`energy_v1.region.make_grid`), at the finest analysis level that keeps <= MAX_CELLS cells.
- Power and Earth visibility per cell: Lunar Energy v1 (`energy_v1.solar.series`: SPICE DE440,
  LOLA terrain with 360 horizon bins), with the same definitions as `/v1/solar/region`.
- Heat per cell: `app.sun` + `app.thermal` (Hayne et al. 2017) on the same cell centres,
  Sun positions from JPL Horizons.
- A single site also gets refined Earth windows from `app.earth_link` (antenna 2 m above ground).
- Cells are scored against a mission type with `sun_analysis.judge`.
"""
import math
from datetime import datetime, timedelta

import numpy as np

from . import sun_analysis as sa
from .energy_v1.errors import EnergyError
from .energy_v1.power import runs
from .energy_v1.region import LEVELS, make_grid
from .energy_v1.schemas import Area, Location, Region, RegionPeriod
from .energy_v1.solar import integrate, series

MAX_CELLS = 200
FINE_SKYLINE_MAX_CELLS = 25

# Per-cell metrics: label, unit and which of the three aspects they belong to.
METRICS = {
    "illumination_fraction": ("Sunlit fraction", "", "power"),
    "max_darkness_hours": ("Longest darkness", "h", "power"),
    "solar_energy_kwh_m2": ("Solar energy, sun-tracking vertical panel", "kWh/m²", "power"),
    "mean_irradiance_wm2": ("Mean sunlight on a sun-tracking vertical panel", "W/m²", "power"),
    "min_temp_K": ("Lowest surface temperature", "K", "heat"),
    "max_temp_K": ("Highest surface temperature", "K", "heat"),
    "mean_temp_K": ("Mean surface temperature", "K", "heat"),
    "earth_visible_fraction": ("Earth visible fraction", "", "communication"),
    "slope_deg": ("Slope", "°", "ground"),
    "elevation_m": ("Elevation", "m", "ground"),
}

# Illustrative screening thresholds, not agency requirements.
PRESETS = {
    "crewed_landing": [
        {"metric": "slope_deg", "op": "<=", "value": 8, "weight": 3, "required": True},
        {"metric": "earth_visible_fraction", "op": ">=", "value": 0.5, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": ">=", "value": 0.5, "weight": 2},
        {"metric": "max_darkness_hours", "op": "<=", "value": 100, "weight": 2},
        {"metric": "min_temp_K", "op": ">=", "value": 60, "weight": 1},
    ],
    "lander_survival": [
        {"metric": "max_darkness_hours", "op": "<=", "value": 72, "weight": 3, "required": True},
        {"metric": "slope_deg", "op": "<=", "value": 8, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": ">=", "value": 0.6, "weight": 2},
        {"metric": "min_temp_K", "op": ">=", "value": 80, "weight": 1},
        {"metric": "earth_visible_fraction", "op": ">=", "value": 0.3, "weight": 1},
    ],
    "solar_rover": [
        {"metric": "max_darkness_hours", "op": "<=", "value": 100, "weight": 3, "required": True},
        {"metric": "slope_deg", "op": "<=", "value": 15, "weight": 2, "required": True},
        {"metric": "illumination_fraction", "op": ">=", "value": 0.5, "weight": 2},
        {"metric": "max_temp_K", "op": "<=", "value": 400, "weight": 1},
        {"metric": "earth_visible_fraction", "op": ">=", "value": 0.25, "weight": 1},
    ],
    "ice_cold_trap": [
        {"metric": "max_temp_K", "op": "<=", "value": 110, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": "<=", "value": 0.05, "weight": 1},
    ],
}

LIMITATIONS = [
    "Screening estimates for comparing places and times, not mission certification.",
    "Power: direct sunlight only (no light reflected from terrain); energy is per m² of a "
    "sun-tracking vertical panel before efficiency. Battery and panel sizing need equipment "
    "inputs: use the Advanced tab.",
    "Heat: regolith surface temperature without light or infrared from nearby terrain, so "
    "shadowed ground reads about 10-30 K too cold.",
    "Communication: geometric line of sight to Earth's center, not a radio link.",
    "Region cells are sampled at the grid spacing shown; features between cell centres are not assessed.",
]


def power_step_hours(days: float) -> float:
    return 1 if days <= 7 else 2 if days <= 31 else 6 if days <= 120 else 12


def heat_step_minutes(days: float) -> int:
    return 60 if days <= 31 else 120 if days <= 120 else 240


def period(start: datetime, end: datetime) -> RegionPeriod:
    """Lunar Energy v1 period (validates the 2020-2035 epoch range)."""
    days = (end - start).total_seconds() / 86400
    return RegionPeriod(start=start, end=end, step_hours=power_step_hours(days))


def polygon_cells(polygon: list[tuple[float, float]], power_period: RegionPeriod):
    """Cell centres (lat, lon arrays) inside the polygon at the finest grid with <= MAX_CELLS cells.

    Returns (lat, lon, rows, cols, row_index, col_index, resolution_m, projection).
    """
    area = Area(type="polygon", coordinates=polygon)
    last_error = None
    for level in LEVELS:
        try:
            lat, lon, mask, resolution, projection = make_grid(
                Region(area=area, resolution_m=level, period=power_period))
        except EnergyError as exc:
            if exc.code == "REQUEST_TOO_LARGE":
                continue
            last_error = exc
            break
        if mask.sum() <= MAX_CELLS:
            rows, cols = np.nonzero(mask)
            return lat[mask], lon[mask], mask.shape[0], mask.shape[1], rows, cols, resolution, projection
    raise last_error or EnergyError("INVALID_PARAMETER", "Could not fit the area on an analysis grid", "area")


def power_metrics(lat: float, lon: float, times) -> dict:
    """Sunlight and Earth visibility for one cell, with the definitions of /v1/solar/region."""
    s = series(Location(lat=lat, lon=lon, height_m=0), times)
    f = s["visible_fraction"]
    lit = f > 0
    irr = s["vertical_tracking"]
    dark = runs(~lit[:-1], times)
    return {
        "illumination_fraction": float(lit.mean()),
        "max_darkness_hours": max([d[2] for d in dark], default=0.0),
        "solar_energy_kwh_m2": integrate(irr, times) / 1000,
        "mean_irradiance_wm2": float(irr.mean()),
        "earth_visible_fraction": float(s["earth_visible"].mean()),
        "slope_deg": float(s["location"]["slope_deg"]),
        "elevation_m": float(s["location"]["elevation_m"]),
        "_product": s["product"],
    }


def heat_stats(sites, times, sun_km, n_spin, step_min) -> dict:
    """Surface temperature statistics per cell and the period's time series."""
    return sa.region_series(sites, times, sun_km, n_spin, step_min, {}, thermal_model=True, grid_series=False)


def _round(v, n=4):
    return None if v is None or not math.isfinite(v) else round(float(v), n)


def combine(cells_power: list[dict], heat: dict, criteria: list[dict]) -> tuple[list[dict], dict]:
    """Merge power and heat per cell and score each cell; returns (cells, judged)."""
    st = heat["cell_stats"]
    cells = []
    for i, p in enumerate(cells_power):
        cell = {k: v for k, v in p.items() if not k.startswith("_")}
        cell |= {"lat": st["lat"][i], "lon": st["lon"][i],
                 "min_temp_K": st["min_temp_K"][i], "max_temp_K": st["max_temp_K"][i],
                 "mean_temp_K": st["mean_temp_K"][i]}
        cells.append(cell)
    stats = {key: [c[key] for c in cells] for key in ("lat", "lon", *METRICS)}
    judged = sa.judge(criteria, {"cell_stats": stats, "meta": {}, "warnings": [], "limitations": []}, len(cells)) \
        if criteria else None
    if judged:
        by_position = {(r["lat"], r["lon"]): r for r in judged["ranking"]}
        for c in cells:
            r = by_position[(c["lat"], c["lon"])]
            c["score"], c["verdict"] = r["score"], r["verdict"]
    for c in cells:
        for k in METRICS:
            c[k] = _round(c[k], 4 if k.endswith("fraction") else 2)
    return cells, judged


def aspect_summary(cells: list[dict]) -> dict:
    """Best / mean / worst of each metric across cells, grouped by aspect."""
    out = {}
    for key, (label, unit, aspect) in METRICS.items():
        values = np.array([c[key] for c in cells if c[key] is not None], dtype=float)
        if not values.size:
            continue
        out.setdefault(aspect, {})[key] = {"label": label, "unit": unit, "min": _round(values.min()),
                                          "mean": _round(values.mean()), "max": _round(values.max())}
    return out


def spinup_start(start: datetime, step_min: int) -> tuple[datetime, int]:
    n = sa.spinup_steps(step_min)
    return start - timedelta(minutes=step_min * n), n
