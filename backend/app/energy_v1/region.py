import math
import numpy as np
from shapely.geometry import Polygon
from shapely.validation import explain_validity
from .schemas import Location, METRICS
from .solar import series, integrate
from .terrain import R
from .power import runs
from .errors import EnergyError

LIMIT = 2000000
LEVELS = [
    5,
    10,
    20,
    40,
    80,
    160,
    240,
    480,
    960,
    1920,
    3840,
    7680,
    15360,
    30720,
    61440,
    122880,
]


def make_grid(request):
    area = request.area
    if area.type == "circle":
        center_lat, center_lon = area.center.lat, area.center.lon
    elif area.type == "bbox":
        center_lat = (area.min_lat + area.max_lat) / 2
        width = (area.max_lon - area.min_lon) % 360
        if area.max_lon - area.min_lon == 360:
            width = 360
        if width == 0:
            raise EnergyError(
                "INVALID_PARAMETER",
                "bbox longitude span must be below 360 degrees",
                "area",
            )
        center_lon = (area.min_lon + width / 2 + 180) % 360 - 180
    else:
        center_lat = float(np.mean([p[0] for p in area.coordinates]))
        angles = np.radians([p[1] for p in area.coordinates])
        center_lon = float(
            np.degrees(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean()))
        )
    polar = abs(center_lat) >= 70
    sign = 1 if center_lat >= 0 else -1

    def forward(lat, lon):
        lat, lon = np.asarray(lat), np.asarray(lon)
        if polar:
            rho = 2 * R * np.tan(np.pi / 4 - sign * np.radians(lat) / 2)
            a = np.radians(lon)
            return rho * np.sin(a), -sign * rho * np.cos(a)
        return R * np.radians((lon - center_lon + 180) % 360 - 180) * np.cos(
            np.radians(center_lat)
        ), R * np.radians(lat - center_lat)

    def inverse(x, y):
        if polar:
            rho = np.hypot(x, y)
            lat = sign * np.degrees(np.pi / 2 - 2 * np.arctan(rho / (2 * R)))
            lon = np.degrees(np.arctan2(x, -sign * y))
            return lat, lon
        lat = center_lat + np.degrees(y / R)
        lon = (
            center_lon + np.degrees(x / (R * np.cos(np.radians(center_lat)))) + 180
        ) % 360 - 180
        return lat, lon

    if area.type == "circle":
        # A circle is defined geodesically, not by an uncorrected projected radius.
        p, l = np.radians([center_lat, center_lon])
        d = area.radius_m / R
        b = np.linspace(0, 2 * np.pi, 361)
        lat = np.arcsin(np.sin(p) * np.cos(d) + np.cos(p) * np.sin(d) * np.cos(b))
        lon = l + np.arctan2(
            np.sin(b) * np.sin(d) * np.cos(p), np.cos(d) - np.sin(p) * np.sin(lat)
        )
        x, y = forward(np.degrees(lat), np.degrees(lon))
        shape = Polygon(zip(x, y))
    elif area.type == "bbox":
        west = area.min_lon
        span = (area.max_lon - west) % 360
        if area.max_lon - west == 360:
            span = 360
        east = west + span
        lat = np.r_[
            np.full(65, area.min_lat),
            np.linspace(area.min_lat, area.max_lat, 65),
            np.full(65, area.max_lat),
            np.linspace(area.max_lat, area.min_lat, 65),
        ]
        lon = np.r_[
            np.linspace(west, east, 65),
            np.full(65, east),
            np.linspace(east, west, 65),
            np.full(65, west),
        ]
        x, y = forward(lat, lon)
        shape = Polygon(zip(x, y))
        if span == 360 and polar:
            outer_lat = area.min_lat if sign > 0 else area.max_lat
            inner_lat = area.max_lat if sign > 0 else area.min_lat
            ox, oy = forward(np.full(361, outer_lat), np.linspace(-180, 180, 361))
            ix, iy = forward(np.full(361, inner_lat), np.linspace(-180, 180, 361))
            shape = Polygon(
                zip(ox, oy), [list(zip(ix, iy))] if abs(inner_lat) < 90 else []
            )
    else:
        x, y = forward(*np.array(area.coordinates).T)
        shape = Polygon(zip(x, y))
    if shape.is_empty or not shape.is_valid or shape.area <= 0:
        raise EnergyError(
            "INVALID_PARAMETER", f"Invalid area: {explain_validity(shape)}", "area"
        )
    minimum = 5 if center_lat <= -87 else np.pi * R / (180 * 16)
    resolution = next(
        (level for level in LEVELS if level >= max(minimum, request.resolution_m)), None
    )
    if resolution is None:
        raise EnergyError(
            "INVALID_PARAMETER",
            "Requested resolution exceeds available analysis levels",
            "resolution_m",
        )
    left, bottom, right, top = shape.bounds
    # Cell centers are anchored to the projected origin, stable across adjacent requests.
    left = math.floor(left / resolution) * resolution
    top = math.ceil(top / resolution) * resolution
    cols = max(1, math.ceil((right - left) / resolution))
    rows = max(1, math.ceil((top - bottom) / resolution))
    samples = len(request.period.times())
    if rows * cols * samples > LIMIT:
        suggested = resolution * math.sqrt(rows * cols * samples / LIMIT)
        raise EnergyError(
            "REQUEST_TOO_LARGE",
            f"Grid requires {rows*cols*samples} cell samples; use resolution_m >= {math.ceil(suggested)} or increase step_hours",
            status=413,
        )
    xx, yy = np.meshgrid(
        left + (np.arange(cols) + 0.5) * resolution,
        top - (np.arange(rows) + 0.5) * resolution,
    )
    lat, lon = inverse(xx, yy)
    import shapely

    mask = shapely.intersects_xy(shape, xx, yy) & (lat >= -90) & (lat <= 90)
    if not mask.any():
        raise EnergyError(
            "OUT_OF_COVERAGE",
            "Area contains no cell centers at the snapped resolution; enlarge area or reduce resolution",
            status=404,
        )
    return (
        lat,
        lon,
        mask,
        resolution,
        (
            ("polar_stereographic_north" if sign > 0 else "polar_stereographic_south")
            if polar
            else "local_equidistant_cylindrical"
        ),
    )


