from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import get_session
from app.main import app


class BrokenSession:
    def exec(self, *args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    def get(self, *args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))


def test_sites_lists_named_lola_regions_without_fictional_sites():
    response = TestClient(app).get("/api/sites")
    assert response.status_code == 200
    sites = response.json()
    assert len(sites) == 27
    slugs = {site["slug"] for site in sites}
    assert {"pgda-78-site01", "pgda-78-site04"} <= slugs
    assert all(site["is_fictional"] is False for site in sites)
    assert all(site["frame"] == "MOON_ME" for site in sites)


def test_site_with_null_elevation_serializes_as_null():
    sites = TestClient(app).get("/api/sites").json()
    basin = next(site for site in sites if site["slug"] == "pgda-78-dm1")
    assert basin["elevation_m"] is None


def test_unknown_site_id_returns_404():
    response = TestClient(app).get("/api/sites/999999")
    assert response.status_code == 404
    assert "detail" in response.json()


def test_non_numeric_site_id_returns_422():
    assert TestClient(app).get("/api/sites/abc").status_code == 422


def test_site_by_id_returns_the_seeded_site():
    client = TestClient(app)
    listed = client.get("/api/sites").json()
    site = next(item for item in listed if item["slug"] == "pgda-78-site04")
    response = client.get(f"/api/sites/{site['id']}")
    assert response.status_code == 200
    assert response.json() == site


def test_sites_reports_503_when_database_unavailable():
    def broken_session():
        yield BrokenSession()

    app.dependency_overrides[get_session] = broken_session
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/sites")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"] == "database unavailable"


def test_site_by_id_reports_503_when_database_unavailable():
    def broken_session():
        yield BrokenSession()

    app.dependency_overrides[get_session] = broken_session
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/sites/1")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"] == "database unavailable"
