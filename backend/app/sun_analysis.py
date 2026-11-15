"""Point report, region time series and site judging on top of app.sun and app.thermal.

Merged from the lunar_sun prototype. Pure computation: the router fetches the Horizons
series and prepares the sites. Earth-visibility metrics reuse the same skyline per point.
"""
import math
from datetime import datetime, timedelta

import numpy as np

from . import thermal
from .sun import DARK, SUNLIT, Sites, earth_clearance, illumination, sun_state

MAX_POINTS = 900
MAX_STEPS = 8000            # Horizons rows per body, including thermal spin-up
MAX_CELLS = 2_000_000       # points x time steps held in memory at once
EVENT_DAYS = 30
EVENT_STEP_MIN = 30

LIMITATIONS = [
    "Sunlight is direct sunlight only: no light scattered from nearby terrain, so shadowed "
    "ground gets no indirect light.",
    "The heat model has no scattered light or infrared from surrounding terrain, so permanently "
    "shadowed floors come out about 10-30 K too cold.",
    "Terrain comes from the local LOLA grids at ground level; features smaller than their "
    "resolution are not seen, and slopes are averaged over two grid cells.",
    "Each point has one skyline sampled every azimuth_step_deg and interpolated linearly between rays.",
    "Earth visibility here is Earth's center against the same ground-level skyline at the "
    "sample times; use /api/earth-link for refined windows and antenna height.",
    "Terrain and Horizons site coordinates are both treated as MOON_ME on the 1,737.4 km sphere.",
]

SUN_METRICS = ["illumination_fraction", "max_darkness_hours", "mean_irradiance_wm2",
               "energy_tracking_kwh_m2", "energy_flat_kwh_m2", "slope_deg", "elevation_m"]
TEMP_METRICS = ["min_temp_K", "max_temp_K", "mean_temp_K", "temp_range_K"]
EARTH_METRICS = ["earth_visible_fraction", "max_earth_blackout_hours"]
METRICS = SUN_METRICS + TEMP_METRICS + EARTH_METRICS

