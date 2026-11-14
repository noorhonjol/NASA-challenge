from datetime import datetime, timedelta, timezone
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.energy_v1 import solar, power
from app.energy_v1.schemas import (
    Assumptions,
    Location,
    Period,
    Mission,
    Windows,
    Region,
)
from app.energy_v1.errors import EnergyError
from app.energy_v1.terrain import Surface, R

client = TestClient(app)
START = "2026-12-01T00:00:00Z"
LOCATION = {"lat": -89.45, "lon": -137.3, "height_m": 2}
PERIOD = {"start": START, "end": "2026-12-02T00:00:00Z", "step_hours": 6}


@pytest.fixture
def analytic_sky(monkeypatch):
    state = {"dark": False, "earth": True, "elevation": 30.0}

    def fake(location, times):
        size = len(times)
        lit = np.full(size, not state["dark"])
        one = np.ones(size)
        return {
            "location": {
                **location.model_dump(),
                "elevation_m": 100.0,
                "slope_deg": 0.0,
                "aspect_deg": 0.0,
            },
            "product": "test-LOLA",
            "times": times,
            "sun_elevation": one * state["elevation"],
            "sun_azimuth": one * 90,
            "visible_fraction": lit.astype(float),
            "earth_visible": np.full(size, state["earth"]),
            "earth_elevation": one * 5,
            "distance_au": one,
            "horizon": one * 0,
            "incidence": one * 60,
            "toa": one * 1000,
            "full_tracking": lit * 1000.0,
            "horizontal": lit * 500.0,
            "terrain": lit * 500.0,
            "vertical_tracking": lit * 866.0254,
        }

    monkeypatch.setattr(solar, "series", fake)
    monkeypatch.setattr(power, "series", fake)
    monkeypatch.setattr("app.energy_v1.region.series", fake)
    return state


def test_disk_fraction_and_projection_physics():
    np.testing.assert_allclose(
        solar.disk_fraction(np.array([-0.265, 0, 0.265])), [0, 0.5, 1]
    )
    assert solar.project(30, 90, 0, 0) == pytest.approx(0.5)
    assert solar.project(30, 90, 60, 90) == pytest.approx(1)
    assert solar.project(30, 90, 90, 270) == 0


