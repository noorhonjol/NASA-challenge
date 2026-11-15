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
    "Communication: geometric line of sight to Earth's centre from the equipment height, not a radio "
    "link or a DSN schedule. Panels and antenna share one height (default 2 m); the heat model uses the "
    "ground itself.",
    "Scores: each need scores 0-100 and falls to 0 at twice its limit; the three are weighted equally. "
    "Pass/fail is strict: a window 'meets all needs' only if every need is met in full.",
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
    max_cable_km: float | None = None
    equipment_height_m: float = 2.0
    labels: dict = field(default_factory=dict)


def resolve_needs(power: dict, heat: dict, comm: dict, max_slope_deg: float, mission_days: float,
                  max_cable_km: float | None = None, equipment_height_m: float = 2.0) -> Needs:
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
        max_cable_km=float(max_cable_km) if max_cable_km else None,
        equipment_height_m=float(equipment_height_m),
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


def cell_arrays(lat: np.ndarray, lon: np.ndarray, times: list[datetime], progress=None, height_m: float = 2.0) -> dict:
    """Per-cell time series (cells x steps) from the offline ephemeris and terrain.

    Sunlight on the panels and Earth in view are seen from the equipment height above the ground
    (a skyline seen from 0 m is blocked by the nearest uphill ground, which equipment on a mast is
    not). The ground's own irradiance for the heat model ("terrain", "incidence") stays at 0 m.
    """
    keys = ("visible_fraction", "full_tracking", "vertical_tracking", "sun_elevation", "sun_azimuth",
            "earth_visible", "terrain", "incidence")
    out = {k: np.empty((len(lat), len(times)), dtype=bool if k == "earth_visible" else float) for k in keys}
    slope, elevation = np.empty(len(lat)), np.empty(len(lat))
    ground_keys = ("terrain", "incidence")
    for i, (a, b) in enumerate(zip(lat, lon)):
        s = series(Location(lat=float(a), lon=float(b), height_m=height_m), times)
        g = s if height_m == 0 else series(Location(lat=float(a), lon=float(b), height_m=0), times)
        for k in keys:
            out[k][i] = g[k] if k in ground_keys else s[k]
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
    # Hard checks: does this spot meet each need in full during the window?
    power_ok = (coverage >= 1) & (dark_h <= needs.battery_hours)
    heat_ok = in_range >= 0.999
    comm_ok = (visible >= need_share - 1e-9) & (blackout_h <= needs.max_blackout_hours)
    return {"starts": starts, "length": length, "power": power, "heat": heat, "comm": comm, "site": site,
            "slope_ok": slope_ok, "power_ok": power_ok, "heat_ok": heat_ok, "comm_ok": comm_ok, "energy_kwh": energy_kwh, "need_kwh": need_kwh, "coverage": coverage,
            "dark_h": dark_h, "lit": lit, "in_range": in_range, "t_min": t_min, "t_max": t_max,
            "visible": visible, "blackout_h": blackout_h, "best_az": best_az}


