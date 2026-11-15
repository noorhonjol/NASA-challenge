"""Terrain skyline from a lunar observer: spherical Moon, LOLA heights, antenna height.

Angles are elevations above the observer's local horizontal plane (perpendicular to
the radius through the observer), the same plane JPL Horizons uses for azimuth/elevation.
"""
from functools import lru_cache

import numpy as np

from . import terrain

RADIUS_M = 1737400.0


def destinations(lat_deg, lon_deg, az_deg, theta):
    """Points at central angle `theta` (rad) from the site along azimuth `az_deg` (deg, from north via east).

    Vector great-circle form; stable near the poles. Returns (lat_deg, lon_deg) broadcast over az/theta.
    """
    phi, lam = np.radians(lat_deg), np.radians(lon_deg)
    p = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
    north = np.array([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
    east = np.array([-np.sin(lam), np.cos(lam), 0.0])
    az, theta = np.broadcast_arrays(np.radians(np.asarray(az_deg, dtype=float)), np.asarray(theta, dtype=float))
    az, theta = az[..., None], theta[..., None]
    u = np.cos(az) * north + np.sin(az) * east          # (..., 3)
    q = np.cos(theta) * p + np.sin(theta) * u
    return np.degrees(np.arcsin(np.clip(q[..., 2], -1, 1))), np.degrees(np.arctan2(q[..., 1], q[..., 0]))


def max_angle(r_o, r_min, r_max):
    """Central angle beyond which no terrain (radius in [r_min, r_max]) can top the skyline.

    A sight line to anything farther passes below r_min, i.e. through solid Moon, so a
    nearer terrain point already shows a higher elevation angle.
    """
    return float(np.arccos(min(r_min / r_o, 1.0)) + np.arccos(min(r_min / r_max, 1.0)))


@lru_cache(maxsize=16)
def _distances(max_m: float):
    steps, d = [], 25.0
    while d < max_m:
        steps.append(d)
        d += min(max(0.005 * d, 25.0), 900.0)
    steps.append(max_m)
    return np.array(steps)


def distances(theta_max):
    """Central angles (rad) of ray samples: 25 m near the site growing 0.5 %/step to 900 m."""
    return _distances(round(theta_max * RADIUS_M, 1)) / RADIUS_M


def limb_angle(ground_r, r_o):
    """Horizon of a smooth sphere through the site's ground (always <= 0; defined below the datum too)."""
    return -float(np.degrees(np.arccos(min(ground_r / r_o, 1.0))))


def elevation_angles(r_o, r_t, theta):
    """Elevation (deg) of terrain at radius r_t and central angle theta seen from radius r_o."""
    return np.degrees(np.arctan2(r_t * np.cos(theta) - r_o, r_t * np.sin(theta)))


def terrain_horizon(m, root, lat_deg, lon_deg, r_o, azimuths, theta_max, chunk=200):
    """Skyline elevation (deg) per azimuth and the number of rays with missing heights.

    Rays are cast in chunks (~chunk x 1,200 samples per terrain call) to bound memory.
    A ray with any missing height is still returned from its valid samples, but counted.
    """
    azimuths = np.asarray(azimuths, dtype=float)
    theta = distances(theta_max)
    radius = m["reference_radius_m"]
    horizon = np.empty(len(azimuths))
    incomplete = 0
    for start in range(0, len(azimuths), chunk):
        az = azimuths[start:start + chunk]
        lat, lon = destinations(lat_deg, lon_deg, az[:, None], theta[None, :])
        heights = terrain.sample_heights(m, root, lat, lon)   # via module: tests monkeypatch it
        missing = ~np.isfinite(heights)
        incomplete += int(missing.any(axis=1).sum())
        angles = np.where(missing, -np.inf, elevation_angles(r_o, radius + np.nan_to_num(heights), theta[None, :]))
        horizon[start:start + chunk] = angles.max(axis=1)
    return horizon, incomplete
