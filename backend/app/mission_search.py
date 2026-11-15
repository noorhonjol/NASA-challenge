"""Mission window search: when, within a long period, and where in an area a mission goes best.

Pure computation, no network: everything comes from the offline Lunar Energy v1 data
(SPICE DE440 ephemeris and LOLA terrain), so a search never waits on JPL Horizons.

1. Cells: one point, or the cell centres of a polygon (the Lunar Energy v1 grid, at the finest
   level that fits the cell budget for the period length).
2. One series per cell over the whole search period, plus one synodic month before it so the
   heat model has settled: Sun visibility and direction, irradiance, Earth visibility
   (`energy_v1.solar.series`). Surface temperature comes from the same series through the
   1-D regolith model (`app.thermal`, Hayne et al. 2017).
3. Every mission window (length `mission_days`, starting every 12 or 24 h) is scored per cell
   with sliding sums, for the three criteria:
   - power: energy from the panels over the window against the energy needed, and the longest
     darkness against the battery;
   - heat: share of the window with the surface temperature inside the allowed range;
   - communication: share of the window with Earth in view against the required share, and the
     longest blackout against the allowed one.
4. A window's score: the best base site (its heat and slope) together with the best spot in the
   area for solar panels and the best spot for the antenna, which may be elsewhere. For one point
   these are all the point itself.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from . import thermal
from .energy_v1.errors import EnergyError
from .energy_v1.region import LEVELS, make_grid
from .energy_v1.schemas import Area, Location, Region, RegionPeriod
from .energy_v1.solar import series

SYNODIC_DAYS = thermal.SYNODIC_S / 86400
MAX_SEARCH_DAYS = 180
MAX_MISSION_DAYS = 60
CELL_STEP_BUDGET = 160_000          # cells x time steps (including the heat model's warm-up)
MAX_SEARCH_CELLS = 120
FIXED_AZIMUTHS = np.arange(0, 360, 45)
TOP_WINDOWS = 8

# Basic choices. All values are illustrative screening assumptions, not agency requirements.
POWER_TIERS = {
    "low": {"label": "Low power · small robotic payload", "load_w": 100, "panel_area_m2": 1.5, "battery_hours": 50},
    "mid": {"label": "Mid power · rover or robotic lander", "load_w": 1_000, "panel_area_m2": 10, "battery_hours": 30},
    "high": {"label": "High power · crewed lander or habitat", "load_w": 10_000, "panel_area_m2": 80, "battery_hours": 12},
}
HEAT_PROFILES = {
    "crewed": {"label": "Crewed", "min_k": 100, "max_k": 330},
    "robotic": {"label": "Robotic", "min_k": 70, "max_k": 380},
    "cold_science": {"label": "Cold-trap science (ice)", "min_k": 0, "max_k": 110},
}
COMM_LEVELS = {
    "high": {"label": "Very frequent (near-continuous)", "min_visible_fraction": 0.9, "max_blackout_hours": 12},
    "mid": {"label": "Frequent (daily contact)", "min_visible_fraction": 0.5, "max_blackout_hours": 48},
    "low": {"label": "Occasional", "min_visible_fraction": 0.2, "max_blackout_hours": 168},
}
DEFAULT_EFFICIENCY = 0.3

LIMITATIONS = [
    "Screening estimates for comparing places and times, not mission certification.",
    "Power: direct sunlight only (no light reflected from terrain). A sun-tracking panel is a vertical "
    "panel turning to face the Sun; a fixed panel is vertical, facing the best of 8 directions for "
    "each window. The battery is the hours of load it can carry through darkness.",
    "Heat: regolith surface temperature without light or infrared from nearby terrain, so "
    "shadowed ground reads about 10-30 K too cold. Equipment temperature depends on its own "
    "thermal design; the surface range is a proxy for how hard the environment is.",
    "Communication: geometric line of sight from the ground to Earth's centre, not a radio link. "
    "A mast raises the antenna; it is not modelled here.",
    "Areas are sampled on a grid; the map between samples is interpolated. Use 'Compute this "
    "spot exactly' for any other point.",
]


@dataclass
class Needs:
    """The three criteria, resolved to numbers."""
    load_w: float
    panel_area_m2: float
    efficiency: float
    tracking: bool
    battery_hours: float
    min_k: float
    max_k: float
    min_visible_fraction: float
    max_blackout_hours: float
    max_slope_deg: float
    labels: dict = field(default_factory=dict)


def resolve_needs(power: dict, heat: dict, comm: dict, max_slope_deg: float, mission_days: float) -> Needs:
    """Basic choices give defaults; advanced fields override them."""
    tier = POWER_TIERS[power.get("tier", "mid")]
    load = power.get("load_w") or tier["load_w"]
    if power.get("energy_kwh"):
        load = power["energy_kwh"] * 1000 / (mission_days * 24)
    profile = HEAT_PROFILES[heat.get("profile", "robotic")]
    level = COMM_LEVELS[comm.get("frequency", "mid")]
    min_k = heat.get("min_k") if heat.get("min_k") is not None else profile["min_k"]
    max_k = heat.get("max_k") if heat.get("max_k") is not None else profile["max_k"]
    if max_k <= min_k:
        raise EnergyError("INVALID_PARAMETER", "The highest allowed temperature must be above the lowest.", "heat")
    return Needs(
        load_w=float(load),
        panel_area_m2=float(power.get("panel_area_m2") or tier["panel_area_m2"]),
        efficiency=float(power.get("efficiency") or DEFAULT_EFFICIENCY),
        tracking=bool(power.get("tracking", True)),
        battery_hours=float(power["battery_hours"] if power.get("battery_hours") is not None else tier["battery_hours"]),
        min_k=float(min_k), max_k=float(max_k),
        min_visible_fraction=float(comm.get("min_visible_fraction") if comm.get("min_visible_fraction") is not None
                                   else level["min_visible_fraction"]),
        max_blackout_hours=float(comm.get("max_blackout_hours") if comm.get("max_blackout_hours") is not None
                                 else level["max_blackout_hours"]),
        max_slope_deg=float(max_slope_deg),
        labels={"power": tier["label"], "heat": profile["label"], "communication": level["label"]},
    )


def step_hours(search_days: float) -> float:
    return 1.0 if search_days <= 45 else 2.0 if search_days <= 120 else 3.0


def window_stride_hours(search_days: float) -> float:
    return 12.0 if search_days <= 60 else 24.0


def plan_times(start: datetime, end: datetime) -> tuple[list[datetime], int, float]:
    """Time grid over [start - one synodic month, end]; returns (times, warm-up steps, step hours)."""
    days = (end - start).total_seconds() / 86400
    h = step_hours(days)
    n_spin = math.ceil(SYNODIC_DAYS * 24 / h)
    count = int((end - start).total_seconds() // (h * 3600)) + 1
    first = start - timedelta(hours=h * n_spin)
    return [first + timedelta(hours=h * i) for i in range(n_spin + count)], n_spin, h


def cell_budget(n_steps: int) -> int:
    return max(1, min(MAX_SEARCH_CELLS, CELL_STEP_BUDGET // n_steps))


def polygon_cells(polygon, max_cells: int, start: datetime):
    """Cell centres inside the polygon at the finest grid level with <= max_cells cells.

    Returns (lat, lon, grid) where grid has rows, cols, resolution and each cell's row/col.
    """
    area = Area(type="polygon", coordinates=polygon)
    grid_period = RegionPeriod(start=start, end=start + timedelta(days=1), step_hours=24)
    last_error = None
    for level in LEVELS:
        try:
            lat, lon, mask, resolution, projection = make_grid(Region(area=area, resolution_m=level, period=grid_period))
        except EnergyError as exc:
            if exc.code == "REQUEST_TOO_LARGE":
                continue
            last_error = exc
            break
        if 0 < mask.sum() <= max_cells:
            rows, cols = np.nonzero(mask)
            return lat[mask], lon[mask], {"rows": int(mask.shape[0]), "cols": int(mask.shape[1]),
                                          "resolution_m": resolution, "projection": projection,
                                          "cell_rows": rows.tolist(), "cell_cols": cols.tolist()}
    raise last_error or EnergyError("INVALID_PARAMETER", "Could not fit the area on an analysis grid", "area")


def cell_arrays(lat: np.ndarray, lon: np.ndarray, times: list[datetime], progress=None) -> dict:
    """Per-cell time series (cells x steps) from the offline ephemeris and terrain."""
    keys = ("visible_fraction", "full_tracking", "vertical_tracking", "sun_elevation", "sun_azimuth",
            "earth_visible", "terrain", "incidence")
    out = {k: np.empty((len(lat), len(times)), dtype=bool if k == "earth_visible" else float) for k in keys}
    slope, elevation = np.empty(len(lat)), np.empty(len(lat))
    for i, (a, b) in enumerate(zip(lat, lon)):
        s = series(Location(lat=float(a), lon=float(b), height_m=0), times)
        for k in keys:
            out[k][i] = s[k]
        slope[i], elevation[i] = s["location"]["slope_deg"], s["location"]["elevation_m"]
        if progress:
            progress(i + 1, len(lat))
    out["slope_deg"], out["elevation_m"] = slope, elevation
    return out


def surface_temperature(arrays: dict, step_h: float, n_spin: int) -> np.ndarray:
    """Surface temperature (cells x steps after warm-up) from the same sunlight series."""
    q = (1 - thermal.albedo(arrays["incidence"])) * arrays["terrain"]
    return thermal.simulate(q, step_h * 3600.0, n_spin)


def _cumsum(x: np.ndarray) -> np.ndarray:
    """Cumulative sum along the last axis with a leading zero."""
    pad = np.zeros(x.shape[:-1] + (1,))
    return np.concatenate([pad, np.cumsum(x, axis=-1)], axis=-1)


def _run_lengths(mask: np.ndarray) -> np.ndarray:
    """Length of the run of True ending at each index (cells x steps)."""
    out = np.zeros(mask.shape, dtype=np.int32)
    cur = np.zeros(mask.shape[0], dtype=np.int32)
    for k in range(mask.shape[1]):
        cur = np.where(mask[:, k], cur + 1, 0)
        out[:, k] = cur
    return out


def _longest_in_windows(runs: np.ndarray, starts: np.ndarray, length: int) -> np.ndarray:
    """Longest run inside each window [s, s+length): cells x windows, in steps."""
    offsets = np.arange(length)
    idx = starts[:, None] + offsets[None, :]                     # windows x length
    within = np.minimum(runs[:, idx], offsets[None, None, :] + 1)  # runs cut at the window start
    return within.max(axis=2)


def _factor(value: np.ndarray, limit: float) -> np.ndarray:
    """1 within the limit, falling linearly to 0 at twice the limit."""
    if limit <= 0:
        return np.where(value <= 0, 1.0, 0.0)
    return np.clip(1 - (value - limit) / limit, 0, 1)


def score_windows(arrays: dict, temp: np.ndarray, n_spin: int, h: float, mission_days: float,
                  search_days: float, needs: Needs) -> dict:
    """Score every window for every cell. All returned arrays are cells x windows."""
    frac = arrays["visible_fraction"][:, n_spin:]
    n_cells, n_steps = frac.shape
    length = max(1, round(mission_days * 24 / h))
    stride = max(1, round(window_stride_hours(search_days) / h))
    if length > n_steps:
        raise EnergyError("INVALID_PARAMETER", "The mission is longer than the search period.", "mission_days")
    starts = np.arange(0, n_steps - length + 1, stride)
    ends = starts + length
    hours = length * h

    # Power: energy per m^2 (Wh) for a tracking panel, or the best of 8 fixed vertical directions.
    if needs.tracking:
        flux = arrays["vertical_tracking"][:, n_spin:]
        wh = (_cumsum(flux)[:, ends] - _cumsum(flux)[:, starts]) * h
        best_az = np.full(wh.shape, np.nan)
    else:
        el = np.radians(arrays["sun_elevation"][:, n_spin:])
        az = np.radians(arrays["sun_azimuth"][:, n_spin:])
        full = arrays["full_tracking"][:, n_spin:]
        per_dir = np.stack([full * np.maximum(0, np.cos(el) * np.cos(az - np.radians(b))) for b in FIXED_AZIMUTHS], axis=1)
        c = _cumsum(per_dir)
        sums = (c[:, :, ends] - c[:, :, starts]) * h              # cells x dirs x windows
        pick = sums.argmax(axis=1)
        wh = np.take_along_axis(sums, pick[:, None, :], axis=1)[:, 0, :]
        best_az = FIXED_AZIMUTHS[pick].astype(float)
    energy_kwh = wh * needs.panel_area_m2 * needs.efficiency / 1000
    need_kwh = needs.load_w * hours / 1000
    coverage = energy_kwh / need_kwh if need_kwh > 0 else np.full(energy_kwh.shape, np.inf)
    dark = frac <= 0
    dark_h = _longest_in_windows(_run_lengths(dark), starts, length) * h
    lit = (_cumsum(~dark)[:, ends] - _cumsum(~dark)[:, starts]) / length
    power = 100 * np.minimum(1, coverage) * _factor(dark_h, needs.battery_hours)

    # Heat: share of the window inside the allowed surface temperature range.
    inside = (temp >= needs.min_k) & (temp <= needs.max_k)
    in_range = (_cumsum(inside)[:, ends] - _cumsum(inside)[:, starts]) / length
    idx = starts[:, None] + np.arange(length)[None, :]
    t_min, t_max = temp[:, idx].min(axis=2), temp[:, idx].max(axis=2)
    heat = 100 * in_range

    # Communication: Earth in view, and the longest blackout.
    earth = arrays["earth_visible"][:, n_spin:]
    visible = (_cumsum(earth)[:, ends] - _cumsum(earth)[:, starts]) / length
    blackout_h = _longest_in_windows(_run_lengths(~earth), starts, length) * h
    need_share = needs.min_visible_fraction
    comm = 100 * np.minimum(1, visible / need_share if need_share > 0 else 1) * _factor(blackout_h, needs.max_blackout_hours)

    slope_ok = arrays["slope_deg"] <= needs.max_slope_deg
    site = (power + heat + comm) / 3 * slope_ok[:, None]
    return {"starts": starts, "length": length, "power": power, "heat": heat, "comm": comm, "site": site,
            "slope_ok": slope_ok, "energy_kwh": energy_kwh, "need_kwh": need_kwh, "coverage": coverage,
            "dark_h": dark_h, "lit": lit, "in_range": in_range, "t_min": t_min, "t_max": t_max,
            "visible": visible, "blackout_h": blackout_h, "best_az": best_az}


def window_scores(s: dict) -> dict:
    """A window's score: the best base site (heat, slope) with the best panel and antenna spots."""
    best_power = s["power"].max(axis=0)
    best_comm = s["comm"].max(axis=0)
    base = (s["heat"] + best_power[None, :] + best_comm[None, :]) / 3 * s["slope_ok"][:, None]
    base_cell = base.argmax(axis=0)
    cols = np.arange(base.shape[1])
    return {"score": base[base_cell, cols], "base_cell": base_cell,
            "power_cell": s["power"].argmax(axis=0), "comm_cell": s["comm"].argmax(axis=0),
            "best_power": best_power, "best_comm": best_comm, "base_heat": s["heat"][base_cell, cols]}


