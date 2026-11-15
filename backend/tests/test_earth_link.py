import json
import math
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import earth_link, horizon_profile as hp, terrain
from app.horizons import HorizonsError, earth_series, parse_series
from app.main import app

R = hp.RADIUS_M
START = datetime(2026, 11, 15, tzinfo=timezone.utc)


# ---------- helpers ----------

def unit(lat, lon):
    lat, lon = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)


def from_site(site_lat, site_lon, lat, lon):
    """Central angle (rad) and bearing (deg) of points as seen from the site."""
    p, q = unit(site_lat, site_lon), unit(lat, lon)
    phi, lam = np.radians(site_lat), np.radians(site_lon)
    north = np.array([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
    east = np.array([-np.sin(lam), np.cos(lam), 0.0])
    angle = np.arctan2(np.linalg.norm(np.cross(p, q), axis=-1), q @ p)
    return angle, np.degrees(np.arctan2(q @ east, q @ north)) % 360


def fake_terrain(site=(0.0, 0.0), base=0.0, features=()):
    """sample_heights replacement: flat `base` plus (az_center, az_halfwidth, d_min_m, d_max_m, height) blocks."""
    def sample(m, root, lat, lon):
        lat, lon = np.broadcast_arrays(np.asarray(lat, float), np.asarray(lon, float))
        angle, bearing = from_site(*site, lat, lon)
        d = angle * R
        h = np.full(lat.shape, base)
        for az, half, d0, d1, height in features:
            off = np.abs((bearing - az + 180) % 360 - 180)
            h = np.where((off <= half) & (d >= d0) & (d <= d1), base + height, h)
        return h
    return sample


def horizons_rows(times, az, el, km=384400.0):
    rows = "\n".join(f" {t.year}-{t.strftime('%b')}-{t.day:02d} {t.strftime('%H:%M:%S')}, , ,{a},{e},{km / 149597870.7},0.1,"
                     for t, a, e in zip(times, az, el))
    return f"header\n$$SOE\n{rows}\n$$EOE\nfooter"


def series(n, step_min, az, el, km=384400.0):
    az = np.broadcast_to(az, (n,)); el = np.broadcast_to(el, (n,))
    return [(START + timedelta(minutes=step_min * i), float(az[i]), float(el[i]), km) for i in range(n)]


@pytest.fixture
def manifest_dir(tmp_path, monkeypatch):
    """Manifest with a flat 100 m global grid, no regions, and relief bounds that cover the fake ridges."""
    np.full((2, 4), 200, dtype="<i2").tofile(tmp_path / "global.img")
    m = {"version": "fixture", "tile_size": 65, "reference_radius_m": 1737400, "citation": "test",
         "baseline": {"key": "g", "file": "global.img", "width": 4, "height": 2, "pixels_per_degree": 1 / 90,
                      "scale": .5, "source": "fixture", "min_elevation_m": 100, "max_elevation_m": 1100},
         "regions": []}
    (tmp_path / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    return m, tmp_path


# ---------- Horizons parsing ----------

def test_parses_series_with_and_without_fractional_seconds():
    rows = parse_series("$$SOE\n 2026-Nov-15 00:00:00.000, , ,10.5,-1.25,0.00257,0.1,\n"
                        " 2026-Dec-01 23:30:15, , ,359.9,2.5,0.00256,0.1,\n$$EOE")
    assert rows[0][0] == datetime(2026, 11, 15, tzinfo=timezone.utc)
    assert rows[1][0] == datetime(2026, 12, 1, 23, 30, 15, tzinfo=timezone.utc)
    assert rows[0][1:3] == (10.5, -1.25)
    assert rows[0][3] == pytest.approx(0.00257 * 149597870.7)


def test_parses_series_without_seconds():
    # Real Horizons output for a series starting at 06:30, despite TIME_DIGITS='SECONDS'.
    rows = parse_series("$$SOE\n 2027-Mar-10 06:30, ,i,  354.403103527,       9.993405720,  0.00259160738092, -0.0393995,\n$$EOE")
    assert rows[0][0] == datetime(2027, 3, 10, 6, 30, tzinfo=timezone.utc)
    assert rows[0][1:3] == (354.403103527, 9.993405720)


@pytest.mark.parametrize("result", [
    "no markers", "$$SOE\n$$EOE",
    "$$SOE\n 2026-Nov-15 00:00:00, , ,n.a.,n.a.,0.002,0.1,\n$$EOE",
    "$$SOE\n 2026-Xyz-15 00:00:00, , ,1,1,0.002,0.1,\n$$EOE",
    "$$SOE\n 2026-Nov-15 00:00:00, , ,1,1,n.a.,0.1,\n$$EOE",
])
def test_series_rejects_unusable_results(result):
    with pytest.raises(HorizonsError):
        parse_series(result)


def run(coro):
    import asyncio
    return asyncio.run(coro)


def test_earth_series_request_and_row_count(monkeypatch):
    seen = []

    async def fake_get(self, url, params):
        seen.append(params)
        times = [START + timedelta(minutes=30 * i) for i in range(3)]
        return httpx.Response(200, request=httpx.Request("GET", url),
                              json={"result": horizons_rows(times, [1, 2, 3], [0, 0, 0])})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    rows = run(earth_series(-89.5, 10.0, 1500.0, START, 30, 3))
    assert len(rows) == 3
    p = seen[0]
    assert p["COMMAND"] == "'399'" and p["STEP_SIZE"] == "'30 m'"
    assert p["START_TIME"] == "'2026-11-15 00:00:00'" and p["STOP_TIME"] == "'2026-11-15 01:00:00'"
    assert p["SITE_COORD"] == "'10.0,-89.5,1.5'"
    with pytest.raises(HorizonsError):
        run(earth_series(-89.5, 10.0, 1500.0, START, 30, 4))


# ---------- geometry ----------

def test_destinations_start_north_east_and_pole():
    lat, lon = hp.destinations(10, 20, np.array([33.0]), np.array([0.0]))
    assert lat[0] == pytest.approx(10) and lon[0] == pytest.approx(20)
    lat, _ = hp.destinations(0, 0, np.array([0.0]), np.array([0.01]))
    assert lat[0] == pytest.approx(np.degrees(0.01))
    lat, lon = hp.destinations(0, 0, np.array([90.0]), np.array([0.01]))
    assert lat[0] == pytest.approx(0, abs=1e-12) and lon[0] == pytest.approx(np.degrees(0.01))
    az = np.arange(0, 360, 30.0)
    lat, lon = hp.destinations(-89.9999, 45, az[:, None], np.array([0.0, 0.001, 0.05])[None, :])
    assert lat.shape == (12, 3) and np.isfinite(lat).all() and np.isfinite(lon).all()
    angle, bearing = from_site(-89.9999, 45, lat[:, 1:], lon[:, 1:])
    np.testing.assert_allclose(angle, np.broadcast_to([0.001, 0.05], angle.shape), rtol=1e-6)
    np.testing.assert_allclose((bearing[:, 0] - az + 180) % 360 - 180, 0, atol=1e-6)


def test_distances_cover_range_with_bounded_steps():
    theta = hp.distances(440e3 / R) * R
    steps = np.diff(theta)
    assert theta[0] == 25 and theta[-1] == pytest.approx(440e3)
    assert steps.min() > 0 and steps.max() <= 900 + 1e-6
    assert 1100 < theta.size < 1300


def test_max_angle_is_a_true_bound():
    r_o, r_min, r_max = R + 2, R - 500, R + 3000
    theta = hp.max_angle(r_o, r_min, r_max)
    limit = hp.limb_angle(r_min, r_o)          # sight line tangent to the lowest possible terrain
    assert hp.elevation_angles(r_o, r_max, theta) == pytest.approx(limit, abs=1e-9)
    assert hp.elevation_angles(r_o, r_max, theta * 1.01) < limit
    assert hp.max_angle(R + 100e3, R, R) > hp.max_angle(R + 2, R, R)


def horizon(monkeypatch, features=(), altitude=2.0, base=0.0, az=(0.0,), chunk=200):
    monkeypatch.setattr(terrain, "sample_heights", fake_terrain(base=base, features=features))
    m = {"reference_radius_m": R}
    r_o = R + base + altitude
    top = base + max([0.0, *(f[4] for f in features)])
    theta = hp.max_angle(r_o, R + base, R + top)
    return hp.terrain_horizon(m, None, 0.0, 0.0, r_o, np.array(az), theta, chunk=chunk)


def test_flat_terrain_gives_limb_dip(monkeypatch):
    h, missing = horizon(monkeypatch, az=(0.0, 90.0, 225.0))
    assert missing == 0
    np.testing.assert_allclose(h, hp.limb_angle(R, R + 2), atol=2e-3)
    assert h.max() <= hp.limb_angle(R, R + 2) + 1e-9


def test_ridge_at_5_km(monkeypatch):
    h, _ = horizon(monkeypatch, features=[(0, 5, 4990, 5010, 1000)])
    expected = hp.elevation_angles(R + 2, R + 1000, 5000 / R)
    assert h[0] == pytest.approx(expected, abs=1e-9)
    flat = math.degrees(math.atan(998 / 5000))
    assert flat - 0.12 < h[0] < flat - 0.05            # curvature lowers it by ~d/2R


def test_distant_peak_is_hidden_by_curvature(monkeypatch):
    h, _ = horizon(monkeypatch, features=[(0, 5, 199.5e3, 200.5e3, 1000)])
    assert h[0] < 0
    assert h[0] == pytest.approx(hp.limb_angle(R, R + 2), abs=2e-3)


def test_higher_altitude_gives_lower_horizon(monkeypatch):
    ridge = [(0, 5, 4990, 5010, 1000)]
    low, _ = horizon(monkeypatch, features=ridge, altitude=2)
    high, _ = horizon(monkeypatch, features=ridge, altitude=500)
    flat_low, _ = horizon(monkeypatch, altitude=2)
    flat_high, _ = horizon(monkeypatch, altitude=10000)
    assert high[0] < low[0] and flat_high[0] < flat_low[0]


def test_chunked_equals_unchunked(monkeypatch):
    feats = [(30, 10, 3000, 3400, 700), (200, 20, 20e3, 25e3, 2500), (350, 3, 500, 600, 50)]
    az = np.arange(0, 360, 7.0)
    a, _ = horizon(monkeypatch, features=feats, az=az, chunk=200)
    b, _ = horizon(monkeypatch, features=feats, az=az, chunk=7)
    np.testing.assert_array_equal(a, b)


def test_missing_heights_are_counted(monkeypatch):
    def sample(m, root, lat, lon):
        h = np.zeros(np.broadcast(lat, lon).shape)
        h[0, 5] = np.nan
        return h
    monkeypatch.setattr(terrain, "sample_heights", sample)
    _, missing = hp.terrain_horizon({"reference_radius_m": R}, None, 0, 0, R + 2, np.array([0.0, 90.0]), 0.01)
    assert missing == 1


# ---------- track refinement and windows ----------

def test_densify_wraps_through_north():
    t = np.array([0.0, 1800.0])
    td, azd, eld, _, orig, worst = earth_link.densify(t, np.array([359.9, 0.1]), np.zeros(2), np.ones(2), np.array([True]))
    assert len(td) == 5 and list(orig) == [0, 4]
    assert all(a > 359.8 or a < 0.2 for a in azd)
    assert worst == pytest.approx(0.05)


def test_build_windows_interpolates_and_tiles_the_period():
    t = np.array([0.0, 3600, 7200, 10800])
    value = np.array([1.0, -1.0, -3.0, 1.0])
    status = np.where(value >= 0, "available", "blocked")
    cause = np.where(status == "blocked", "terrain", "")
    w = earth_link.build_windows(t, status, value, np.ones(4, bool), cause, value, 10000)
    assert [x["status"] for x in w] == ["available", "blocked", "available"]
    assert w[0]["start_s"] == 0 and w[0]["end_s"] == 1800
    assert w[1]["end_s"] == 7200 + 2700
    assert w[-1]["end_s"] == 10000
    assert all(a["end_s"] == b["start_s"] for a, b in zip(w, w[1:]))
    assert w[1]["causes"] == {"terrain"} and w[1]["min_clearance_deg"] == -3


def test_zero_length_window_is_dropped_and_neighbors_merge():
    t = np.array([0.0, 60, 120])
    value = np.array([-1.0, 0.0, -1.0])
    status = np.where(value >= 0, "available", "blocked")
    w = earth_link.build_windows(t, status, value, np.ones(3, bool), np.full(3, "terrain"), value, 120)
    assert len(w) == 1 and w[0]["status"] == "blocked" and w[0]["end_s"] == 120


def test_contact_metrics_with_minimum_window_and_edge_gaps():
    w = [{"status": s, "start_s": a, "end_s": b} for s, a, b in [
        ("blocked", 0, 3600), ("available", 3600, 3660), ("blocked", 3660, 7200),
        ("available", 7200, 14400), ("unknown", 14400, 18000)]]
    m = earth_link.contact_metrics(w, 18000, 600, {"available"})
    assert m["usable_windows"] == 1
    assert m["first_contact_after_hours"] == 2
    assert m["longest_blackout_hours"] == 2       # 0..7200 and 14400..18000 (1 h)
    o = earth_link.contact_metrics(w, 18000, 600, {"available", "unknown"})
    assert o["longest_usable_window_hours"] == 3


def test_assessment_states():
    good = {"usable_fraction": .8, "longest_blackout_hours": 5, "first_contact_after_hours": 0}
    bad = {"usable_fraction": .2, "longest_blackout_hours": 50, "first_contact_after_hours": None}
    assert earth_link.assess({}, good, good)["status"] == "criteria_not_specified"
    assert earth_link.assess({"max_blackout_hours": 10}, good, good)["status"] == "pass"
    assert earth_link.assess({"max_first_contact_hours": 1}, bad, bad)["status"] == "fail"
    assert earth_link.assess({"min_availability_fraction": .5}, bad, good)["status"] == "inconclusive"


def observer_flat(monkeypatch, manifest_dir, features=(), lat=0.0, lon=0.0, altitude=2.0, reference="ground"):
    monkeypatch.setattr(terrain, "sample_heights", fake_terrain(site=(lat, lon), base=100.0, features=features))
    return earth_link.observer(lat, lon, altitude, reference)


def test_compute_causes_terrain_vs_lunar_limb(monkeypatch, manifest_dir):
    obs = observer_flat(monkeypatch, manifest_dir, features=[(0, 5, 4990, 5010, 1000)])
    assert obs.ground_m == 100 and obs.radius_m == R + 102
    # Earth at az 180 (clear), then az 0 behind the ridge, then below the limb.
    az = [180, 180, 0, 0, 0, 0]
    el = [5, 5, 5, 5, -3, -3]
    out = earth_link.compute(obs, series(6, 60, az, el), START, START + timedelta(hours=5), 60)
    blocked = [w for w in out["windows"] if w["status"] == "blocked"]
    assert out["terrain_model"]["type"] == "lola"
    assert {c for w in blocked for c in w["causes"]} == {"terrain", "lunar_limb"}
    assert out["windows"][0]["status"] == "available" and out["windows"][0]["clipped_start"]
    assert out["windows"][-1]["clipped_end"] and out["windows"][-1]["end_utc"] == "2026-11-15T05:00:00Z"
    assert out["rf"]["assessed"] is False


def test_compute_ridge_across_north_wrap(monkeypatch, manifest_dir):
    obs = observer_flat(monkeypatch, manifest_dir, features=[(0, 0.3, 4990, 5010, 1000)])
    az = [358.0, 359.5, 0.5, 2.0]
    out = earth_link.compute(obs, series(4, 60, az, 3.0), START, START + timedelta(hours=3), 60,
                             include_samples=True)
    assert [w["status"] for w in out["windows"]] == ["available", "blocked", "available"]
    blocked = out["windows"][1]
    assert blocked["causes"] == ["terrain"]
    assert 0.2 < blocked["duration_hours"] < 1.0        # only the narrow ridge around north
    assert [s["status"] for s in out["samples"]] == ["available", "available", "available", "available"]


def test_compute_grazing_and_partial_last_step(monkeypatch, manifest_dir):
    obs = observer_flat(monkeypatch, manifest_dir)
    limb = hp.limb_angle(R + 100, R + 102)
    out = earth_link.compute(obs, series(3, 60, 90.0, limb + 0.3), START, START + timedelta(minutes=90), 60,
                             include_samples=True)
    assert out["period"]["samples"] == 3 and len(out["samples"]) == 2     # third sample is after end
    assert out["samples"][0]["los"] == "grazing" and out["samples"][0]["status"] == "available"
    assert out["windows"] == [out["windows"][0]] and out["windows"][0]["duration_hours"] == 1.5
    strict = earth_link.compute(obs, series(3, 60, 90.0, limb + 0.3), START, START + timedelta(minutes=90), 60,
                                min_clearance_deg=0.95)
    assert strict["windows"][0]["status"] == "blocked"


def test_compute_without_terrain_reports_unknown_not_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    obs = earth_link.observer(0.0, 0.0, 2.0, "ground")
    assert obs.terrain is None and obs.ground_m is None
    out = earth_link.compute(obs, series(3, 60, 0.0, [80, 80, -60]), START, START + timedelta(hours=2), 60,
                             criteria={"max_blackout_hours": 1.5})
    assert out["terrain_model"]["type"] == "smooth_sphere"
    assert [w["status"] for w in out["windows"]] == ["unknown", "blocked"]
    assert out["windows"][1]["causes"] == ["lunar_limb"]
    assert out["assessment"]["status"] == "inconclusive"
    assert any("Terrain unavailable" in w for w in out["warnings"])


# ---------- endpoint ----------

def fake_horizons(monkeypatch, el_fn, az_fn=lambda t: 180.0, seen=None):
    async def fake_get(self, url, params):
        if seen is not None:
            seen.append(params)
        start = datetime.strptime(params["START_TIME"].strip("'"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        stop = datetime.strptime(params["STOP_TIME"].strip("'"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        step = int(params["STEP_SIZE"].strip("'").split()[0])
        times = [start + timedelta(minutes=step * i) for i in range(int((stop - start).total_seconds() // 60 // step) + 1)]
        hours = [(t - START).total_seconds() / 3600 for t in times]
        return httpx.Response(200, request=httpx.Request("GET", url),
                              json={"result": horizons_rows(times, [az_fn(h) for h in hours], [el_fn(h) for h in hours])})
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)


BASE = "/api/earth-link?lat=0&lon=0&start=2026-11-15T00:00:00Z"


@pytest.mark.parametrize("query", [
    "lat=0&lon=0&start=2026-11-15T00:00:00&end=2026-11-16T00:00:00Z",
    "lat=0&lon=0&start=2026-11-15T00:00:00Z&end=2026-11-15T00:00:00Z",
    "lat=0&lon=0&start=2026-11-15T00:00:00Z&end=2027-11-17T00:00:00Z",
    "lat=0&lon=0&start=2026-11-15T00:00:00Z&end=2026-12-15T00:00:00Z&step_minutes=1",
    "lat=91&lon=0&start=2026-11-15T00:00:00Z&end=2026-11-16T00:00:00Z",
    "lat=nan&lon=0&start=2026-11-15T00:00:00Z&end=2026-11-16T00:00:00Z",
    "lat=0&lon=0&start=2026-11-15T00:00:00Z&end=2026-11-16T00:00:00Z&altitude_reference=orbit",
    "lat=0&lon=0&start=2649-12-31T12:00:00Z&end=2650-01-01T12:00:00Z",
])
def test_rejects_invalid_inputs(query):
    assert TestClient(app).get(f"/api/earth-link?{query}").status_code == 422


def test_too_many_samples_suggests_a_step():
    r = TestClient(app).get(BASE + "&end=2026-12-15T00:00:00Z&step_minutes=1")
    assert "step_minutes >= 3" in r.json()["detail"]


def test_below_ground_sphere_altitude_is_422(monkeypatch, manifest_dir):
    monkeypatch.setattr(terrain, "sample_heights", fake_terrain(base=100.0))
    fake_horizons(monkeypatch, lambda h: 5.0)
    r = TestClient(app).get(BASE + "&end=2026-11-16T00:00:00Z&altitude_m=50&altitude_reference=sphere")
    assert r.status_code == 422 and "below the local ground" in r.json()["detail"]
    ok = TestClient(app).get(BASE + "&end=2026-11-16T00:00:00Z&altitude_m=150&altitude_reference=sphere")
    assert ok.status_code == 200 and ok.json()["location"]["observer_elevation_m"] == 150


def test_horizons_failure_is_502(monkeypatch, manifest_dir):
    async def fake_get(self, url, params):
        raise httpx.ConnectError("offline")
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    assert TestClient(app).get(BASE + "&end=2026-11-16T00:00:00Z").status_code == 502


def test_endpoint_windows_with_terrain(monkeypatch, manifest_dir):
    seen = []
    monkeypatch.setattr(terrain, "sample_heights", fake_terrain(site=(0, 0), base=100.0))
    fake_horizons(monkeypatch, lambda h: 2 * math.sin(2 * math.pi * h / 24), seen=seen)
    r = TestClient(app).get(BASE + "&end=2026-11-17T00:00:00Z&max_blackout_hours=13&include_samples=true")
    assert r.status_code == 200, r.text
    body = r.json()
    assert seen[0]["SITE_COORD"] == "'0.0,0.0,0.102'" and seen[0]["COMMAND"] == "'399'"
    assert body["period"]["samples"] == 97 and len(body["samples"]) == 97
    w = body["windows"]
    # The run ends at el = 0, which is above the dipped horizon: Earth rises again just before the end.
    assert [x["status"] for x in w] == ["available", "blocked", "available", "blocked", "available"]
    # 2 sin(x) = dip: Earth sets / rises ~10 min late / early because the horizon dips below 0 deg.
    lag_h = -math.asin(hp.limb_angle(R + 100, R + 102) / 2) * 24 / (2 * math.pi)
    assert w[-1]["clipped_end"] and w[-1]["duration_hours"] == pytest.approx(lag_h, abs=1 / 120)
    assert w[0]["start_utc"] == "2026-11-15T00:00:00Z" and w[-1]["end_utc"] == "2026-11-17T00:00:00Z"
    assert all(a["end_utc"] == b["start_utc"] for a, b in zip(w, w[1:]))
    first_set = datetime.fromisoformat(w[1]["start_utc"])
    assert abs((first_set - START).total_seconds() - (12 + lag_h) * 3600) < 30
    assert {c for x in w for c in x["causes"]} == {"lunar_limb"}
    assert body["summary"]["available_fraction"] == pytest.approx(0.5 + 4 * lag_h / 48, abs=1e-3)
    assert body["assessment"]["status"] == "pass"
    assert body["terrain_model"]["type"] == "lola" and "skyline_1deg" not in body["terrain_model"]


def test_endpoint_without_terrain_and_pole_clamp(tmp_path, monkeypatch):
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    fake_horizons(monkeypatch, lambda h: 4.0)
    r = TestClient(app).get("/api/earth-link?lat=-90&lon=0&start=2026-11-15T00:00:00Z&end=2026-11-15T06:00:00Z")
    assert r.status_code == 200
    body = r.json()
    assert body["location"]["latitude_deg"] == -89.9999 and body["location"]["requested_latitude_deg"] == -90
    assert body["terrain_model"]["type"] == "smooth_sphere"
    assert [w["status"] for w in body["windows"]] == ["unknown"]
    assert "exact pole" in body["warnings"][0]
    assert body["assessment"]["status"] == "criteria_not_specified"


def test_endpoint_skyline_option(monkeypatch, manifest_dir):
    monkeypatch.setattr(terrain, "sample_heights", fake_terrain(base=100.0))
    fake_horizons(monkeypatch, lambda h: 30.0)
    body = TestClient(app).get(BASE + "&end=2026-11-15T03:00:00Z&include_skyline=true").json()
    assert len(body["terrain_model"]["skyline_1deg"]) == 360
    assert body["summary"]["available_fraction"] == 1