PRESETS = {
    "solar_rover": [
        {"metric": "illumination_fraction", "op": ">=", "value": 0.5, "weight": 2},
        {"metric": "max_darkness_hours", "op": "<=", "value": 100, "weight": 3, "required": True},
        {"metric": "slope_deg", "op": "<=", "value": 15, "weight": 2, "required": True},
        {"metric": "max_temp_K", "op": "<=", "value": 400, "weight": 1},
    ],
    "lander_survival": [
        {"metric": "max_darkness_hours", "op": "<=", "value": 72, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": ">=", "value": 0.6, "weight": 2},
        {"metric": "slope_deg", "op": "<=", "value": 8, "weight": 3, "required": True},
        {"metric": "min_temp_K", "op": ">=", "value": 80, "weight": 1},
    ],
    "ice_cold_trap": [
        {"metric": "max_temp_K", "op": "<=", "value": 110, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": "<=", "value": 0.05, "weight": 1},
    ],
    "crewed_landing": [
        {"metric": "slope_deg", "op": "<=", "value": 8, "weight": 3, "required": True},
        {"metric": "earth_visible_fraction", "op": ">=", "value": 0.5, "weight": 3, "required": True},
        {"metric": "illumination_fraction", "op": ">=", "value": 0.5, "weight": 2},
        {"metric": "max_darkness_hours", "op": "<=", "value": 100, "weight": 2},
    ],
}
OPS = {">=": np.greater_equal, "<=": np.less_equal, ">": np.greater, "<": np.less, "==": np.isclose}


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _r(x, n=3):
    return None if x is None or not np.isfinite(x) else round(float(x), n)


def spinup_steps(step_min: int) -> int:
    """Steps covering one synodic month before the period, for the heat model to settle."""
    return math.ceil(thermal.SYNODIC_S / (step_min * 60))


def time_grid(start: datetime, stop: datetime, step_min: int) -> list[datetime]:
    count = int((stop - start).total_seconds() // (step_min * 60)) + 1
    return [start + timedelta(minutes=step_min * i) for i in range(count)]


def _longest_run(mask: np.ndarray) -> np.ndarray:
    """Longest run of True along the last axis, per row."""
    best = np.zeros(mask.shape[0], int)
    cur = np.zeros(mask.shape[0], int)
    for k in range(mask.shape[1]):
        cur = np.where(mask[:, k], cur + 1, 0)
        best = np.maximum(best, cur)
    return best


def _surface_temperature(il: dict, step_min: int, n_spin: int) -> np.ndarray:
    q = (1 - thermal.albedo(il["incidence"])) * il["on_slope"]
    return thermal.simulate(q, step_min * 60.0, n_spin)


def _ephemeris_meta(source: dict, sites: Sites) -> dict:
    return {"ephemeris": source, "terrain_model": sites.terrain_model}


# ------------------------------------------------------------------ point
def _events(times, frac, k):
    """Next sunrise and sunset after index k, with crossings of SUNLIT interpolated linearly."""
    lit = frac >= SUNLIT
    out = {"next_sunrise_utc": None, "next_sunset_utc": None}
    for i in np.flatnonzero(lit[k + 1:] != lit[k:-1]) + k:
        key = "next_sunrise_utc" if lit[i + 1] else "next_sunset_utc"
        if out[key] is None:
            f = (SUNLIT - frac[i]) / (frac[i + 1] - frac[i])
            moment = times[i] + (times[i + 1] - times[i]) * float(np.clip(f, 0, 1))
            out[key] = _iso(moment.replace(microsecond=0))
    out["search_days"] = EVENT_DAYS
    out["sample_step_minutes"] = EVENT_STEP_MIN
    out["note"] = None if out["next_sunrise_utc"] or out["next_sunset_utc"] else (
        f"Sunlit for the whole next {EVENT_DAYS} days" if lit[k] else f"Dark for the whole next {EVENT_DAYS} days")
    return out


def point_report(sites: Sites, times: list[datetime], sun_km: np.ndarray, k: int, source: dict,
                 power_threshold: float, events: bool, temperature: bool, step_min: int) -> dict:
    """Sun state at times[k] for one point; events search forward from k, temperature spins up over [0, k]."""
    il = illumination(sites, sun_km)
    g = {key: float(v[0, k]) for key, v in il.items()}
    frac = g["frac"]
    out = {
        "input": {"lat": float(sites.lat[0]), "lon": float(sites.lon[0]), "time_utc": _iso(times[k])},
        **_ephemeris_meta(source, sites),
        "sun": {
            "azimuth_deg": _r(g["az"]), "elevation_deg": _r(g["el"]),
            "terrain_horizon_deg": _r(g["horizon"]), "angular_radius_deg": _r(g["ang"], 4),
            "visible_disk_fraction": _r(frac, 4), "distance_au": _r(g["dist_au"], 6),
            "state": sun_state(g["el"], g["horizon"], g["ang"], frac),
        },
        "terrain": {"elevation_m": _r(sites.ground_m[0], 1), "slope_deg": _r(sites.slope_deg[0], 2),
                    "aspect_deg": _r(sites.aspect_deg[0], 1)},
        "irradiance_wm2": {
            "solar_constant_at_moon": _r(g["s_au"], 1),
            "direct_normal": _r(g["dni"], 1),
            "horizontal": _r(g["horizontal"], 1),
            "on_local_slope": _r(g["on_slope"], 1),
            "incidence_on_slope_deg": _r(g["incidence"], 2),
        },
        "decisions": {
            "sun_reaches_point": frac > 0.001,
            "power_available": bool(g["dni"] >= power_threshold),
            "power_threshold_wm2": power_threshold,
            "best_panel": {"azimuth_deg": _r(g["az"], 1),
                           "tilt_from_horizontal_deg": _r(90 - max(g["el"], 0), 1),
                           "irradiance_wm2": _r(g["dni"], 1)},
            "flat_panel_efficiency_vs_tracking": _r(g["horizontal"] / g["dni"], 3) if g["dni"] > 0 else 0.0,
        },
        "horizon_profile_deg": np.round(sites.skyline[0], 2).tolist(),
        "horizon_azimuth_step_deg": sites.azimuth_step_deg,
    }
    if events:
        out["events"] = _events(times, il["frac"][0], k)
    if temperature:
        trimmed = {key: v[:, :k + 1] for key, v in il.items()}
        out["surface_temperature_K"] = _r(_surface_temperature(trimmed, step_min, k)[0, -1], 1)
    out["warnings"] = sites.warnings
    out["limitations"] = LIMITATIONS
    return out


# ------------------------------------------------------------------ region
def region_series(sites: Sites, times: list[datetime], sun_km: np.ndarray, n_spin: int, step_min: int,
                  source: dict, thermal_model: bool = True, grid_series: bool = True, axes=None,
                  earth_km: np.ndarray | None = None) -> dict:
    """Per-point statistics and region time series over times[n_spin:]; earlier steps only spin up the heat model."""
    il = illumination(sites, sun_km)
    out_ts = times[n_spin:]
    frac, irr = il["frac"][:, n_spin:], il["on_slope"][:, n_spin:]
    dni, hor = il["dni"][:, n_spin:], il["horizontal"][:, n_spin:]
    temp = _surface_temperature(il, step_min, n_spin) if thermal_model else None

    h = step_min / 60.0
    stats = {
        "lat": sites.lat.round(4).tolist(), "lon": sites.lon.round(4).tolist(),
        "elevation_m": sites.ground_m.round(1).tolist(), "slope_deg": sites.slope_deg.round(2).tolist(),
        "illumination_fraction": frac.mean(1).round(4).tolist(),
        "max_darkness_hours": (_longest_run(frac < DARK) * h).round(1).tolist(),
        "mean_irradiance_wm2": irr.mean(1).round(1).tolist(),
        "energy_tracking_kwh_m2": (dni.sum(1) * h / 1000).round(2).tolist(),
        "energy_flat_kwh_m2": (hor.sum(1) * h / 1000).round(2).tolist(),
    }
    if temp is not None:
        stats |= {"min_temp_K": temp.min(1).round(1).tolist(), "max_temp_K": temp.max(1).round(1).tolist(),
                  "mean_temp_K": temp.mean(1).round(1).tolist(),
                  "temp_range_K": (temp.max(1) - temp.min(1)).round(1).tolist()}
    clear = None
    if earth_km is not None:
        clear = earth_clearance(sites, earth_km[n_spin:]) >= 0
        stats |= {"earth_visible_fraction": clear.mean(1).round(4).tolist(),
                  "max_earth_blackout_hours": (_longest_run(~clear) * h).round(1).tolist()}

    def agg(a):
        return {"mean": a.mean(0).round(2).tolist(), "min": a.min(0).round(2).tolist(),
                "max": a.max(0).round(2).tolist()}

    res = {
        "meta": {"start_utc": _iso(out_ts[0]), "stop_utc": _iso(out_ts[-1]), "step_min": step_min,
                 "n_points": len(sites.lat), "n_times": len(out_ts), "thermal_model": thermal_model,
                 "thermal_spinup_steps": n_spin if thermal_model else 0,
                 "layout": "grid" if axes else "points", **_ephemeris_meta(source, sites)},
        "times": [_iso(t) for t in out_ts],
        "region_timeseries": {"sun_fraction": agg(frac), "irradiance_wm2": agg(irr)}
        | ({"surface_temp_K": agg(temp)} if temp is not None else {})
        | ({"earth_visible": agg(clear.astype(float))} if clear is not None else {}),
        "cell_stats": stats,
        "warnings": sites.warnings,
        "limitations": LIMITATIONS,
    }
    if axes:
        la, lo = axes
        shp = (len(la), len(lo))
        res["grid"] = {"lats": np.round(la, 4).tolist(), "lons": np.round(lo, 4).tolist(),
                       "maps": {k: np.asarray(v).reshape(shp).tolist() for k, v in stats.items()
                                if k not in ("lat", "lon")}}
        if grid_series:   # [time][lat][lon] for heatmap animation
            def cube(a):
                return np.moveaxis(a.reshape(shp + (-1,)), -1, 0).round(2).tolist()
            res["grid"]["series"] = {"sun_fraction": cube(frac), "irradiance_wm2": cube(irr)} \
                | ({"surface_temp_K": cube(temp)} if temp is not None else {})
    res["_raw"] = (sites.lat, sites.lon, out_ts, frac, irr, temp)
    return res


def to_csv(res: dict) -> str:
    lat, lon, ts, frac, irr, temp = res["_raw"]
    rows = ["time_utc,lat,lon,sun_fraction,irradiance_wm2,surface_temp_K"]
    for p in range(len(lat)):
        for k, t in enumerate(ts):
            tk = f"{temp[p, k]:.2f}" if temp is not None else ""
            rows.append(f"{_iso(t)},{lat[p]:.4f},{lon[p]:.4f},{frac[p, k]:.4f},{irr[p, k]:.2f},{tk}")
    return "\n".join(rows) + "\n"


# ------------------------------------------------------------------ judge
def needs(criteria: list[dict]) -> tuple[bool, bool]:
    """(temperature needed, Earth track needed); raises ValueError for an unknown metric."""
    for c in criteria:
        if c["metric"] not in METRICS:
            raise ValueError(f"Unknown metric '{c['metric']}'. Available: {', '.join(METRICS)}.")
    return (any(c["metric"] in TEMP_METRICS for c in criteria),
            any(c["metric"] in EARTH_METRICS for c in criteria))


def judge(criteria: list[dict], res: dict, top_n: int = 10) -> dict:
    """Score each point of a region_series result against the criteria."""
    st = res["cell_stats"]
    n = len(st["lat"])
    score_num, wsum = np.zeros(n), 0.0
    req_ok = np.ones(n, bool)
    detail = []
    for c in criteria:
        a = np.asarray(st[c["metric"]], float)
        if c["op"] == "between":
            lo, hi = c["value"]
            ok = (a >= lo) & (a <= hi)
        else:
            ok = OPS[c["op"]](a, c["value"])
        w = float(c.get("weight", 1))
        score_num += w * ok
        wsum += w
        if c.get("required"):
            req_ok &= ok
        detail.append((c, a, ok))
    score = 100 * score_num / wsum if wsum > 0 else np.zeros(n)
    verdict = req_ok & (score > 0)

    def cell(i):
        return {"lat": st["lat"][i], "lon": st["lon"][i], "elevation_m": st["elevation_m"][i],
                "score": round(float(score[i]), 1),
                "verdict": "PASS" if verdict[i] else "FAIL",
                "criteria": [{"metric": c["metric"], "op": c["op"], "target": c["value"],
                              "actual": _r(a[i], 3), "pass": bool(ok[i]),
                              "required": bool(c.get("required", False)),
                              "weight": c.get("weight", 1)} for c, a, ok in detail]}

    # PASS first, then score; ties -> more sunlight, then shorter darkness
    order = np.lexsort((np.asarray(st["max_darkness_hours"]),
                        -np.asarray(st["illumination_fraction"]), -score, ~verdict))
    out = {"meta": res["meta"], "criteria": criteria,
           "summary": {"n_cells": n, "n_pass": int(verdict.sum()), "best_score": round(float(score.max()), 1)},
           "ranking": [cell(i) for i in order[:top_n]],
           "warnings": res["warnings"], "limitations": res["limitations"]}
    if "grid" in res:
        shp = (len(res["grid"]["lats"]), len(res["grid"]["lons"]))
        out["grid"] = {"lats": res["grid"]["lats"], "lons": res["grid"]["lons"],
                       "score_map": score.reshape(shp).round(1).tolist(),
                       "pass_map": verdict.reshape(shp).astype(int).tolist()}
    return out