def test_point_contract_normalization_and_custom_panel(analytic_sky):
    r = client.get(
        "/v1/solar/point",
        params={
            "lat": -89.45,
            "lon": 222.7,
            "time": START,
            "panel_tilt_deg": 60,
            "panel_azimuth_deg": 90,
        },
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["location"]["lon"] == pytest.approx(-137.3)
    assert d["sun"]["visible_fraction"] == 1
    assert d["irradiance"]["custom_panel_w_m2"] == pytest.approx(1000)
    assert d["meta"]["ephemeris"] == "DE440"
    assert d["meta"]["request_id"] == r.headers["X-Request-ID"]


@pytest.mark.parametrize(
    "params,code",
    [
        ({"lat": 91, "lon": 0, "time": START}, "INVALID_PARAMETER"),
        ({"lat": 0, "lon": 360, "time": START}, "INVALID_PARAMETER"),
        ({"lat": 0, "lon": 0, "time": "2019-01-01T00:00:00Z"}, "INVALID_TIME_RANGE"),
        ({"lat": 0, "lon": 0, "time": "2026-01-01T00:00:00"}, "INVALID_TIME_RANGE"),
        (
            {"lat": 0, "lon": 0, "time": START, "panel_tilt_deg": 20},
            "INVALID_PARAMETER",
        ),
        ({"lat": 0, "lon": 0, "time": START, "height_m": 51}, "INVALID_PARAMETER"),
    ],
)
def test_point_errors(params, code):
    r = client.get("/v1/solar/point", params=params)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == code


def test_resource_point_needs_no_equipment(analytic_sky):
    r = client.get("/v1/solar/point", params={"lat": 0, "lon": 0, "time": START})
    assert r.status_code == 200
    assert "equipment" not in r.json()
    assert r.json()["irradiance"]["custom_panel_w_m2"] is None


def test_region_shapes_metrics_mask_and_timeseries(analytic_sky):
    request = {
        "area": {"type": "circle", "center": LOCATION, "radius_m": 500},
        "resolution_m": 240,
        "period": PERIOD,
        "include_timeseries": True,
        "metrics": ["total_energy", "max_darkness_hours"],
    }
    r = client.post("/v1/solar/region", json=request)
    assert r.status_code == 200, r.text
    d = r.json()
    values = np.array(d["metrics"]["total_energy"]["values"], dtype=float)
    assert np.nanmax(values) == 12000
    assert d["period"]["samples"] == 5
    assert len(d["timeseries"]["times"]) == 5
    assert d["ranking"]["by"] == "total_energy"
    mask = np.array(d["grid"]["mask"])
    assert not mask.all()
    assert np.isnan(values[~mask]).all()


def test_region_work_limit_checked_before_science():
    r = client.post(
        "/v1/solar/region",
        json={
            "area": {
                "type": "bbox",
                "min_lat": -90,
                "max_lat": -87,
                "min_lon": -180,
                "max_lon": 179,
            },
            "resolution_m": 5,
            "period": PERIOD,
        },
    )
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "REQUEST_TOO_LARGE"


def test_polygon_self_intersection():
    r = client.post(
        "/v1/solar/region",
        json={
            "area": {
                "type": "polygon",
                "coordinates": [[-89, 0], [-88, 1], [-89, 1], [-88, 0]],
            },
            "period": PERIOD,
        },
    )
    assert r.status_code == 400


def test_mission_sizing_energy_balance(analytic_sky):
    request = {
        "location": LOCATION,
        "start": START,
        "duration_hours": 24,
        "load": {"average_w": 100, "survival_w": 20},
        "panel": {"mode": "fixed_horizontal", "efficiency": 1},
        "assumptions": {"battery_efficiency": 1, "margin_pct": 20},
    }
    r = client.post("/v1/power/mission", json=request)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["feasible"]
    assert d["sizing"]["min_panel_area_m2"] == pytest.approx(0.2)
    assert d["sizing"]["recommended_panel_area_m2"] == pytest.approx(0.24)
    assert d["energy"]["load_total_wh"] == 2400
    assert len(d["timeline"]["times"]) == 25
    assert d["sizing"]["min_battery_wh"] == pytest.approx(0, abs=1e-7)


def test_dark_mission_has_no_fabricated_infinite_size(analytic_sky):
    analytic_sky["dark"] = True
    r = client.post(
        "/v1/power/mission",
        json={
            "location": LOCATION,
            "start": START,
            "duration_hours": 72,
            "load": {"average_w": 100, "survival_w": 20},
            "panel": {"mode": "fixed_horizontal"},
        },
    )
    d = r.json()
    assert not d["feasible"]
    assert d["sizing"]["min_panel_area_m2"] is None
    assert {w["code"] for w in d["warnings"]} >= {"NEVER_ILLUMINATED", "LONG_DARKNESS"}
    assert d["energy"]["load_total_wh"] == 1440


def test_contradictory_load_error():
    r = client.post(
        "/v1/power/mission",
        json={
            "location": LOCATION,
            "start": START,
            "duration_hours": 24,
            "load": {"average_w": 10, "survival_w": 20},
        },
    )
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "INFEASIBLE_INPUT"


def test_custom_profile_coverage_error():
    r = client.post(
        "/v1/power/mission",
        json={
            "location": LOCATION,
            "start": START,
            "duration_hours": 24,
            "load": {
                "profile": "custom",
                "survival_w": 0,
                "custom": {
                    "times": [START, "2026-12-01T01:00:00Z"],
                    "power_w": [100, 100],
                },
            },
        },
    )
    assert r.status_code == 400


def test_battery_loss_and_chronology():
    times = [
        datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=i) for i in range(5)
    ]
    a = Assumptions(battery_dod=0.8, battery_efficiency=0.81)
    gen = np.zeros(5)
    load = np.ones(5) * 90
    soc, usable = power.simulate(gen, load, times, 500, a)
    np.testing.assert_allclose(soc, [100, 75, 50, 25, 0], atol=1e-8)
    assert usable.all()
    soc, usable = power.simulate(gen, load, times, 250, a)
    assert not usable[-1] and soc[-1] == 0


