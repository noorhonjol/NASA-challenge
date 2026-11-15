import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import mission as ms, terrain
from app.main import app
from app.routers import mission as router
from tests.test_sun import as_series, sun_track

START = datetime(2026, 12, 1, tzinfo=timezone.utc)
BOX = [[-89.0, 0.0], [-89.0, 20.0], [-88.8, 20.0], [-88.8, 0.0]]


def fake_power(lat, lon, times):
    """Deterministic stand-in for Lunar Energy v1: sunnier and flatter further from the pole."""
    sunny = min(1.0, (90 + lat) / 2)
    return {"illumination_fraction": sunny, "max_darkness_hours": 200 * (1 - sunny),
            "solar_energy_kwh_m2": 300 * sunny, "mean_irradiance_wm2": 1000 * sunny,
            "earth_visible_fraction": 0.8 if lon > 10 else 0.2, "slope_deg": 4.0, "elevation_m": 100.0,
            "_product": "fake"}


@pytest.fixture
def offline(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)          # smooth sphere for heat
    monkeypatch.setattr(ms, "power_metrics", fake_power)

    async def fake_body(target, lat, lon, height_m, start, step, count):
        calls.append(("sun", count))
        times = [start + timedelta(minutes=step * i) for i in range(count)]
        return as_series(times, sun_track(times), lat, lon)

    async def fake_earth(lat, lon, height_m, start, step, count):
        calls.append(("earth", count))
        times = [start + timedelta(minutes=step * i) for i in range(count)]
        return as_series(times, np.tile([384400.0, 0, 0], (count, 1)), lat, lon)

    monkeypatch.setattr(router, "body_series", fake_body)
    monkeypatch.setattr(router, "earth_series", fake_earth)
    return calls


def post(body):
    return TestClient(app).post("/api/mission/analyze", json=body)


def test_point_covers_power_heat_and_communication(offline):
    r = post({"where": {"type": "point", "lat": 0, "lon": 0}, "start": "2026-12-01T00:00:00Z",
              "end": "2026-12-08T00:00:00Z", "preset": "crewed_landing"})
    assert r.status_code == 200, r.text
    j = r.json()
    cell = j["cells"][0]
    assert set(j["summary"]) == {"power", "heat", "communication", "ground"}
    assert 0 < cell["min_temp_K"] < cell["max_temp_K"] < 420
    assert cell["verdict"] in ("PASS", "FAIL") and j["ranking"][0]["criteria"]
    # Without terrain the refined windows never claim a clear line of sight: Earth overhead is "unknown".
    assert j["communication"]["summary"]["unknown_hours"] == 168 and j["communication"]["terrain_model"] == "smooth_sphere"
    assert len(j["series"]["times"]) == len(j["series"]["surface_temp_K"]) > 0
    assert [c[0] for c in offline] == ["sun", "earth"]
    assert j["period"]["power_step_hours"] == 1 and j["period"]["heat_step_minutes"] == 60


def test_polygon_cells_are_scored_and_ranked(offline):
    j = post({"where": {"type": "polygon", "coordinates": BOX}, "start": "2026-12-01T00:00:00Z",
              "end": "2026-12-15T00:00:00Z", "preset": "crewed_landing"}).json()
    assert 1 < len(j["cells"]) <= ms.MAX_CELLS
    g = j["grid"]
    assert len(g["cell_rows"]) == len(j["cells"]) and max(g["cell_rows"]) < g["rows"]
    # Edges are straight in the polar projection, so an edge along -89 deg dips slightly poleward.
    lats = [c["lat"] for c in j["cells"]]
    assert -89.02 <= min(lats) and max(lats) <= -88.79
    # Earth-visible cells (lon > 10) pass the required Earth limit; the others cannot.
    passing = [c for c in j["cells"] if c["verdict"] == "PASS"]
    assert passing and all(c["lon"] > 10 for c in passing) and j["pass_count"] == len(passing)
    assert j["ranking"][0]["verdict"] == "PASS"
    assert "communication" not in j and "series" not in j
    assert [c[0] for c in offline] == ["sun"]


def test_no_mission_type_means_no_scores(offline):
    j = post({"where": {"type": "point", "lat": 0, "lon": 0}, "start": "2026-12-01T00:00:00Z",
              "end": "2026-12-02T00:00:00Z", "preset": None}).json()
    assert j["ranking"] == [] and "score" not in j["cells"][0]


@pytest.mark.parametrize("body, message", [
    ({"where": {"type": "polygon", "coordinates": BOX[:2]}}, "three"),
    ({"where": {"type": "point", "lat": 0}}, "lat and lon"),
    ({"where": {"type": "point", "lat": 0, "lon": 0}, "end": "2026-11-30T00:00:00Z"}, "after start"),
    ({"where": {"type": "point", "lat": 0, "lon": 0}, "end": "2027-12-31T00:00:00Z"}, "366 days"),
    ({"where": {"type": "point", "lat": 0, "lon": 0}, "start": "2040-01-01T00:00:00Z", "end": "2040-01-02T00:00:00Z"}, "2035"),
])
def test_invalid_requests(offline, body, message):
    full = {"start": "2026-12-01T00:00:00Z", "end": "2026-12-08T00:00:00Z"} | body
    r = post(full)
    assert r.status_code == 422 and message in r.text
    assert offline == []


def test_polygon_grid_respects_the_cell_cap():
    big = [[-88.0, 0.0], [-88.0, 90.0], [-86.0, 90.0], [-86.0, 0.0]]
    lat, lon, rows, cols, ri, ci, resolution, _ = ms.polygon_cells(big, ms.period(START, START + timedelta(days=30)))
    assert 0 < len(lat) <= ms.MAX_CELLS and resolution >= 1920
    # The -88 deg edge is a straight chord in the polar projection, reaching about -88.6 deg midway.
    assert ((lat >= -88.65) & (lat <= -85.95)).all()


def test_artemis_regions_file():
    doc = TestClient(app).get("/api/mission/regions").json()
    regions = {r["name"]: r for r in doc["regions"]}
    assert len(regions) == 9 and "nasa.gov" in doc["source"]["announcement"]
    for r in regions.values():
        assert len(r["polygon"]) == 4 and -90 < r["center"]["lat"] < -83
    # Independent check: a published optimal site inside Nobile Rim 2 (-84.2016, 60.70 E) lies near its box centre.
    c = regions["Nobile Rim 2"]["center"]
    d_lat = (c["lat"] + 84.2016) * math.pi / 180 * 1737.4
    d_lon = (c["lon"] - 60.70) * math.pi / 180 * 1737.4 * math.cos(math.radians(84.2))
    assert math.hypot(d_lat, d_lon) < 10
    assert abs(regions["Malapert Massif"]["center"]["lon"]) < 2
