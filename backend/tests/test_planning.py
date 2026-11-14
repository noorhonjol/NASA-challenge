from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.horizons import HorizonsError

client = TestClient(app)
EQUIPMENT = {"load_w": 100, "panel_area_m2": 1, "panel_efficiency": 1, "system_efficiency": 1}
SPAN = {"start": "2026-11-14T00:00:00Z", "end": "2026-11-14T04:00:00Z", "step_hours": 2}
POINT = {"lat": -89, "lon": 0}


@pytest.fixture
def sky(monkeypatch):
    elevations = [90, 90, 90]
    calls = []
    async def fake(lat, lon, elevation_m, at):
        index = len(calls) % len(elevations)
        calls.append((lat, lon, at))
        return {"at_utc": at.isoformat(), "sun": {"elevation_deg": elevations[index], "azimuth_deg": 0, "distance_km": 149597870.7}, "earth": {"elevation_deg": 5}}
    monkeypatch.setattr("app.planning.positions", fake)
    return elevations, calls


def test_point_power_and_horizontal_incidence(sky):
    sky[0][:] = [30]
    r = client.post("/api/planning/power", json={"point": POINT, "at": SPAN["start"], "duration_hours": 4, "step_hours": 2, "equipment": EQUIPMENT})
    assert r.status_code == 200
    data = r.json()
    assert data["samples"][0]["generated_power_w"] == pytest.approx(680.5)
    assert data["summary"]["generated_energy_wh"] == pytest.approx(2722)
    assert data["summary"]["load_energy_wh"] == 400
    assert data["samples"][0]["required_panel_area_m2"] == pytest.approx(100/680.5)


def test_darkness_battery_and_no_operating_windows(sky):
    sky[0][:] = [-5]
    r = client.post("/api/planning/analysis", json={**SPAN, "points": [POINT], "equipment": {**EQUIPMENT, "battery_wh": 500}})
    data = r.json()["results"][0]
    assert data["summary"]["minimum_nameplate_battery_wh"] == 500
    assert data["summary"]["battery_sufficient_if_initially_full"]
    assert data["operating_windows"] == []
    assert data["samples"][0]["required_panel_area_m2"] is None


def test_grid_includes_bounds_and_final_partial_interval(sky):
    r = client.post("/api/planning/analysis", json={**SPAN, "step_hours": 3, "grid": {"south": -90, "north": -89, "west": 0, "east": 1}, "equipment": EQUIPMENT})
    assert r.status_code == 200
    results = r.json()["results"]
    assert len(results) == 4
    assert results[-1]["point"] == {**POINT, "lon": 1, "elevation_m": 0}
    assert results[0]["summary"]["duration_hours"] == 4
    assert len(sky[1]) == 12


def test_windows_merge_filter_and_communication_constraint(sky):
    payload = {**SPAN, "point": POINT, "equipment": EQUIPMENT, "minimum_duration_hours": 3}
    assert client.post("/api/planning/windows", json=payload).json()["operating_windows"][0]["duration_hours"] == 4
    payload["equipment"] = {**EQUIPMENT, "minimum_earth_elevation_deg": 10}
    assert client.post("/api/planning/windows", json=payload).json()["operating_windows"] == []
    payload["equipment"]["require_earth_visibility"] = False
    assert len(client.post("/api/planning/windows", json=payload).json()["operating_windows"]) == 1


def test_battery_tracks_interior_net_power_extremum(sky):
    sky[0][:] = [-5, 90, -5]
    result = client.post("/api/planning/analysis", json={**SPAN, "points": [POINT], "equipment": EQUIPMENT}).json()["results"][0]
    assert result["summary"]["minimum_initial_usable_energy_wh"] == pytest.approx(10000/1361)
    assert result["summary"]["minimum_usable_storage_wh"] == pytest.approx(10000/1361)


@pytest.mark.parametrize("change", [
    {"points": None}, {"grid": {"south": -90, "north": -89, "west": 0, "east": 1}},
    {"start": "2026-11-14T00:00:00"}, {"end": SPAN["start"]},
    {"step_hours": 0}, {"equipment": {**EQUIPMENT, "panel_efficiency": 2}},
    {"points": [{"lat": -91, "lon": 0}]}, {"points": [POINT]*64},
    {"end": "2028-01-01T00:00:00Z"}, {"equipment": {**EQUIPMENT, "load_w": "NaN"}},
])
def test_validation_before_upstream(sky, change):
    assert client.post("/api/planning/analysis", json={**SPAN, "points": [POINT], "equipment": EQUIPMENT, **change}).status_code == 422
    assert not sky[1]


def test_upstream_failure(monkeypatch):
    async def fail(*args):
        raise HorizonsError("unavailable")
    monkeypatch.setattr("app.planning.positions", fail)
    assert client.post("/api/planning/windows", json={**SPAN, "point": POINT, "equipment": EQUIPMENT}).status_code == 502