def pick_windows(score: np.ndarray, starts: np.ndarray, length: int, count: int = TOP_WINDOWS) -> list[int]:
    """The best windows, skipping any that overlaps a better pick by more than half."""
    chosen: list[int] = []
    for w in np.argsort(-score, kind="stable"):
        if all(abs(int(starts[w]) - int(starts[c])) >= length / 2 for c in chosen):
            chosen.append(int(w))
        if len(chosen) == count:
            break
    return chosen


def _r(v, n=1):
    v = float(v)
    return None if not math.isfinite(v) else round(v, n)


def cell_detail(s: dict, i: int, w: int) -> dict:
    """Everything about one cell in one window, for the criteria table."""
    return {
        "power": _r(s["power"][i, w]), "heat": _r(s["heat"][i, w]), "comm": _r(s["comm"][i, w]), "site": _r(s["site"][i, w]),
        "energy_kwh": _r(s["energy_kwh"][i, w]), "coverage": _r(min(s["coverage"][i, w], 99), 2),
        "sunlit_fraction": _r(s["lit"][i, w], 3), "longest_darkness_h": _r(s["dark_h"][i, w]),
        "fixed_panel_azimuth_deg": _r(s["best_az"][i, w], 0),
        "in_range_fraction": _r(s["in_range"][i, w], 3), "min_temp_K": _r(s["t_min"][i, w]), "max_temp_K": _r(s["t_max"][i, w]),
        "earth_visible_fraction": _r(s["visible"][i, w], 3), "longest_blackout_h": _r(s["blackout_h"][i, w]),
        "slope_ok": bool(s["slope_ok"][i]),
    }


