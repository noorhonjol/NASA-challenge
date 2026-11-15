import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import mission_search as m
from app.main import app

START = datetime(2026, 12, 1, tzinfo=timezone.utc)
BOX = [[-89.0, 0.0], [-89.0, 20.0], [-88.8, 20.0], [-88.8, 0.0]]


def brute_longest(mask, start, length):
    best = cur = 0
    for v in mask[start:start + length]:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best


def test_longest_run_inside_windows_matches_brute_force():
    rng = np.random.default_rng(1)
    mask = rng.random((3, 200)) < 0.6
    starts = np.arange(0, 200 - 30 + 1, 7)
    got = m._longest_in_windows(m._run_lengths(mask), starts, 30)
    for c in range(3):
        for w, s in enumerate(starts):
            assert got[c, w] == brute_longest(mask[c], s, 30)


def fake_arrays(n_cells, n_steps, n_spin):
    """Cell 0: always sunlit, Earth always up, mild. Cell 1: dark and Earth hidden in the first half."""
    total = n_spin + n_steps
    frac = np.ones((n_cells, total))
    earth = np.ones((n_cells, total), bool)
    frac[1, n_spin:n_spin + n_steps // 2] = 0
    earth[1, n_spin:n_spin + n_steps // 2] = False
    return {"visible_fraction": frac, "full_tracking": frac * 1300, "vertical_tracking": frac * 1300,
            "sun_elevation": np.full((n_cells, total), 1.0), "sun_azimuth": np.tile(np.linspace(0, 360 * 4, total) % 360, (n_cells, 1)),
            "earth_visible": earth, "terrain": frac * 50, "incidence": np.full((n_cells, total), 80.0),
            "slope_deg": np.array([3.0, 3.0]), "elevation_m": np.array([100.0, 200.0])}


def test_windows_are_scored_per_cell_and_criterion():
    needs = m.resolve_needs({"tier": "mid"}, {"profile": "robotic"}, {"frequency": "mid"}, 15, 2)
    arrays = fake_arrays(2, 240, 10)
    temp = np.full((2, 240), 200.0)
    s = m.score_windows(arrays, temp, 10, 1.0, 2, 10, needs)
    assert s["length"] == 48 and s["starts"][1] == 12            # 12 h stride for short searches
    # Cell 0 is fine everywhere; cell 1 fails power and communication while dark/hidden.
    assert np.all(s["power"][0] == 100) and np.all(s["comm"][0] == 100) and np.all(s["heat"] == 100)
    assert s["dark_h"][1, 0] == 48 and s["power"][1, 0] == 100 * min(1, 0) * 1 + 0
    assert s["comm"][1, -1] == 100 and s["power"][1, -1] == 100       # second half is sunlit and in view
    # Energy: 1300 W/m2 x 48 h x 10 m2 x 0.3 = 187.2 kWh against 1 kW x 48 h = 48 kWh.
    assert s["energy_kwh"][0, 0] == pytest.approx(187.2)
    assert s["need_kwh"] == pytest.approx(48)


def test_heat_is_the_share_of_time_in_range_and_slope_gates_the_base():
    needs = m.resolve_needs({}, {"min_k": 150, "max_k": 250}, {}, 5, 2)
    arrays = fake_arrays(2, 240, 10)
    arrays["slope_deg"] = np.array([3.0, 20.0])
    temp = np.full((2, 240), 200.0)
    temp[0, :24] = 100                                            # first day too cold at cell 0
    s = m.score_windows(arrays, temp, 10, 1.0, 2, 10, needs)
    assert s["heat"][0, 0] == pytest.approx(50)                   # 24 of 48 h in range
    assert s["t_min"][0, 0] == 100 and s["t_max"][0, 0] == 200
    assert np.all(s["site"][1] == 0)                              # too steep for a base
    ws = m.window_scores(s)
    assert np.all(ws["base_cell"] == 0)


def test_fixed_panels_pick_the_best_direction():
    needs = m.resolve_needs({"tracking": False}, {}, {}, 15, 2)
    arrays = fake_arrays(2, 240, 10)
    arrays["sun_azimuth"][:] = 90.0                                # Sun always in the east
    s = m.score_windows(arrays, np.full((2, 240), 200.0), 10, 1.0, 2, 10, needs)
    assert np.all(s["best_az"][0] == 90)
    tracking = m.score_windows(arrays, np.full((2, 240), 200.0), 10, 1.0, 2, 10, m.resolve_needs({}, {}, {}, 15, 2))
    assert s["energy_kwh"][0, 0] == pytest.approx(tracking["energy_kwh"][0, 0] * np.cos(np.radians(1.0)), rel=1e-6)


def test_window_score_combines_base_heat_with_the_best_panel_and_antenna_spots():
    s = {"power": np.array([[100.0], [0.0]]), "comm": np.array([[0.0], [80.0]]), "heat": np.array([[50.0], [100.0]]),
         "slope_ok": np.array([True, True]), "power_ok": np.array([[True], [False]]), "comm_ok": np.array([[False], [True]]),
         "heat_ok": np.array([[False], [True]])}
    ws = m.window_scores(s)
    assert ws["base_cell"][0] == 1 and ws["power_cell"][0] == 0 and ws["comm_cell"][0] == 1
    assert ws["score"][0] == pytest.approx((100 + 100 + 80) / 3)


def test_best_windows_do_not_overlap_by_more_than_half():
    score = np.array([10, 90, 89, 88, 20, 70, 69, 5], float)
    starts = np.arange(8) * 12
    # Window 2 starts 12 h after window 1 (75% overlap): skipped. Window 3 overlaps exactly half: kept.
    assert m.pick_windows(score, starts, 48, 3) == [1, 3, 5]


def test_needs_resolve_basic_choices_and_advanced_overrides():
    n = m.resolve_needs({"tier": "high"}, {"profile": "crewed"}, {"frequency": "high"}, 8, 14)
    assert (n.load_w, n.min_k, n.max_k, n.min_visible_fraction) == (10_000, 100, 330, 0.9)
    n = m.resolve_needs({"tier": "low", "energy_kwh": 336, "tracking": False, "efficiency": 0.25}, {"min_k": 40}, {"max_blackout_hours": 6}, 8, 14)
    assert n.load_w == pytest.approx(1000) and not n.tracking and n.efficiency == 0.25 and n.min_k == 40 and n.max_blackout_hours == 6
    with pytest.raises(m.EnergyError):
        m.resolve_needs({}, {"min_k": 300, "max_k": 200}, {}, 8, 14)


@pytest.fixture
def offline(monkeypatch):
    def fake_cell_arrays(lat, lon, times, progress=None, height_m=2.0):
        out = fake_arrays(2, len(times) - 1, 1)
        n = len(lat)
        arrays = {k: (np.resize(v, (n, v.shape[1])) if v.ndim == 2 else np.resize(v, n)) for k, v in out.items()}
        arrays = {k: (v[:, :len(times)] if v.ndim == 2 else v) for k, v in arrays.items()}
        if progress:
            progress(n, n)
        return arrays
    monkeypatch.setattr(m, "cell_arrays", fake_cell_arrays)
    monkeypatch.setattr(m, "surface_temperature", lambda arrays, h, n_spin: np.full((arrays["terrain"].shape[0], arrays["terrain"].shape[1] - n_spin), 200.0))


def run(client, body):
    started = client.post("/api/mission/search", json=body)
    assert started.status_code == 202, started.text
    for _ in range(200):
        status = client.get(f"/api/mission/search/{started.json()['id']}").json()
        if status["status"] != "running":
            return status
        time.sleep(0.02)
    raise AssertionError("search did not finish")


def test_point_search_ranks_windows(offline):
    with TestClient(app) as client:
        status = run(client, {"where": {"type": "point", "lat": -89.4, "lon": 10}, "start": "2026-12-01T00:00:00Z",
                              "end": "2026-12-31T00:00:00Z", "mission_days": 7})
    assert status["status"] == "done"
    r = status["result"]
    assert r["kind"] == "point" and r["grid"] is None and len(r["cells"]) == 1
    assert len(r["windows"]) >= 1 and r["windows"][0]["score"] >= r["windows"][-1]["score"]
    w = r["windows"][0]
    assert set(w["parts"]) == {"power", "heat", "comm"} and w["base"]["cell"] == 0
    assert len(r["timeline"]["score"]) == r["window_count"]


def test_region_search_returns_maps_and_spots(offline):
    with TestClient(app) as client:
        status = run(client, {"where": {"type": "polygon", "coordinates": BOX}, "start": "2026-12-01T00:00:00Z",
                              "end": "2027-01-15T00:00:00Z", "mission_days": 14,
                              "power": {"tier": "low"}, "heat": {"profile": "crewed"}, "comm": {"frequency": "low"}})
    r = status["result"]
    assert r["grid"]["rows"] > 0 and len(r["grid"]["cell_rows"]) == len(r["cells"]) > 1
    w = r["windows"][0]
    assert len(w["maps"]["site"]) == len(r["cells"]) == len(w["cells"])
    assert len(w["solar_spots"]) == 3 and len(w["comm_spots"]) == 3
    assert r["needs"]["load_w"] == 100


@pytest.mark.parametrize("body,message", [
    ({"end": "2027-07-01T00:00:00Z"}, "at most 180 days"),
    ({"mission_days": 40, "end": "2026-12-20T00:00:00Z"}, "fit inside"),
    ({"start": "2020-01-10T00:00:00Z", "end": "2020-02-01T00:00:00Z"}, "2020-2035"),
    ({"heat": {"min_k": 300, "max_k": 200}}, "above the lowest"),
])
def test_invalid_searches(offline, body, message):
    base = {"where": {"type": "point", "lat": -89.4, "lon": 10}, "start": "2026-12-01T00:00:00Z",
            "end": "2026-12-31T00:00:00Z", "mission_days": 7}
    with TestClient(app) as client:
        response = client.post("/api/mission/search", json=base | body)
    assert response.status_code == 422 and message in response.text


def test_options_list_the_basic_choices():
    with TestClient(app) as client:
        options = client.get("/api/mission/search/options").json()
    assert set(options["power"]) == {"low", "mid", "high"} and set(options["comm"]) == {"high", "mid", "low"}


def flags(power, comm, heat, power_ok, comm_ok, heat_ok, slope_ok):
    a = lambda x, t=float: np.array(x, dtype=t)  # noqa: E731
    return {"power": a(power), "comm": a(comm), "heat": a(heat), "power_ok": a(power_ok, bool), "comm_ok": a(comm_ok, bool),
            "heat_ok": a(heat_ok, bool), "slope_ok": a(slope_ok, bool)}


def test_a_window_that_meets_every_need_ranks_above_a_higher_score_that_fails_one():
    # Window 0: high scores but Earth contact falls short. Window 1: lower, but everything is met.
    s = flags(power=[[100, 70]], comm=[[95, 60]], heat=[[100, 70]], power_ok=[[True, True]], comm_ok=[[False, True]],
              heat_ok=[[True, True]], slope_ok=[True])
    ws = m.window_scores(s)
    assert list(ws["fails"]) == [1, 0]
    assert m.pick_windows(ws["score"], np.array([0, 100]), 10, fails=ws["fails"]) == [1, 0]


def test_the_cable_length_limits_which_panel_and_antenna_spots_a_base_can_use():
    # Cell 0 is a good base but only the far cell 2 has good communication.
    s = flags(power=[[100], [100], [0]], comm=[[0], [0], [100]], heat=[[100], [0], [0]],
              power_ok=[[True], [True], [False]], comm_ok=[[False], [False], [True]],
              heat_ok=[[True], [False], [False]], slope_ok=[True, True, True])
    free = m.window_scores(s)
    assert free["fails"][0] == 0 and free["comm_cell"][0] == 2
    dist = m.separation_km(np.array([-89.0, -89.0, -88.0]), np.array([0.0, 1.0, 0.0]))
    assert dist[0, 2] == pytest.approx(1737.4 * np.radians(1.0), rel=1e-6)
    tied = m.window_scores(s, dist <= 5)
    assert tied["fails"][0] >= 1 and not tied["comm_met"][0]


def test_failure_reasons_say_what_is_missing_in_plain_numbers():
    needs = m.resolve_needs({"tier": "mid"}, {"profile": "robotic"}, {"frequency": "mid"}, 15, 2)
    arrays = fake_arrays(2, 240, 10)
    arrays["earth_visible"][:] = False                             # Earth never in view anywhere
    s = m.score_windows(arrays, np.full((2, 240), 200.0), 10, 1.0, 2, 10, needs)
    ws = m.window_scores(s)
    assert not ws["comm_met"].any()
    reasons = m.failure_reasons(s, ws, 0, needs)
    assert [r["criterion"] for r in reasons] == ["comm"]
    assert "Earth in view 0% (need 50%)" in reasons[0]["text"] and "longest blackout 48 h" in reasons[0]["text"]


def test_equipment_height_is_used_for_panels_and_earth_but_heat_stays_on_the_ground(monkeypatch):
    seen = []

    def fake_series(location, times):
        seen.append(location.height_m)
        n = len(times)
        base = {k: np.full(n, location.height_m) for k in ("visible_fraction", "full_tracking", "vertical_tracking",
                                                            "sun_elevation", "sun_azimuth", "terrain", "incidence")}
        return base | {"earth_visible": np.full(n, location.height_m > 0), "location": {"slope_deg": 2.0, "elevation_m": 10.0}}
    monkeypatch.setattr(m, "series", fake_series)
    out = m.cell_arrays(np.array([-89.0]), np.array([0.0]), [START, START], height_m=3.0)
    assert sorted(seen) == [0, 3.0]
    assert out["earth_visible"][0].all() and out["vertical_tracking"][0, 0] == 3.0
    assert out["terrain"][0, 0] == 0 and out["incidence"][0, 0] == 0



def test_sky_view_returns_the_skyline_and_both_tracks(monkeypatch):
    def fake_series(location, times):
        n = len(times)
        return {"skyline": np.linspace(0, 3, 360), "sun_azimuth": np.full(n, 90.0), "sun_elevation": np.full(n, 1.2),
                "visible_fraction": np.full(n, 0.5), "earth_azimuth": np.full(n, 350.0), "earth_elevation": np.full(n, -2.0),
                "earth_visible": np.zeros(n, bool)}
    monkeypatch.setattr(m, "series", fake_series)
    out = m.sky_view(-89.4, 10, START, START + timedelta(days=10), 2.0, max_samples=100)
    assert len(out["skyline_deg"]) == 360 and out["height_m"] == 2.0
    assert out["step_hours"] == 2.5 and len(out["times"]) == len(out["sun"]["azimuth_deg"]) == 97
    assert out["earth"]["visible"][0] is False and out["sun"]["visible_fraction"][0] == 0.5


def test_sky_endpoint_validates_the_period():
    with TestClient(app) as client:
        r = client.get("/api/mission/sky", params={"lat": -89.4, "lon": 10, "start": "2026-12-10T00:00:00Z", "end": "2026-12-01T00:00:00Z"})
    assert r.status_code == 422 and "ends after it starts" in r.text
