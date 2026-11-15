import json
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import sun, sun_analysis as sa, terrain, thermal
from app.horizon_profile import RADIUS_M as R
from app.horizons import body_series
from app.main import app
from app.routers import sun as sun_router

AU = sun.AU_KM
START = datetime(2026, 1, 1, tzinfo=timezone.utc)
SYNODIC_H = thermal.SYNODIC_S / 3600


# ---------- synthetic bodies and terrain ----------

def sun_track(times, dec_deg=0.0, phase_deg=0.0):
    """Sun circling the Moon-fixed frame once per synodic month at declination dec_deg."""
    h = np.array([(t - START).total_seconds() / 3600 for t in times])
    w = np.radians(phase_deg) + 2 * np.pi * h / SYNODIC_H
    d = np.radians(dec_deg)
    return AU * np.stack([np.cos(w) * np.cos(d), np.sin(w) * np.cos(d), np.full_like(w, np.sin(d))], -1)


def as_series(times, pos_km, lat, lon):
    """Inverse of sun.body_positions: what Horizons would report at (lat, lon) on the sphere."""
    e, n, u = sun.enu_basis(lat, lon)
    v = pos_km - u * R / 1000
    km = np.linalg.norm(v, axis=1)
    s = v / km[:, None]
    el = np.degrees(np.arcsin(s @ u))
    az = np.degrees(np.arctan2(s @ e, s @ n)) % 360
    return [(t, float(a), float(b), float(k)) for t, a, b, k in zip(times, az, el, km)]


def crater(lat, lon):
    """South-pole crater: 3 km deep bowl of 10 km radius with a 600 m rim, on a level plain."""
    lat = np.asarray(lat, float)
    r = (90 + lat) * np.pi / 180 * R
    z = np.where(r < 10_000, -3000 * (1 - (r / 10_000) ** 2), 0.0)
    return z + 600 * np.exp(-((r - 10_000) / 2500) ** 2) + 0 * np.asarray(lon, float)


@pytest.fixture
def no_terrain(tmp_path, monkeypatch):
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)