def _top_cells(values: np.ndarray, count: int = 3) -> list[int]:
    return [int(i) for i in np.argsort(-values, kind="stable")[:count]]


def summarise(s: dict, ws: dict, times: list[datetime], n_spin: int, lat, lon, slope, elevation) -> dict:
    """The JSON result: the timeline of window scores, the top windows and per-cell maps for them."""
    t0 = times[n_spin]
    h = (times[1] - times[0]).total_seconds() / 3600
    start_of = lambda w: t0 + timedelta(hours=float(s["starts"][w]) * h)  # noqa: E731
    span = timedelta(hours=s["length"] * h)
    spot = lambda i: {"cell": i, "lat": _r(lat[i], 5), "lon": _r(lon[i], 5),  # noqa: E731
                      "slope_deg": _r(slope[i], 1), "elevation_m": _r(elevation[i], 0)}
    windows = []
    for w in pick_windows(ws["score"], s["starts"], s["length"]):
        base, pc, cc = int(ws["base_cell"][w]), int(ws["power_cell"][w]), int(ws["comm_cell"][w])
        windows.append({
            "index": w, "start": start_of(w).isoformat(), "end": (start_of(w) + span).isoformat(),
            "score": _r(ws["score"][w]),
            "parts": {"power": _r(ws["best_power"][w]), "heat": _r(ws["base_heat"][w]), "comm": _r(ws["best_comm"][w])},
            "base": spot(base) | cell_detail(s, base, w),
            "solar_spots": [spot(i) | cell_detail(s, i, w) for i in _top_cells(s["power"][:, w])],
            "comm_spots": [spot(i) | cell_detail(s, i, w) for i in _top_cells(s["comm"][:, w])],
            # Per-cell maps for the overlay and for clicking any sampled cell.
            "maps": {k: [_r(v) for v in s[k][:, w]] for k in ("site", "power", "heat", "comm")},
            "cells": [cell_detail(s, i, w) for i in range(len(lat))],
        })
    return {
        "timeline": {"starts": [start_of(w).isoformat() for w in range(len(s["starts"]))],
                     "score": [_r(v) for v in ws["score"]],
                     "power": [_r(v) for v in ws["best_power"]], "heat": [_r(v) for v in ws["base_heat"]],
                     "comm": [_r(v) for v in ws["best_comm"]]},
        "windows": windows,
        "need_kwh": _r(s["need_kwh"]),
    }


def search(lat: np.ndarray, lon: np.ndarray, start: datetime, end: datetime, mission_days: float,
           needs: Needs, progress=None) -> dict:
    """Full search for the given cells. `progress(done, total)` is called as cells finish."""
    times, n_spin, h = plan_times(start, end)
    search_days = (end - start).total_seconds() / 86400
    arrays = cell_arrays(lat, lon, times, progress)
    temp = surface_temperature(arrays, h, n_spin)
    s = score_windows(arrays, temp, n_spin, h, mission_days, search_days, needs)
    ws = window_scores(s)
    out = summarise(s, ws, times, n_spin, lat, lon, arrays["slope_deg"], arrays["elevation_m"])
    out["cells"] = [{"lat": _r(a, 5), "lon": _r(b, 5), "slope_deg": _r(c, 1), "elevation_m": _r(d, 0)}
                    for a, b, c, d in zip(lat, lon, arrays["slope_deg"], arrays["elevation_m"])]
    out["step_hours"] = h
    out["window_stride_hours"] = window_stride_hours(search_days)
    out["window_count"] = int(len(s["starts"]))
    return out
