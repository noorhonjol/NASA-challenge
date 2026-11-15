"""Sun and Earth geometry for many lunar surface points: sunlight, irradiance, Earth clearance.

Merged from the lunar_sun prototype onto this backend's Horizons client and LOLA terrain.
Pure computation; the router fetches Horizons series and passes them in.

- One Horizons series per body at a reference site gives azimuth, elevation and range.
  The body's position in the Moon-fixed frame is rebuilt as site + direction x range and
  then viewed from every point, so parallax across a region is included.
- Each point gets one terrain skyline at ground level (the same LOLA ray casting as
  /api/earth-link) and a local surface normal from finite differences of LOLA heights.
- Angles are relative to the local horizontal plane (perpendicular to the radius), the
  plane Horizons uses for azimuth and elevation.
"""
from dataclasses import dataclass, field

import numpy as np

from . import terrain
from .earth_link import TERRAIN_ERRORS, site_resolution_m
from .horizon_profile import RADIUS_M, destinations, max_angle, terrain_horizon

AU_KM = 149597870.7
S0 = 1361.0                  # W/m^2 at 1 AU (TSIS-1)
R_SUN_KM = 695700.0
R_EARTH_KM = 6378.137
SUNLIT = 0.5                 # visible-disc fraction counted as "Sun up" for events and durations
DARK = 0.01                  # visible-disc fraction below which a step counts as dark
LAT_LIMIT = 89.9999          # Horizons azimuth is undefined at the exact pole


def enu_basis(lat_deg, lon_deg):
    """East, north, up unit vectors in the Moon-fixed frame, shape (..., 3)."""
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    east = np.stack([-np.sin(lo), np.cos(lo), np.zeros_like(lo)], -1)
    north = np.stack([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)], -1)
    up = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)
    return east, north, up


def body_positions(ref_lat, ref_lon, ref_radius_m, series) -> np.ndarray:
    """Body positions (T, 3) in km, Moon-fixed, from a Horizons series seen at the reference site."""
    az = np.radians([row[1] for row in series])
    el = np.radians([row[2] for row in series])
    km = np.array([row[3] for row in series], dtype=float)
    east, north, up = enu_basis(ref_lat, ref_lon)
    direction = (np.cos(el) * np.sin(az))[:, None] * east + (np.cos(el) * np.cos(az))[:, None] * north \
        + np.sin(el)[:, None] * up
    return up * ref_radius_m / 1000 + direction * km[:, None]


def reference_site(lat, lon) -> tuple[float, float]:
    """Point nearest the centroid of the sites (mean unit vector), latitude kept off the exact pole."""
    _, _, up = enu_basis(np.asarray(lat, float), np.asarray(lon, float))
    mean = up.reshape(-1, 3).mean(0)
    ref_lat = float(np.degrees(np.arctan2(mean[2], np.hypot(mean[0], mean[1]))))
    ref_lon = float(np.degrees(np.arctan2(mean[1], mean[0])))
    return min(max(ref_lat, -LAT_LIMIT), LAT_LIMIT), ref_lon


@dataclass
class Sites:
    lat: np.ndarray
    lon: np.ndarray
    ground_m: np.ndarray                  # height above the 1,737.4 km sphere (0 without terrain)
    skyline: np.ndarray                   # (P, N) terrain horizon elevation, deg
    azimuth_step_deg: float
    normal: np.ndarray                    # (P, 3) local surface normal in east/north/up
    terrain_model: dict
    warnings: list[str] = field(default_factory=list)

    @property
    def slope_deg(self):
        return np.degrees(np.arccos(np.clip(self.normal[:, 2], -1, 1)))

    @property
    def aspect_deg(self):
        return np.degrees(np.arctan2(self.normal[:, 0], self.normal[:, 1])) % 360


def _smooth_sphere(lat, lon, azimuths, reason) -> Sites:
    p = len(lat)
    normal = np.zeros((p, 3))
    normal[:, 2] = 1
    return Sites(lat, lon, np.zeros(p), np.zeros((p, len(azimuths))), 360 / len(azimuths), normal,
                 {"type": "smooth_sphere", "citation": None},
                 [f"Terrain unavailable ({reason}); a smooth sphere was used, so terrain shadows and "
                  "slopes are missing and sunlight and Earth visibility are overstated."])


