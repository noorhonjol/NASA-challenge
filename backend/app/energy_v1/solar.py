import numpy as np
from . import ephemeris
from .terrain import get_surface, basis, R

AU = 149597870700.0


def disk_fraction(clearance):
    q = np.clip(np.asarray(clearance) / 0.265, -1, 1)
    return (np.arccos(-q) + q * np.sqrt(np.maximum(0, 1 - q * q))) / np.pi


def project(elevation, azimuth, tilt, az):
    e, a, t, b = (
        np.radians(elevation),
        np.radians(azimuth),
        np.radians(tilt),
        np.radians(az),
    )
    return np.maximum(0, np.sin(e) * np.cos(t) + np.cos(e) * np.sin(t) * np.cos(a - b))


def series(location, times):
    terrain = get_surface()
    enriched, normal = terrain.location(location)
    horizons = terrain.horizons(location, enriched["elevation_m"])
    e, n, u = basis(location.lat, location.lon)
    observer = u * (R + enriched["elevation_m"] + location.height_m)
    positions = np.array([ephemeris.vectors(t.isoformat()) for t in times]) - observer
    local = positions @ np.array([e, n, u]).T
    distance = np.linalg.norm(local, axis=2)
    angles = np.degrees(np.arcsin(np.clip(local[:, :, 2] / distance, -1, 1)))
    azimuth = np.degrees(np.arctan2(local[:, :, 0], local[:, :, 1])) % 360
    h = np.array(
        [
            np.interp(azimuth[:, i], np.arange(361), np.r_[horizons, horizons[0]])
            for i in range(2)
        ]
    ).T
    fraction = disk_fraction(angles[:, 0] - h[:, 0])
    beam = 1361 / (distance[:, 0] / AU) ** 2
    full = beam * fraction
    incidence = np.degrees(
        np.arccos(np.clip((local[:, 0, :] / distance[:, 0, None]) @ normal, -1, 1))
    )
    return {
        "location": enriched,
        "product": terrain.product(location.lat),
        "times": times,
        "sun_elevation": angles[:, 0],
        "sun_azimuth": azimuth[:, 0],
        "distance_au": distance[:, 0] / AU,
        "horizon": h[:, 0],
        "visible_fraction": fraction,
        "incidence": incidence,
        "earth_elevation": angles[:, 1],
        "earth_azimuth": azimuth[:, 1],
        "skyline": horizons,
        "earth_visible": angles[:, 1] > h[:, 1],
        "toa": beam,
        "full_tracking": full,
        "horizontal": full * np.maximum(0, np.sin(np.radians(angles[:, 0]))),
        "terrain": full * np.maximum(0, np.cos(np.radians(incidence))),
        "vertical_tracking": full * np.maximum(0, np.cos(np.radians(angles[:, 0]))),
    }


def flux(s, mode, tilt=None, azimuth=None):
    if mode == "fixed_horizontal":
        return s["horizontal"]
    if mode == "fixed_tilt":
        return s["full_tracking"] * project(
            s["sun_elevation"], s["sun_azimuth"], tilt, azimuth
        )
    return s[mode]


def integrate(values, times):
    return float(
        np.trapezoid(
            values, np.array([(t - times[0]).total_seconds() / 3600 for t in times])
        )
    )


def point(location, time, tilt=None, azimuth=None):
    s = series(location, [time])
    f = float(s["visible_fraction"][0])
    return {
        "location": s["location"],
        "time": time.isoformat(),
        "sun": {
            "elevation_deg": float(s["sun_elevation"][0]),
            "azimuth_deg": float(s["sun_azimuth"][0]),
            "distance_au": float(s["distance_au"][0]),
            "horizon_elevation_deg": float(s["horizon"][0]),
            "visible_fraction": f,
            "is_illuminated": f > 0,
            "incidence_angle_deg": float(s["incidence"][0]),
        },
        "irradiance": {
            **{
                out: float(s[key][0])
                for out, key in [
                    ("toa_w_m2", "toa"),
                    ("horizontal_w_m2", "horizontal"),
                    ("terrain_w_m2", "terrain"),
                    ("vertical_tracking_w_m2", "vertical_tracking"),
                    ("full_tracking_w_m2", "full_tracking"),
                ]
            },
            "custom_panel_w_m2": (
                float(flux(s, "fixed_tilt", tilt, azimuth)[0])
                if tilt is not None
                else None
            ),
        },
        "earth": {
            "elevation_deg": float(s["earth_elevation"][0]),
            "is_visible": bool(s["earth_visible"][0]),
        },
        "_products": [s["product"]],
    }
