"""Earth line-of-sight availability for a fixed lunar point over a period.

Pure computation: no network and no database. The router fetches the Earth track from
JPL Horizons and passes it in.

Definitions
- clearance = Earth-center elevation - terrain skyline elevation in Earth's direction.
- status per instant: `available` (clearance >= min_clearance_deg), `blocked`, or
  `unknown` (terrain could not be assessed; never silently treated as clear).
- cause of a blocked instant: `lunar_limb` when Earth is below the horizon of a smooth
  sphere through the site (hidden even on a perfectly smooth Moon), else `terrain`.
- los per instant uses Earth's disc: `clear` (whole disc above the skyline), `grazing`
  (partly above), `blocked` (wholly below), `unknown`.
This is geometric line of sight to Earth's center, not an RF link assessment.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import math

import numpy as np

from . import terrain
from .horizon_profile import RADIUS_M, limb_angle, max_angle, terrain_horizon

EARTH_RADIUS_KM = 6378.137
# Extremes of lunar relief vs the 1,737.4 km sphere (LOLA: about -9.1 km to +10.8 km), padded.
# Used only without terrain data, to decide when the Moon itself must block Earth.
LUNAR_RELIEF_M = (-9200.0, 10800.0)
COARSE_DEG, FINE_DEG = 1.0, 0.1
CUTOFF_MARGIN_DEG = 2.0           # Earth this far above the 1 deg skyline's maximum needs no fine rays
SUBSTEP_DEG, MAX_SUBSTEPS = 0.05, 64
AVAILABLE, BLOCKED, UNKNOWN = "available", "blocked", "unknown"
TERRAIN_ERRORS = (terrain.TerrainUnavailable, OSError, KeyError, ValueError)

LIMITATIONS = [
    "Geometric line of sight to Earth's center only; this is not an RF link assessment "
    "(no link budget, Fresnel zone, diffraction or multipath).",
    "Target is Earth's center: no specific ground station, Earth rotation, station horizon "
    "or DSN scheduling is modelled.",
    "The antenna is a fixed point above the surface; moving spacecraft such as orbiters are out of scope.",
    "Terrain comes from the local LOLA grids; features smaller than their resolution are not seen.",
    "Earth's track is interpolated linearly between Horizons samples; an Earth rise and set "
    "caused by Earth's own motion within one step can be missed.",
    "Terrain and Horizons site coordinates are both treated as MOON_ME on the 1,737.4 km sphere.",
]


class BelowGround(ValueError):
    pass


@dataclass
class Observer:
    latitude_deg: float
    longitude_deg: float
    altitude_m: float
    altitude_reference: str
    radius_m: float                 # distance of the antenna from the Moon's center
    ground_m: float | None          # LOLA ground height above the 1,737.4 km sphere; None without terrain
    terrain: tuple | None           # (manifest, data root) when terrain is usable
    warnings: list[str] = field(default_factory=list)

    @property
    def height_m(self) -> float:
        return self.radius_m - RADIUS_M


def _no_terrain(reason) -> str:
    return (f"Terrain unavailable ({reason}); terrain obstruction was not assessed. Only times when the "
            "Moon itself must block Earth are reported as blocked; all other times are unknown.")


def observer(lat: float, lon: float, altitude_m: float, reference: str) -> Observer:
    """Antenna position from LOLA ground height; raises BelowGround for a sphere height under the terrain."""
    try:
        m, root = terrain.manifest(), terrain.data_root()
        if m["reference_radius_m"] != RADIUS_M:
            raise terrain.TerrainUnavailable("unexpected reference radius")
        ground = float(terrain.sample_heights(m, root, np.array([lat]), np.array([lon]))[0])
        if not math.isfinite(ground):
            raise terrain.TerrainUnavailable("no height at the site")
    except TERRAIN_ERRORS as exc:
        radius = RADIUS_M + altitude_m
        return Observer(lat, lon, altitude_m, reference, radius, None, None, [_no_terrain(exc)])
    if reference == "sphere":
        if altitude_m < ground:
            raise BelowGround(f"altitude_m {altitude_m:g} is below the local ground at {ground:.1f} m "
                              "above the 1,737.4 km sphere.")
        radius = RADIUS_M + altitude_m
    else:
        radius = RADIUS_M + ground + altitude_m
    return Observer(lat, lon, altitude_m, reference, radius, ground, (m, root))


def site_resolution_m(m, lat, lon) -> float:
    """Finest terrain grid spacing at the site itself."""
    best = 2 * math.pi * RADIUS_M / 360 / m["baseline"]["pixels_per_degree"]
    if lat < -70:
        x, y = (float(v) for v in terrain.south_polar_xy(lat, lon, m["reference_radius_m"]))
        for r in m["regions"]:
            left, bottom, right, top = r["bounds_xy_m"]
            if left <= x <= right and bottom <= y <= top and math.hypot(x, y) <= r.get("coverage_radius_m", math.inf):
                best = min(best, r["resolution_m"])
    return best


def densify(t, az, el, rng, matters):
    """Linear Earth track with substeps of <= SUBSTEP_DEG where `matters` (per interval) is true.

    Returns dense (t, az, el, rng), the dense index of each original sample and the
    largest track substep (deg) left where terrain matters.
    """
    az_u = np.degrees(np.unwrap(np.radians(az)))
    span = np.maximum(np.abs(np.diff(az_u)), np.abs(np.diff(el)))
    sub = np.where(matters, np.clip(np.ceil(span / SUBSTEP_DEG), 1, MAX_SUBSTEPS), 1).astype(int)
    idx = np.repeat(np.arange(len(t) - 1), sub)
    starts = np.concatenate([[0], np.cumsum(sub)[:-1]])
    frac = (np.arange(idx.size) - starts[idx]) / sub[idx]

    def lerp(v):
        return np.append(v[idx] + frac * (v[idx + 1] - v[idx]), v[-1])

    worst = float(np.max(np.where(matters, span / sub, 0.0), initial=0.0))
    return lerp(t), lerp(az_u) % 360, lerp(el), lerp(rng), np.append(starts, idx.size), worst


def build_windows(t, status, value, defined, cause, clearance, period_s):
    """Contiguous status windows over [0, period_s] seconds, with crossings at whole seconds.

    Between two samples of different status the crossing is the linear root of `value`
    when both are `defined`, else the midpoint.
    """
    change = np.flatnonzero(status[1:] != status[:-1])
    cross = []
    for k in change:
        if defined[k] and defined[k + 1]:
            v0, v1 = value[k], value[k + 1]
            f = min(max(v0 / (v0 - v1), 0.0), 1.0)
            cross.append(float(round(t[k] + (t[k + 1] - t[k]) * f)))
        else:
            cross.append(float(round((t[k] + t[k + 1]) / 2)))
    edges = [0.0, *cross, float(max(t[-1], period_s))]
    first = np.concatenate([[0], change + 1])
    last = np.concatenate([change, [len(t) - 1]])
    windows = []
    for j, (k0, k1) in enumerate(zip(first, last)):
        a, b = max(edges[j], 0.0), min(edges[j + 1], float(period_s))
        if b <= a:
            continue
        seg = slice(k0, k1 + 1)
        inside = t[seg] <= period_s
        if not inside.any():
            inside[0] = True
        c = clearance[seg][inside] if clearance is not None else np.array([])
        c = c[np.isfinite(c)]
        w = {"status": str(status[k0]), "start_s": a, "end_s": b,
             "min_clearance_deg": float(c.min()) if c.size else None,
             "max_clearance_deg": float(c.max()) if c.size else None,
             "causes": set(cause[seg][inside].tolist()) - {""}}
        if windows and windows[-1]["status"] == w["status"]:     # neighbor dropped as zero-length
            prev = windows[-1]
            prev["end_s"] = b
            prev["causes"] |= w["causes"]
            for key, pick in (("min_clearance_deg", min), ("max_clearance_deg", max)):
                values = [v for v in (prev[key], w[key]) if v is not None]
                prev[key] = pick(values) if values else None
        else:
            windows.append(w)
    return windows


def contact_metrics(windows, period_s, min_window_s, contact):
    """Usable-contact statistics; `contact` is the set of statuses counted as contact."""
    intervals = []
    for w in windows:
        if w["status"] in contact:
            if intervals and intervals[-1][1] == w["start_s"]:
                intervals[-1][1] = w["end_s"]
            else:
                intervals.append([w["start_s"], w["end_s"]])
    usable = [(a, b) for a, b in intervals if b - a >= min_window_s]
    gaps, previous = [], 0.0
    for a, b in usable:
        gaps.append(a - previous)
        previous = b
    gaps.append(period_s - previous)
    total = sum(b - a for a, b in usable)
    return {
        "usable_windows": len(usable),
        "usable_hours": total / 3600,
        "usable_fraction": total / period_s,
        "longest_usable_window_hours": max((b - a for a, b in usable), default=0.0) / 3600,
        "longest_blackout_hours": max(gaps) / 3600,
        "first_contact_after_hours": usable[0][0] / 3600 if usable else None,
    }


CHECKS = (
    ("min_availability_fraction", "usable_fraction", "min"),
    ("max_blackout_hours", "longest_blackout_hours", "max"),
    ("max_first_contact_hours", "first_contact_after_hours", "max"),
)


def assess(criteria, pessimistic, optimistic):
    """Hard limits: fail if they fail even with unknown time counted as contact;
    pass if they pass with unknown time counted as no contact; otherwise inconclusive."""
    def ok(metrics, metric, kind, limit):
        value = metrics[metric]
        return value is not None and (value >= limit if kind == "min" else value <= limit)

    checks = []
    for name, metric, kind in CHECKS:
        limit = criteria.get(name)
        if limit is None:
            continue
        if ok(pessimistic, metric, kind, limit):
            passed = True
        elif not ok(optimistic, metric, kind, limit):
            passed = False
        else:
            passed = None
        value = pessimistic[metric]
        checks.append({"criterion": name, "limit": limit, "metric": metric,
                       "value": None if value is None else round(value, 4), "passed": passed})
    if not checks:
        status = "criteria_not_specified"
    elif any(c["passed"] is False for c in checks):
        status = "fail"
    elif all(c["passed"] for c in checks):
        status = "pass"
    else:
        status = "inconclusive"
    return {"status": status, "checks": checks,
            "note": "Limits are user-supplied mission requirements, judged on geometric line of sight only."}


def _iso(start: datetime, seconds: float) -> str:
    return (start + timedelta(seconds=seconds)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _r(value, digits=4):
    return None if value is None or not math.isfinite(value) else round(float(value), digits)


def compute(obs: Observer, series, start: datetime, end: datetime, step_minutes: int,
            min_clearance_deg: float = 0.0, criteria: dict | None = None,
            include_samples: bool = False, include_skyline: bool = False) -> dict:
    """Availability windows for `series` = [(time, az_deg, el_deg, range_km)] at start + i*step."""
    criteria = criteria or {}
    warnings = list(obs.warnings)
    period_s = (end - start).total_seconds()
    n = len(series)
    t = np.arange(n) * step_minutes * 60.0
    az = np.array([row[1] for row in series], dtype=float)
    el = np.array([row[2] for row in series], dtype=float)
    rng = np.array([row[3] for row in series], dtype=float)
    lat, lon = obs.latitude_deg, obs.longitude_deg

    terrain_info, coarse, theta_max = None, None, None
    if obs.terrain is not None:
        m, root = obs.terrain
        try:
            relief = [m["baseline"]["min_elevation_m"], m["baseline"]["max_elevation_m"]]
            relief += [v for r in m["regions"] for v in (r["min_elevation_m"], r["max_elevation_m"])]
            theta_max = max_angle(obs.radius_m, RADIUS_M + min(relief), RADIUS_M + max(relief))
            coarse_az = np.arange(0, 360, COARSE_DEG)
            coarse, missing = terrain_horizon(m, root, lat, lon, obs.radius_m, coarse_az, theta_max)
            if not np.isfinite(coarse).all():
                raise terrain.TerrainUnavailable("heights missing along some directions")
            terrain_info = (m, root, missing)
        except TERRAIN_ERRORS as exc:
            warnings.append(_no_terrain(exc))
            coarse = None

    if terrain_info is not None:
        m, root, missing = terrain_info
        cutoff = float(coarse.max()) + CUTOFF_MARGIN_DEG + max(min_clearance_deg, 0.0)
        matters = np.minimum(el[:-1], el[1:]) < cutoff
    else:
        matters = np.zeros(n - 1, dtype=bool)
    td, azd, eld, rngd, orig, worst = densify(t, az, el, rng, matters)
    rho = np.degrees(np.arcsin(EARTH_RADIUS_KM / rngd))     # Earth's angular radius

    if terrain_info is not None:
        need = eld < cutoff
        fine_grid = np.arange(round(360 / FINE_DEG)) * FINE_DEG
        skyline = np.interp(fine_grid, coarse_az, coarse, period=360)
        bins = np.floor(azd[need] / FINE_DEG).astype(int)
        bins = np.unique(np.concatenate([bins - 1, bins, bins + 1, bins + 2]) % fine_grid.size)
        if bins.size:
            fine, fine_missing = terrain_horizon(m, root, lat, lon, obs.radius_m, fine_grid[bins], theta_max)
            skyline[bins] = fine
            missing += fine_missing
        if missing:
            warnings.append(f"{missing} terrain rays had missing heights; the skyline there may be too low.")
        horizon = np.interp(azd, fine_grid, skyline, period=360)
        unknown = ~np.isfinite(horizon)
        clearance = eld - horizon
        value = np.where(unknown, 0.0, clearance - min_clearance_deg)
        status = np.where(unknown, UNKNOWN, np.where(value >= 0, AVAILABLE, BLOCKED))
        limb = limb_angle(RADIUS_M + obs.ground_m, obs.radius_m)
        cause = np.where(status == BLOCKED, np.where(eld < limb, "lunar_limb", "terrain"), "")
        los = np.select([unknown, clearance >= rho, clearance <= -rho], ["unknown", "clear", "blocked"], "grazing")
        defined = ~unknown
        resolution = site_resolution_m(m, lat, lon)
        if resolution > 100:
            warnings.append(f"The site lies outside the high-resolution polar terrain; near-field terrain comes "
                            f"from a ~{resolution / 1000:.1f} km grid, so local ridges and crater rims can be missed.")
        model = {"type": "lola", "version": m.get("version"), "citation": m.get("citation"),
                 "site_resolution_m": round(resolution, 1),
                 "coarse_azimuth_step_deg": COARSE_DEG, "fine_azimuth_step_deg": FINE_DEG,
                 "max_range_km": round(theta_max * RADIUS_M / 1000, 1),
                 "limb_horizon_deg": round(limb, 4)}
        if include_skyline:
            model["skyline_1deg"] = [round(float(v), 4) for v in coarse]
    else:
        # Most favorable case: antenna as high and surrounding terrain as low as the Moon allows.
        top = obs.radius_m if obs.altitude_reference == "sphere" else RADIUS_M + LUNAR_RELIEF_M[1] + obs.altitude_m
        lower = limb_angle(RADIUS_M + LUNAR_RELIEF_M[0], top)
        horizon, clearance = None, None
        value = eld - lower - min_clearance_deg
        status = np.where(value < 0, BLOCKED, UNKNOWN)
        cause = np.where(status == BLOCKED, "lunar_limb", "")
        los = np.where(eld <= lower - rho, "blocked", "unknown")
        defined = np.ones(len(td), dtype=bool)
        model = {"type": "smooth_sphere", "version": None, "citation": None,
                 "lowest_possible_horizon_deg": round(lower, 4)}
    if worst > SUBSTEP_DEG + 1e-9:
        warnings.append(f"Earth moved up to {worst:.3f} deg between refined track points; "
                        "use a smaller step_minutes for finer terrain detail.")

    windows = build_windows(td, status, value, defined, cause, clearance, period_s)
    min_window_s = criteria.get("min_window_minutes", 0.0) * 60
    pessimistic = contact_metrics(windows, period_s, min_window_s, {AVAILABLE})
    optimistic = contact_metrics(windows, period_s, min_window_s, {AVAILABLE, UNKNOWN})
    hours = {s: sum(w["end_s"] - w["start_s"] for w in windows if w["status"] == s) / 3600
             for s in (AVAILABLE, BLOCKED, UNKNOWN)}
    summary = {
        "available_hours": _r(hours[AVAILABLE]), "available_fraction": _r(hours[AVAILABLE] * 3600 / period_s),
        "blocked_hours": _r(hours[BLOCKED]), "unknown_hours": _r(hours[UNKNOWN]),
        **{f"{s}_windows": sum(w["status"] == s for w in windows) for s in (AVAILABLE, BLOCKED, UNKNOWN)},
        **{k: (v if isinstance(v, int) else _r(v)) for k, v in pessimistic.items()},
        "unknown_counted_as": "no_contact",
    }

    result = {
        "location": {
            "latitude_deg": lat, "longitude_deg": lon, "frame": "MOON_ME",
            "longitude_convention": "east-positive, -180 to 180",
            "ground_elevation_m": _r(obs.ground_m, 2),
            "observer_elevation_m": round(obs.height_m, 2),
            "altitude_m": obs.altitude_m, "altitude_reference": obs.altitude_reference,
            "reference_radius_m": RADIUS_M,
        },
        "period": {"start_utc": _iso(start, 0), "end_utc": _iso(start, period_s), "step_minutes": step_minutes,
                   "samples": n, "duration_hours": _r(period_s / 3600)},
        "target": {"type": "earth_center",
                   "note": "Earth's center as a geometric proxy, not a specific ground station."},
        "criteria": {"min_clearance_deg": min_clearance_deg, **criteria},
        "terrain_model": model,
        "resolution": {"ephemeris_step_minutes": step_minutes, "track_substep_deg": SUBSTEP_DEG,
                       "max_track_substep_deg": round(worst, 4), "crossing_time_rounding_s": 1},
        "summary": summary,
        "assessment": assess(criteria, pessimistic, optimistic),
        "rf": {"assessed": False, "link_available": None,
               "note": "Clear line of sight does not guarantee a radio link."},
        "windows": [{
            "status": w["status"], "start_utc": _iso(start, w["start_s"]), "end_utc": _iso(start, w["end_s"]),
            "duration_hours": _r((w["end_s"] - w["start_s"]) / 3600),
            "clipped_start": w["start_s"] == 0, "clipped_end": w["end_s"] == period_s,
            "min_clearance_deg": _r(w["min_clearance_deg"]), "max_clearance_deg": _r(w["max_clearance_deg"]),
            "causes": sorted(w["causes"]),
        } for w in windows],
        "warnings": warnings,
        "limitations": LIMITATIONS,
        "source": {"ephemeris": "JPL Horizons observer table, quantities 4 and 20, airless apparent",
                   "url": "https://ssd.jpl.nasa.gov/api/horizons.api", "target": "399 (Earth)",
                   "terrain": model.get("citation")},
    }
    if include_samples:
        result["samples"] = [{
            "time_utc": _iso(start, td[k]), "azimuth_deg": _r(azd[k]), "elevation_deg": _r(eld[k]),
            "earth_radius_deg": _r(rho[k]),
            "horizon_deg": None if horizon is None else _r(horizon[k]),
            "clearance_deg": None if clearance is None else _r(clearance[k]),
            "los": str(los[k]), "status": str(status[k]), "cause": str(cause[k]) or None,
        } for k in orig if td[k] <= period_s]
    return result