def prepare_sites(lat, lon, azimuth_step_deg: float) -> Sites:
    """Ground height, skyline and surface normal for each point (P,) from the local LOLA terrain."""
    lat, lon = np.atleast_1d(np.asarray(lat, float)), np.atleast_1d(np.asarray(lon, float))
    azimuths = np.arange(0, 360, azimuth_step_deg)
    try:
        m, root = terrain.manifest(), terrain.data_root()
        if m["reference_radius_m"] != RADIUS_M:
            raise terrain.TerrainUnavailable("unexpected reference radius")
        ground = np.asarray(terrain.sample_heights(m, root, lat, lon), float)
        if not np.isfinite(ground).all():
            raise terrain.TerrainUnavailable("no height at some points")
    except TERRAIN_ERRORS as exc:
        return _smooth_sphere(lat, lon, azimuths, exc)

    relief = [m["baseline"]["min_elevation_m"], m["baseline"]["max_elevation_m"]]
    relief += [v for r in m["regions"] for v in (r["min_elevation_m"], r["max_elevation_m"])]
    r_min, r_max = RADIUS_M + min(relief), RADIUS_M + max(relief)
    warnings = []
    skyline = np.empty((len(lat), len(azimuths)))
    missing = 0
    resolution = np.array([site_resolution_m(m, a, b) for a, b in zip(lat, lon)])
    probe_lat, probe_lon = [], []
    for i, (a, b) in enumerate(zip(lat, lon)):
        r_o = RADIUS_M + ground[i]
        skyline[i], miss = terrain_horizon(m, root, a, b, r_o, azimuths, max_angle(r_o, r_min, r_max))
        missing += miss
        # Height probes east, west, north, south at one grid spacing for the surface normal.
        pl, po = destinations(a, b, np.array([90.0, 270.0, 0.0, 180.0]), resolution[i] / RADIUS_M)
        probe_lat.append(pl)
        probe_lon.append(po)
    if not np.isfinite(skyline).all():
        warnings.append("Some skyline directions had no terrain heights; a level horizon was used there.")
        skyline = np.where(np.isfinite(skyline), skyline, 0.0)
    if missing:
        warnings.append(f"{missing} terrain rays had missing heights; the skyline there may be too low.")
    probes = np.asarray(terrain.sample_heights(m, root, np.array(probe_lat), np.array(probe_lon)), float)
    d = 2 * resolution
    n = np.stack([-(probes[:, 0] - probes[:, 1]) / d, -(probes[:, 2] - probes[:, 3]) / d, np.ones(len(lat))], -1)
    n = np.where(np.isfinite(n).all(-1, keepdims=True), n, [0.0, 0.0, 1.0])
    normal = n / np.linalg.norm(n, axis=-1, keepdims=True)
    coarse = resolution > 100
    if coarse.any():
        warnings.append(f"{int(coarse.sum())} of {len(lat)} points lie outside the high-resolution polar terrain; "
                        f"there the terrain comes from a ~{resolution.max() / 1000:.1f} km grid, so local ridges, "
                        "crater rims and slopes can be missed.")
    model = {"type": "lola", "version": m.get("version"), "citation": m.get("citation"),
             "site_resolution_m": sorted({round(float(v), 1) for v in resolution}),
             "azimuth_step_deg": azimuth_step_deg,
             "max_range_km": round(max_angle(RADIUS_M + float(ground.min()), r_min, r_max) * RADIUS_M / 1000, 1)}
    return Sites(lat, lon, ground, skyline, azimuth_step_deg, normal, model, warnings)


def look(sites: Sites, position_km: np.ndarray):
    """Azimuth, elevation (deg), distance (km) and east/north/up direction of a body, each (P, T)."""
    east, north, up = enu_basis(sites.lat, sites.lon)
    site = up * ((RADIUS_M + sites.ground_m) / 1000)[:, None]
    v = position_km[None] - site[:, None]
    dist = np.linalg.norm(v, axis=-1)
    s = v / dist[..., None]
    se, sn, su = (np.einsum("ptk,pk->pt", s, b) for b in (east, north, up))
    el = np.degrees(np.arcsin(np.clip(su, -1, 1)))
    az = np.degrees(np.arctan2(se, sn)) % 360
    return az, el, dist, (se, sn, su)


def horizon_at(skyline: np.ndarray, az: np.ndarray, step_deg: float) -> np.ndarray:
    """Skyline (P, N) interpolated periodically at azimuths (P, T)."""
    n = skyline.shape[1]
    x = (az % 360) / step_deg
    i0 = np.floor(x).astype(int) % n
    f = x - np.floor(x)
    return np.take_along_axis(skyline, i0, -1) * (1 - f) + np.take_along_axis(skyline, (i0 + 1) % n, -1) * f


def visible_fraction(el, horizon, angular_radius):
    """Fraction of a disc above a straight horizon line (circular-segment area)."""
    x = np.clip((el - horizon) / angular_radius, -1, 1)
    return (np.arccos(-x) + x * np.sqrt(1 - x * x)) / np.pi


def illumination(sites: Sites, sun_km: np.ndarray) -> dict:
    """Sun geometry and irradiance (W/m^2), each (P, T)."""
    az, el, dist, (se, sn, su) = look(sites, sun_km)
    ang = np.degrees(np.arctan(R_SUN_KM / dist))
    horizon = horizon_at(sites.skyline, az, sites.azimuth_step_deg)
    frac = visible_fraction(el, horizon, ang)
    s_au = S0 * (AU_KM / dist) ** 2
    dni = s_au * frac
    nrm = sites.normal
    cos_i = se * nrm[:, None, 0] + sn * nrm[:, None, 1] + su * nrm[:, None, 2]
    return {"az": az, "el": el, "horizon": horizon, "frac": frac, "ang": ang, "dist_au": dist / AU_KM,
            "s_au": s_au, "dni": dni, "horizontal": dni * np.clip(su, 0, None),
            "on_slope": dni * np.clip(cos_i, 0, None), "incidence": np.degrees(np.arccos(np.clip(cos_i, -1, 1)))}


def earth_clearance(sites: Sites, earth_km: np.ndarray) -> np.ndarray:
    """Earth-center elevation above the terrain skyline (deg), (P, T)."""
    az, el, _, _ = look(sites, earth_km)
    return el - horizon_at(sites.skyline, az, sites.azimuth_step_deg)


def sun_state(el, horizon, ang, frac) -> str:
    if frac >= 0.999:
        return "full_sun"
    if frac > 0.001:
        return "partial_sun"
    return "terrain_shadow" if el > -ang else "night"
