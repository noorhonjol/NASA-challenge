import httpx
import pytest
from fastapi.testclient import TestClient

from app.horizons import HorizonsError, parse_position
from app.main import app


def test_parses_real_horizons_csv_and_preserves_negative_elevation():
    assert parse_position("$$SOE\n 2026-Nov-14 12:00:00.000,*, ,351.321038,-2.100314,\n$$EOE") == {
        "azimuth_deg": 351.321038, "elevation_deg": -2.100314, "above_horizon": False}


def test_reads_horizons_observer_range_in_au_as_kilometers():
    result = parse_position("$$SOE\n date,*, ,120,5,0.00257,0.001,\n$$EOE")
    assert result["distance_km"] == pytest.approx(384466.527699)


def test_rejects_invalid_range():
    with pytest.raises(HorizonsError):
        parse_position("$$SOE\n date,*, ,120,5,nan,0.001,\n$$EOE")


@pytest.mark.parametrize("result", ["error", "$$SOE\n date, , ,n.a.,n.a.,\n$$EOE", "$$SOE\n date, , ,1,nan,\n$$EOE"])
def test_rejects_invalid_upstream_results(result):
    with pytest.raises(HorizonsError):
        parse_position(result)


@pytest.mark.parametrize("query", ["lat=91&lon=0&at=2026-11-14T12:00:00Z", "lat=0&lon=0&at=2026-11-14T12:00:00", "lat=0&lon=181&at=2026-11-14T12:00:00Z"])
def test_rejects_invalid_observer_inputs(query):
    assert TestClient(app).get(f"/api/positions?{query}").status_code == 422


def test_endpoint_queries_both_bodies_without_database(monkeypatch):
    requests = []

    async def fake_get(self, url, params):
        requests.append(params)
        return httpx.Response(200, request=httpx.Request("GET", url), json={"result": "$$SOE\n date, , ,120,5,\n$$EOE"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    response = TestClient(app).get("/api/positions?lat=-89&lon=-30&elevation_m=1400&at=2026-11-14T12:00:00Z")
    assert response.status_code == 200
    assert response.json()["earth"]["above_horizon"] is True
    assert [r["COMMAND"] for r in requests] == ["'10'", "'399'"]
    assert requests[0]["SITE_COORD"] == "'-30.0,-89.0,1.4'"


def test_upstream_error_returns_502(monkeypatch):
    async def fake_get(self, url, params):
        raise httpx.ConnectError("offline")
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    assert TestClient(app).get("/api/positions?lat=0&lon=0&at=2026-11-14T12:00:00Z").status_code == 502