def separation_km(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Great-circle distances between all cells (km) on the 1,737.4 km Moon."""
    la, lo = np.radians(lat), np.radians(lon)
    c = np.sin(la)[:, None] * np.sin(la)[None, :] + np.cos(la)[:, None] * np.cos(la)[None, :] * np.cos(lo[:, None] - lo[None, :])
    return np.arccos(np.clip(c, -1, 1)) * 1737.4


def window_scores(s: dict, reach: np.ndarray | None = None) -> dict:
    """Each window's base site, with the best panel and antenna spots it can use.

    `reach[b, c]` says whether equipment at cell c can serve a base at cell b (cable length);
    without it, any spot in the area can. A base is chosen first by how many needs it leaves
    unmet (heat and slope at the base, power and communication from the best reachable spots),
    then by score: a window where everything is met always ranks above one where something fails.
    """
    n = s["power"].shape[0]
    reach = np.ones((n, n), bool) if reach is None else reach
    r = reach[:, :, None]                                                   # base x cell x window
    best_power = np.where(r, s["power"][None], -1).max(axis=1)              # base x window
    best_comm = np.where(r, s["comm"][None], -1).max(axis=1)
    power_cell = np.where(r, s["power"][None], -1).argmax(axis=1)
    comm_cell = np.where(r, s["comm"][None], -1).argmax(axis=1)
    power_met = (r & s["power_ok"][None]).any(axis=1)
    comm_met = (r & s["comm_ok"][None]).any(axis=1)
    slope = np.broadcast_to(s["slope_ok"][:, None], s["heat"].shape)
    fails = (~s["heat_ok"]).astype(int) + (~slope).astype(int) + (~power_met).astype(int) + (~comm_met).astype(int)
    score = (s["heat"] + best_power + best_comm) / 3 * slope
    key = fails * 1000 - score                                              # fewest failures, then highest score
    base_cell = key.argmin(axis=0)
    cols = np.arange(key.shape[1])
    pick = lambda a: a[base_cell, cols]  # noqa: E731
    return {"score": pick(score), "base_cell": base_cell, "fails": pick(fails),
            "power_cell": pick(power_cell), "comm_cell": pick(comm_cell),
            "best_power": pick(best_power), "best_comm": pick(best_comm), "base_heat": s["heat"][base_cell, cols],
            "power_met": pick(power_met), "comm_met": pick(comm_met), "heat_met": s["heat_ok"][base_cell, cols],
            "slope_met": s["slope_ok"][base_cell]}


def failure_reasons(s: dict, ws: dict, w: int, needs: Needs) -> list[dict]:
    """Plain reasons why window w misses a need, from the spots that come closest."""
    out = []
    b, pc, cc = int(ws["base_cell"][w]), int(ws["power_cell"][w]), int(ws["comm_cell"][w])
    if not ws["power_met"][w]:
        why = []
        if s["coverage"][pc, w] < 1:
            why.append(f"panels give {s['energy_kwh'][pc, w]:.0f} of {s['need_kwh']:.0f} kWh needed")
        if s["dark_h"][pc, w] > needs.battery_hours:
            why.append(f"darkness lasts {s['dark_h'][pc, w]:.0f} h, battery covers {needs.battery_hours:.0f} h")
        out.append({"criterion": "power", "text": "Power: " + "; ".join(why or ["not enough at any reachable spot"])})
    if not ws["heat_met"][w]:
        out.append({"criterion": "heat", "text": f"Heat: surface {s['t_min'][b, w]:.0f}–{s['t_max'][b, w]:.0f} K at the base, "
                    f"allowed {needs.min_k:.0f}–{needs.max_k:.0f} K ({s['in_range'][b, w] * 100:.0f}% of the time in range)"})
    if not ws["comm_met"][w]:
        out.append({"criterion": "comm", "text": f"Communication: Earth in view {s['visible'][cc, w] * 100:.0f}% (need "
                    f"{needs.min_visible_fraction * 100:.0f}%), longest blackout {s['blackout_h'][cc, w]:.0f} h (allowed "
                    f"{needs.max_blackout_hours:.0f} h)"})
    if not ws["slope_met"][w]:
        out.append({"criterion": "slope", "text": f"Ground: no spot flat enough for a base (limit {needs.max_slope_deg:.0f}°)"})
    return out


def pick_windows(score: np.ndarray, starts: np.ndarray, length: int, count: int = TOP_WINDOWS,
                 fails: np.ndarray | None = None) -> list[int]:
    """The best windows (fewest unmet needs, then highest score), skipping any that overlaps a
    better pick by more than half."""
    chosen: list[int] = []
    order = np.lexsort((-score, fails)) if fails is not None else np.argsort(-score, kind="stable")
    for w in order:
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
        "meets": {"power": bool(s["power_ok"][i, w]), "heat": bool(s["heat_ok"][i, w]), "comm": bool(s["comm_ok"][i, w])},
    }


def _top_cells(values: np.ndarray, count: int = 3) -> list[int]:
    return [int(i) for i in np.argsort(-values, kind="stable")[:count]]


def summarise(s: dict, ws: dict, times: list[datetime], n_spin: int, lat, lon, slope, elevation,
              needs: Needs | None = None, dist: np.ndarray | None = None) -> dict:
    """The JSON result: the timeline of window scores, the top windows and per-cell maps for them."""
    t0 = times[n_spin]
    h = (times[1] - times[0]).total_seconds() / 3600
    start_of = lambda w: t0 + timedelta(hours=float(s["starts"][w]) * h)  # noqa: E731
    span = timedelta(hours=s["length"] * h)
    spot = lambda i: {"cell": i, "lat": _r(lat[i], 5), "lon": _r(lon[i], 5),  # noqa: E731
                      "slope_deg": _r(slope[i], 1), "elevation_m": _r(elevation[i], 0)}
    windows = []
    for w in pick_windows(ws["score"], s["starts"], s["length"], fails=ws["fails"]):
        base = int(ws["base_cell"][w])
        # Equipment spots the base can use (within the cable length), best first, with their distance.
        usable = np.ones(len(lat), bool) if dist is None or needs is None or needs.max_cable_km is None \
            else dist[base] <= needs.max_cable_km
        far = lambda i: {"distance_km": _r(dist[base, i], 2)} if dist is not None else {}  # noqa: E731
        ranked = lambda v: [i for i in _top_cells(np.where(usable, v, -1), len(lat)) if usable[i]][:3]  # noqa: E731
        windows.append({
            "index": w, "start": start_of(w).isoformat(), "end": (start_of(w) + span).isoformat(),
            "score": _r(ws["score"][w]), "feasible": bool(ws["fails"][w] == 0),
            "fails": failure_reasons(s, ws, w, needs) if needs is not None else [],
            "parts": {"power": _r(ws["best_power"][w]), "heat": _r(ws["base_heat"][w]), "comm": _r(ws["best_comm"][w])},
            "met": {"power": bool(ws["power_met"][w]), "heat": bool(ws["heat_met"][w]), "comm": bool(ws["comm_met"][w]),
                    "slope": bool(ws["slope_met"][w])},
            "base": spot(base) | cell_detail(s, base, w),
            "solar_spots": [spot(i) | far(i) | cell_detail(s, i, w) for i in ranked(s["power"][:, w])],
            "comm_spots": [spot(i) | far(i) | cell_detail(s, i, w) for i in ranked(s["comm"][:, w])],
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
        "feasible_count": int((ws["fails"] == 0).sum()),
        "need_kwh": _r(s["need_kwh"]),
    }


def search(lat: np.ndarray, lon: np.ndarray, start: datetime, end: datetime, mission_days: float,
           needs: Needs, progress=None) -> dict:
    """Full search for the given cells. `progress(done, total)` is called as cells finish."""
    times, n_spin, h = plan_times(start, end)
    search_days = (end - start).total_seconds() / 86400
    arrays = cell_arrays(lat, lon, times, progress, needs.equipment_height_m)
    temp = surface_temperature(arrays, h, n_spin)
    s = score_windows(arrays, temp, n_spin, h, mission_days, search_days, needs)
    dist = separation_km(np.asarray(lat, float), np.asarray(lon, float))
    reach = dist <= needs.max_cable_km if needs.max_cable_km else None
    ws = window_scores(s, reach)
    out = summarise(s, ws, times, n_spin, lat, lon, arrays["slope_deg"], arrays["elevation_m"], needs, dist)
    out["cells"] = [{"lat": _r(a, 5), "lon": _r(b, 5), "slope_deg": _r(c, 1), "elevation_m": _r(d, 0)}
                    for a, b, c, d in zip(lat, lon, arrays["slope_deg"], arrays["elevation_m"])]
    out["step_hours"] = h
    out["window_stride_hours"] = window_stride_hours(search_days)
    out["window_count"] = int(len(s["starts"]))
    return out


def sky_view(lat: float, lon: float, start: datetime, end: datetime, height_m: float = 2.0, max_samples: int = 1500) -> dict:
    """The terrain skyline (360 azimuths) and the Sun and Earth tracks seen from one spot.

    Same engine and height as the search, so the chart and the scores agree. A body is shown as
    visible when its centre (Earth) or part of its disc (Sun) is above the skyline.
    """
    hours = (end - start).total_seconds() / 3600
    step = max(0.5, math.ceil(hours / max_samples * 2) / 2)
    times = [start + timedelta(hours=step * i) for i in range(int(hours // step) + 1)]
    s = series(Location(lat=lat, lon=lon, height_m=height_m), times)
    r = lambda a, n=2: [round(float(v), n) for v in a]  # noqa: E731
    return {
        "lat": lat, "lon": lon, "height_m": height_m, "step_hours": step,
        "skyline_deg": r(s["skyline"]),
        "times": [t.isoformat() for t in times],
        "sun": {"azimuth_deg": r(s["sun_azimuth"]), "elevation_deg": r(s["sun_elevation"], 3),
                "visible_fraction": r(s["visible_fraction"], 3)},
        "earth": {"azimuth_deg": r(s["earth_azimuth"]), "elevation_deg": r(s["earth_elevation"], 3),
                  "visible": [bool(v) for v in s["earth_visible"]]},
        "source": "Lunar Energy v1: SPICE DE440 and the LOLA skyline (5 m near the site), as in the mission search",
    }
