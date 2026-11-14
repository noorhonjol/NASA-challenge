from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import get_session
from app.main import app


def test_pgda81_catalog_replaces_regional_product_with_verified_lunar_metadata():
    response = TestClient(app).get("/api/terrain-datasets")
    assert response.status_code == 200
    assert not any((row["catalog_key"] or "").startswith("pgda-78:") for row in response.json())
    records = [row for row in response.json() if row["catalog_key"] == "pgda-81:87S"]
    assert len(records) == 1
    for row in records:
        assert row["resolution_m"] == 5
        assert row["source"] == "https://pgda.gsfc.nasa.gov/products/81"
        assert row["file_uri"].endswith("ldem_87s_5mpp.tif")
        assert "+a=1737400" in row["crs"]
        assert "4326" not in row["crs"]
        p = row["provenance"]
        assert p["frame"] == "MOON_ME" and p["ephemeris"] == "DE421"
        assert p["storage_status"] in ("remote", "downloaded")
        assert p["terrain_ready"] == (p["storage_status"] == "downloaded")
        assert p["product_id"] == 81
        assert p["coverage_latitude_deg"] == [-90,-87]
        assert p["citation_doi"] == "10.1016/j.pss.2020.105119"
        if p["terrain_ready"]:
            assert p["local"]["chunks"]["width"] == 40000
            assert p["local"]["chunks"]["height"] == 40000
            assert p["local"]["native_resolution_m"] == 5
            assert p["local"]["size_bytes"] == 3465285714


def test_mosaic_dataset_is_retrievable_with_its_actual_native_spacing():
    client = TestClient(app)
    row = next(row for row in client.get("/api/terrain-datasets").json() if row["catalog_key"] == "pgda-81:87S")
    response = client.get(f"/api/terrain-datasets/{row['id']}")
    assert response.status_code == 200
    assert response.json() == row
    assert row["resolution_m"] == 5
    if row["provenance"]["terrain_ready"]:
        assert row["provenance"]["local"]["bounds_xy_m"] == [-100000,-100000,100000,100000]


def test_missing_dataset_is_404_and_invalid_id_is_422():
    client = TestClient(app)
    assert client.get("/api/terrain-datasets/999999999").status_code == 404
    assert client.get("/api/terrain-datasets/not-an-id").status_code == 422


def test_terrain_api_reports_database_failure_without_connection_details():
    class BrokenSession:
        def exec(self, *args, **kwargs):
            raise OperationalError("SELECT", {}, Exception("private host"))

        def get(self, *args, **kwargs):
            raise OperationalError("SELECT", {}, Exception("private host"))

    def broken():
        yield BrokenSession()

    app.dependency_overrides[get_session] = broken
    try:
        client = TestClient(app)
        for route in ("/api/terrain-datasets", "/api/terrain-datasets/1"):
            response = client.get(route)
            assert response.status_code == 503
            assert response.json() == {"detail": "database unavailable"}
    finally:
        app.dependency_overrides.clear()