@pytest.fixture
def crater_terrain(tmp_path, monkeypatch):
    m = {"version": "fixture", "tile_size": 65, "reference_radius_m": R, "citation": "test",
         "baseline": {"key": "g", "file": "g.img", "width": 4, "height": 2, "pixels_per_degree": 1 / 90,
                      "scale": 1, "source": "fixture", "min_elevation_m": -3000, "max_elevation_m": 700},
         "regions": []}
    (tmp_path / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    monkeypatch.setattr(terrain, "sample_heights", lambda m, root, lat, lon: crater(lat, lon))
    # A fine probe spacing so slopes are measured on the crater walls, not across them.
    monkeypatch.setattr(sun, "site_resolution_m", lambda m, lat, lon: 100.0)


@pytest.fixture
def fake_horizons(monkeypatch):
    """Router Horizons calls answered from the synthetic Sun (dec 1.5 deg, so the south pole sees it low) and Earth."""
    calls = []

    async def fake(target, lat, lon, height_m, start, step, count):
        calls.append((target, lat, lon, count))
        times = [start + timedelta(minutes=step * i) for i in range(count)]
        pos = sun_track(times, dec_deg=-1.5) if target == "10" else np.tile([384400.0, 0, 0], (count, 1))
        return as_series(times, pos, lat, lon)

    monkeypatch.setattr(sun_router, "body_series", fake)
    return calls


# ---------- geometry ----------

def test_rebuilt_positions_reproduce_the_view_from_another_site():
    times = [START + timedelta(hours=6 * i) for i in range(20)]
    truth = sun_track(times, dec_deg=1.2)
    pos = sun.body_positions(-85, 10, R, as_series(times, truth, -85, 10))
    np.testing.assert_allclose(pos, truth, rtol=1e-9, atol=1e-6)   # km


def test_visible_fraction_of_the_disc():
    assert sun.visible_fraction(1.0, 0.0, 0.25) == pytest.approx(1)
    assert sun.visible_fraction(0.0, 0.0, 0.25) == pytest.approx(0.5)
    assert sun.visible_fraction(-1.0, 0.0, 0.25) == pytest.approx(0)


def test_reference_site_handles_the_date_line_and_the_pole():
    lat, lon = sun.reference_site([-10, -10], [179, -179])
    assert lat == pytest.approx(-10, abs=0.01) and abs(lon) == pytest.approx(180)
    assert sun.reference_site([-90], [0])[0] == -sun.LAT_LIMIT


def test_subsolar_point_without_terrain(no_terrain):
    sites = sun.prepare_sites([0, 0], [0, 180], 1.0)
    assert sites.terrain_model["type"] == "smooth_sphere" and "smooth sphere" in sites.warnings[0]
    il = sun.illumination(sites, np.array([[AU, 0, 0]]))
    assert il["el"][0, 0] == pytest.approx(90, abs=1e-3)
    assert il["horizontal"][0, 0] == pytest.approx(1361, rel=0.01)
    assert il["frac"][1, 0] == 0 and il["horizontal"][1, 0] == 0


def test_crater_floor_skyline_and_slope(crater_terrain):
    sites = sun.prepare_sites([-90, -89.85], [0, 0], 1.0)
    assert sites.terrain_model["type"] == "lola" and not sites.warnings
    assert sites.skyline[0].min() > 15          # rim 3.6 km above the floor 10 km away
    assert sites.slope_deg[0] < 1                # flat bowl bottom
    assert sites.slope_deg[1] > 10               # crater wall, 4.5 km from the pole


# ---------- analysis ----------

def test_equator_temperatures_over_a_lunation(no_terrain):
    sites = sun.prepare_sites([0, 0, 10], [0, 90, 45], 5.0)
    n_spin = sa.spinup_steps(120)
    times = sa.time_grid(START - timedelta(minutes=120 * n_spin), START + timedelta(days=30), 120)
    res = sa.region_series(sites, times, sun_track(times), n_spin, 120, {"name": "test"}, grid_series=False)
    s = res["cell_stats"]
    assert 370 < max(s["max_temp_K"]) < 400 and 85 < min(s["min_temp_K"]) < 105
    assert all(0.45 < f < 0.55 for f in s["illumination_fraction"])
    assert res["meta"]["n_times"] == len(res["times"]) == len(times) - n_spin


def test_crater_is_a_cold_trap_and_judge_ranks_it_first(crater_terrain):
    sites = sun.prepare_sites([-90, -89.2], [0, 0], 1.0)
    n_spin = sa.spinup_steps(120)
    times = sa.time_grid(START - timedelta(minutes=120 * n_spin), START + timedelta(days=30), 120)
    res = sa.region_series(sites, times, sun_track(times, dec_deg=-1.5), n_spin, 120, {}, grid_series=False)
    s = res["cell_stats"]
    assert s["illumination_fraction"][0] == 0 and s["max_temp_K"][0] < 60
    assert s["illumination_fraction"][1] > 0.4
    out = sa.judge(sa.PRESETS["ice_cold_trap"], res)
    assert out["ranking"][0]["lat"] == -90 and out["ranking"][0]["verdict"] == "PASS"
    assert out["ranking"][1]["verdict"] == "FAIL" and out["summary"]["n_pass"] == 1


def test_earth_metrics_near_and_far_side(no_terrain):
    sites = sun.prepare_sites([0, 0], [0, 180], 5.0)
    times = sa.time_grid(START, START + timedelta(days=2), 60)
    res = sa.region_series(sites, times, sun_track(times), 0, 60, {}, thermal_model=False,
                           grid_series=False, earth_km=np.tile([384400.0, 0, 0], (len(times), 1)))
    assert res["cell_stats"]["earth_visible_fraction"] == [1.0, 0.0]
    assert res["cell_stats"]["max_earth_blackout_hours"] == [0.0, 49.0]


def test_events_are_interpolated_between_samples(no_terrain):
    sites = sun.prepare_sites([0], [0], 1.0)
    times = sa.time_grid(START, START + timedelta(days=30), 30)
    out = sa.point_report(sites, times, sun_track(times), 0, {}, 50, True, False, 30)
    # Noon at t=0, so sunset is a quarter synodic month later (the disc centre at the horizon).
    sunset = datetime.fromisoformat(out["events"]["next_sunset_utc"].replace("Z", "+00:00"))
    assert abs((sunset - START).total_seconds() / 3600 - SYNODIC_H / 4) < 0.05
    assert out["events"]["next_sunrise_utc"] is not None and out["sun"]["state"] == "full_sun"


def test_unknown_metric_is_rejected():
    with pytest.raises(ValueError, match="Unknown metric"):
        sa.needs([{"metric": "nope", "op": ">=", "value": 1}])
    assert sa.needs([{"metric": "max_temp_K", "op": "<=", "value": 1},
                     {"metric": "earth_visible_fraction", "op": ">=", "value": 1}]) == (True, True)


# ---------- Horizons ----------

def test_single_epoch_series_asks_for_two_and_returns_one(monkeypatch):
    seen = {}

    async def fake_get(self, url, params):
        seen.update(params)
        text = ("$$SOE\n 2026-Jan-01 00:00:00, , ,10.0,5.0,0.99,0.1,\n"
                " 2026-Jan-01 00:30:00, , ,11.0,5.1,0.99,0.1,\n$$EOE")
        return httpx.Response(200, json={"result": text}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    import asyncio
    rows = asyncio.run(body_series("10", -85, 0, 0, START, 30, 1))
    assert len(rows) == 1 and rows[0][1:3] == (10.0, 5.0)
    assert seen["COMMAND"] == "'10'" and seen["STOP_TIME"] == "'2026-01-01 00:30:00'"


# ---------- endpoints ----------

def test_point_endpoint(crater_terrain, fake_horizons):
    r = TestClient(app).get("/api/sun/point", params={"lat": -89.2, "lon": 0, "time": "2026-01-10T00:00:00Z",
                                                      "temperature": True})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["terrain_model"]["type"] == "lola" and len(j["horizon_profile_deg"]) == 360
    assert j["sun"]["state"] in ("full_sun", "partial_sun", "terrain_shadow", "night")
    assert 40 < j["surface_temperature_K"] < 400 and "events" in j
    # One Horizons call, starting one lunation earlier for the heat-model spin-up.
    assert len(fake_horizons) == 1 and fake_horizons[0][3] == sa.spinup_steps(30) + 30 * 48 + 1


def test_region_endpoint_grid_csv_and_earth(no_terrain, fake_horizons):
    client = TestClient(app)
    body = {"region": {"lat_min": -10, "lat_max": 10, "lon_min": -10, "lon_max": 10, "n_lat": 2, "n_lon": 2},
            "start": "2026-01-01T00:00:00Z", "stop": "2026-01-03T00:00:00Z", "step_min": 120,
            "thermal_model": False, "earth": True}
    j = client.post("/api/sun/region", json=body).json()
    assert len(j["grid"]["series"]["sun_fraction"]) == j["meta"]["n_times"] == 25
    assert j["cell_stats"]["earth_visible_fraction"] == [1.0] * 4
    assert [c[0] for c in fake_horizons] == ["10", "399"]
    csv = client.post("/api/sun/region", json=body | {"format": "csv"}).text
    assert csv.startswith("time_utc,lat,lon") and csv.count("\n") == 4 * 25 + 1


def test_judge_endpoint_presets_and_errors(crater_terrain, fake_horizons):
    client = TestClient(app)
    body = {"points": [[-90, 0], [-89.2, 0]], "start": "2026-01-01T00:00:00Z",
            "stop": "2026-01-31T00:00:00Z", "step_min": 120, "preset": "ice_cold_trap"}
    j = client.post("/api/sun/judge", json=body).json()
    assert j["ranking"][0]["lat"] == -90 and j["ranking"][0]["verdict"] == "PASS"
    assert j["ranking"][0]["elevation_m"] == pytest.approx(-3000, abs=1)
    crewed = client.post("/api/sun/judge", json=body | {"preset": "crewed_landing"}).json()
    assert {c["metric"] for c in crewed["ranking"][0]["criteria"]} >= {"earth_visible_fraction"}
    assert client.post("/api/sun/judge", json=body | {"preset": None}).status_code == 422
    assert client.post("/api/sun/judge", json=body | {"preset": None, "criteria": [
        {"metric": "nope", "op": ">=", "value": 1}]}).status_code == 422
    assert client.post("/api/sun/judge", json=body | {"preset": None, "criteria": [
        {"metric": "slope_deg", "op": "between", "value": 3}]}).status_code == 422


def test_region_limits_and_time_checks(no_terrain, fake_horizons):
    client = TestClient(app)
    base = {"start": "2026-01-01T00:00:00Z", "stop": "2026-01-02T00:00:00Z", "step_min": 60}
    big = base | {"region": {"lat_min": -10, "lat_max": 10, "lon_min": 0, "lon_max": 10, "n_lat": 31, "n_lon": 30}}
    assert "Too many points" in client.post("/api/sun/region", json=big).json()["detail"]
    naive = base | {"points": [[0, 0]], "start": "2026-01-01T00:00:00"}
    assert client.post("/api/sun/region", json=naive).status_code == 422
    backwards = base | {"points": [[0, 0]], "stop": "2025-12-31T00:00:00Z"}
    assert client.post("/api/sun/region", json=backwards).status_code == 422
    assert client.post("/api/sun/region", json=base).status_code == 422          # no region or points
    assert fake_horizons == []
    assert "crewed_landing" in client.get("/api/sun/metrics").json()["presets"]


def test_region_can_score_its_points_in_the_same_request(crater_terrain, fake_horizons):
    body = {"points": [[-90, 0], [-89.2, 0]], "start": "2026-01-01T00:00:00Z", "stop": "2026-01-31T00:00:00Z",
            "step_min": 120, "thermal_model": False, "grid_series": False, "preset": "ice_cold_trap"}
    j = TestClient(app).post("/api/sun/region", json=body).json()
    assert "max_temp_K" in j["cell_stats"]                     # the preset turned the heat model on
    assert j["judge"]["ranking"][0]["lat"] == -90 and j["judge"]["summary"]["n_pass"] == 1
    plain = TestClient(app).post("/api/sun/region", json=body | {"preset": None}).json()
    assert "judge" not in plain and "max_temp_K" not in plain["cell_stats"]