def region(request):
    lat, lon, mask, resolution, projection = make_grid(request)
    times = request.period.times()
    shape = lat.shape
    values = {name: np.full(shape, np.nan) for name in request.metrics}
    products = set()
    ts_flux = (
        np.full((len(times), *shape), np.nan) if request.include_timeseries else None
    )
    ts_visible = (
        np.full((len(times), *shape), np.nan) if request.include_timeseries else None
    )
    for row, col in zip(*np.where(mask)):
        s = series(
            Location(
                lat=float(lat[row, col]),
                lon=float(lon[row, col]),
                height_m=request.height_m,
            ),
            times,
        )
        products.add(s["product"])
        f = s["visible_fraction"]
        lit = f > 0
        irr = s[request.panel_mode]
        dark = runs(~lit[:-1], times)
        metrics = {
            "illumination_pct": float(lit.mean() * 100),
            "mean_visible_fraction": float(f.mean()),
            "mean_irradiance": float(irr.mean()),
            "peak_irradiance": float(irr.max()),
            "total_energy": integrate(irr, times),
            "max_darkness_hours": max([d[2] for d in dark], default=0.0),
            "mean_sun_elevation": (
                float(s["sun_elevation"][lit].mean()) if lit.any() else None
            ),
            "earth_visibility_pct": float(s["earth_visible"].mean() * 100),
            "mean_slope": s["location"]["slope_deg"],
        }
        for key in request.metrics:
            values[key][row, col] = metrics[key] if metrics[key] is not None else np.nan
        if ts_flux is not None:
            ts_flux[:, row, col] = irr
            ts_visible[:, row, col] = f

    def nullable(array):
        return np.where(np.isfinite(array), array.astype(object), None).tolist()

    output = {}
    for key, array in values.items():
        valid = array[np.isfinite(array)]
        output[key] = {
            "unit": METRICS[key],
            "min": float(valid.min()) if valid.size else None,
            "max": float(valid.max()) if valid.size else None,
            "mean": float(valid.mean()) if valid.size else None,
            "values": nullable(array),
        }
    first = request.metrics[0]
    ranking = []
    for row, col in zip(*np.where(mask & np.isfinite(values[first]))):
        ranking.append(
            {
                "row": int(row),
                "col": int(col),
                "lat": float(lat[row, col]),
                "lon": float(lon[row, col]),
                "value": float(values[first][row, col]),
            }
        )
    ranking.sort(
        key=lambda v: (
            v["value"] if first == "max_darkness_hours" else -v["value"],
            v["row"],
            v["col"],
        )
    )
    return {
        "grid": {
            "rows": shape[0],
            "cols": shape[1],
            "resolution_m": resolution,
            "projection": projection,
            "lat": nullable(np.where(mask, lat, np.nan)),
            "lon": nullable(np.where(mask, lon, np.nan)),
            "mask": mask.tolist(),
        },
        "period": {**request.period.model_dump(mode="json"), "samples": len(times)},
        "metrics": output,
        "ranking": {"by": first, "top": ranking[:10]},
        "timeseries": (
            {
                "times": [t.isoformat() for t in times],
                "irradiance": nullable(ts_flux),
                "visible_fraction": nullable(ts_visible),
            }
            if ts_flux is not None
            else None
        ),
        "_products": sorted(products),
    }