def test_windows_no_storage_and_zero_survival(analytic_sky):
    payload = {
        "location": LOCATION,
        "search": PERIOD,
        "equipment": {
            "panel": {"mode": "fixed_horizontal", "area_m2": 1, "efficiency": 1},
            "required_power_w": 100,
        },
        "criteria": {"min_window_hours": 1},
    }
    r = client.post("/v1/power/windows", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["summary"]["total_window_hours"] == 24
    assert 0 <= d["windows"][0]["score"] <= 1
    assert len(d["timeline"]["times"]) == len(d["timeline"]["usable"])
    analytic_sky["dark"] = True
    d = client.post("/v1/power/windows", json=payload).json()
    assert d["summary"]["window_count"] == 0
    assert "insufficient_power" in d["unsuitable_periods"][0]["reasons"]


def test_windows_battery_does_not_reset(analytic_sky):
    analytic_sky["dark"] = True
    payload = {
        "location": LOCATION,
        "search": PERIOD,
        "equipment": {
            "panel": {"mode": "fixed_horizontal", "area_m2": 1},
            "required_power_w": 100,
            "battery_wh": 1500,
            "survival_w": 0,
        },
        "assumptions": {"battery_dod": 1, "battery_efficiency": 1},
        "criteria": {"min_window_hours": 1},
    }
    r = client.post("/v1/power/windows", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["summary"]["total_window_hours"] == 12
    assert len(d["windows"]) == 1
    assert d["windows"][0]["min_battery_soc_pct"] == pytest.approx(20)


def test_windows_earth_gate(analytic_sky):
    analytic_sky["earth"] = False
    d = client.post(
        "/v1/power/windows",
        json={
            "location": LOCATION,
            "search": PERIOD,
            "equipment": {
                "panel": {"mode": "fixed_horizontal", "area_m2": 10},
                "required_power_w": 100,
                "needs_earth_visibility": True,
            },
        },
    ).json()
    assert d["windows"] == []
    assert "no_earth_visibility" in d["unsuitable_periods"][0]["reasons"]


def test_auto_fixed_search_and_simple_selection(analytic_sky):
    r = client.post(
        "/v1/power/mission",
        json={
            "location": LOCATION,
            "start": START,
            "duration_hours": 2,
            "load": {"average_w": 100, "survival_w": 20},
            "panel": {"mode": "auto", "efficiency": 1},
            "assumptions": {"prefer_simple": True, "battery_efficiency": 1},
        },
    )
    assert r.status_code == 200, r.text
    d = r.json()
    recommendation = d["panel_recommendation"]
    assert recommendation["selected_mode"] == "fixed_tilt"
    assert recommendation["selected_tilt_deg"] == 60
    assert recommendation["selected_azimuth_deg"] == 90
    assert len(recommendation["comparison"]) == 4


def test_unavailable_ephemeris_v1_error(analytic_sky, monkeypatch):
    def fail(*args):
        raise EnergyError("DATA_UNAVAILABLE", "No kernels", status=503)

    monkeypatch.setattr(solar, "series", fail)
    r = client.get("/v1/solar/point", params={"lat": 0, "lon": 0, "time": START})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "DATA_UNAVAILABLE"


def test_epoch_sampling_includes_partial_end():
    p = Period(start=START, end="2026-12-01T07:00:00Z", step_hours=6)
    assert len(p.times()) == 3
    assert p.times()[-1].hour == 7


def test_legacy_planning_api_removed():
    assert client.post("/api/planning/resources", json={}).status_code == 404


def test_curved_horizon_depends_on_sensor_height(tmp_path):

    surface = object.__new__(Surface)
    surface.root = tmp_path
    surface.m = {"version": "flat-sphere"}
    surface.regions = []
    surface.sample = lambda lat, lon: np.zeros_like(lat)
    low = surface.horizons(Location(lat=-89, lon=0, height_m=0), 0)
    high = surface.horizons(Location(lat=-89, lon=0, height_m=10), 0)
    assert low.shape == (360,)
    assert np.all(high < low)
    np.testing.assert_allclose(low, -np.degrees(5 / (2 * R)), atol=1e-7)
    assert len(list((tmp_path / "energy-horizons").glob("*.npy"))) == 2


def test_positive_margin_rejects_battery_only_window(analytic_sky):
    analytic_sky["dark"] = True
    r = client.post(
        "/v1/power/windows",
        json={
            "location": LOCATION,
            "search": PERIOD,
            "equipment": {
                "panel": {"mode": "fixed_horizontal", "area_m2": 1},
                "required_power_w": 100,
                "battery_wh": 10000,
            },
            "criteria": {"min_window_hours": 1, "min_power_margin_pct": 10},
        },
    )
    assert r.status_code == 200
    assert r.json()["windows"] == []


def test_v1_validation_does_not_change_legacy_statuses():
    assert (
        client.get("/api/positions?lat=91&lon=0&at=2026-12-01T00:00:00Z").status_code
        == 422
    )
    r = client.post(
        "/v1/solar/region",
        json={
            "area": {"type": "circle", "center": LOCATION, "radius_m": 500},
            "period": {**PERIOD, "step_hours": 25},
        },
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_PARAMETER"
    assert r.headers["X-Request-ID"] == r.json()["meta"]["request_id"]


def test_bbox_includes_pole_and_full_longitude(analytic_sky):
    r = client.post(
        "/v1/solar/region",
        json={
            "area": {
                "type": "bbox",
                "min_lat": -90,
                "max_lat": -89.99,
                "min_lon": -180,
                "max_lon": 180,
            },
            "resolution_m": 240,
            "period": PERIOD,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["grid"]["projection"] == "polar_stereographic_south"


def test_charge_rate_clipping_preserves_battery_energy():
    times = [
        datetime(2026, 1, 1, tzinfo=timezone.utc),
        datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
    ]
    a = Assumptions(battery_efficiency=1, max_charge_w=100)
    pieces = power.battery_segments(np.array([0.0, 200.0]), np.zeros(2), times, a)
    # Linear generation clipped at 100 W: 25 Wh ramp + 50 Wh plateau.
    assert sum(delta for delta, fail in pieces[0]) == pytest.approx(75)


def test_synthetic_eastern_ridge_obstructs_eastern_horizon(tmp_path):
    surface = object.__new__(Surface)
    surface.root = tmp_path
    surface.m = {"version": "east-ridge"}
    surface.regions = []
    surface.sample = lambda lat, lon: np.where(
        (np.abs(lat) < 0.01) & (lon > 0.03) & (lon < 0.04), 100.0, 0.0
    )
    horizon = surface.horizons(Location(lat=0, lon=0), 0)
    assert horizon[90] > 4
    assert horizon[0] < 0


def test_shared_core_applies_terrain_mask_to_sun_and_earth(monkeypatch):
    from app.energy_v1.terrain import basis

    location = Location(lat=0, lon=0, height_m=2)

    class Terrain:
        def location(self, loc):
            return {
                **loc.model_dump(),
                "elevation_m": 0,
                "slope_deg": 0,
                "aspect_deg": 0,
            }, np.array([0.0, 0.0, 1.0])

        def horizons(self, *args):
            return np.ones(360) * 10

        def product(self, *args):
            return "synthetic-ridge"

    monkeypatch.setattr(solar, "get_surface", lambda: Terrain())
    east, north, up = basis(0, 0)

    def direction(elevation, azimuth, distance):
        e, a = np.radians([elevation, azimuth])
        return up * (R + 2) + distance * (
            np.cos(e) * np.sin(a) * east
            + np.cos(e) * np.cos(a) * north
            + np.sin(e) * up
        )

    monkeypatch.setattr(
        solar.ephemeris,
        "vectors",
        lambda _: np.array([direction(5, 90, solar.AU), direction(20, 180, 384400000)]),
    )
    result = solar.point(location, datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert not result["sun"]["is_illuminated"]
    assert result["irradiance"]["full_tracking_w_m2"] == 0
    assert result["earth"]["is_visible"]
