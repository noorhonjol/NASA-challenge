import json
import gzip
from io import BytesIO

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
import pytest

from app import terrain
from app.main import app


@pytest.fixture
def local_terrain(tmp_path, monkeypatch):
    np.full((2, 4), 200, dtype="<i2").tofile(tmp_path / "global.img")
    yy, xx = np.indices((401, 401))
    np.save(tmp_path / "region.npy", (500 + 3*xx + 4*yy).astype("<f4"))
    region = {
        "id": 1, "catalog_key": "test-region", "region_id": "Test", "name": "Fixture",
        "resolution_m": 5, "file": "region.npy", "width": 401, "height": 401,
        "bounds_xy_m": [-1002.5, -1002.5, 1002.5, 1002.5], "pixel_center_origin_xy_m": [-1000, 1000],
        "center": {"latitude": -90, "longitude": 0, "elevation": 1900},
        "min_elevation_m": 500, "max_elevation_m": 3300, "frame": "MOON_ME", "ephemeris": "DE421",
    }
    m = {
        "version": "fixture", "tile_size": 65, "reference_radius_m": 1737400, "citation": "test",
        "baseline": {"key": "fixture-global", "file": "global.img", "width": 4, "height": 2,
                     "pixels_per_degree": 1/90, "scale": .5, "source": "fixture", "min_elevation_m": 100, "max_elevation_m": 100},
        "regions": [region],
    }
    (tmp_path / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    return m, tmp_path


def test_south_polar_transform_matches_projection_axes():
    x, y = terrain.south_polar_xy(-90, 0)
    assert x == pytest.approx(0, abs=1e-8) and y == pytest.approx(0, abs=1e-8)
    x, y = terrain.south_polar_xy(-89, 90)
    assert x > 30000 and y == pytest.approx(0, abs=1e-8)
    x, y = terrain.south_polar_xy(-89, 0)
    assert y > 30000 and x == pytest.approx(0, abs=1e-8)


def test_samples_original_pixel_centers_and_global_height_datum(local_terrain):
    m, root = local_terrain
    heights = terrain.sample_heights(m, root, np.array([-90, 45]), np.array([0, 0]))
    assert heights[0] == pytest.approx(1900)
    assert heights[1] == pytest.approx(100)  # DN * .5, not lunar radius + height


def test_circular_coverage_blends_to_baseline_at_the_circle(local_terrain):
    m, root = local_terrain
    m["regions"][0]["coverage_radius_m"] = 500
    def lat_at(rho):  # on the 0 deg meridian: x = 0, y = rho
        return np.degrees(2 * np.arctan(rho / (2 * 1737400)) - np.pi / 2)
    heights = terrain.sample_heights(m, root, lat_at(np.array([400.0, 500.0, 800.0])), np.zeros(3))
    w = 0.4 * 0.4 * (3 - 2 * 0.4)   # smoothstep(100 m / 250 m)
    local = 500 + 3 * 200 + 4 * 120   # fixture value at x = 0, y = 400
    assert heights[0] == pytest.approx(100 * (1 - w) + local * w, rel=1e-6)
    assert heights[1] == pytest.approx(100) and heights[2] == pytest.approx(100)


def test_bilinear_nodata_and_seam_wrapping():
    grid = np.array([[1, np.nan], [3, 5]])
    assert terrain.bilinear(grid, np.array([.5]), np.array([.5]))[0] == pytest.approx(3)
    grid = np.array([[10, 30], [10, 30]])
    assert terrain.bilinear(grid, np.array([1.5]), np.array([0]), wrap_x=True)[0] == pytest.approx(20)


def test_neighboring_heightmap_edges_agree_and_binary_is_little_endian_float32(local_terrain):
    client = TestClient(app)
    a = client.get("/api/terrain/tiles/0/0/0.bin?v=fixture")
    b = client.get("/api/terrain/tiles/0/1/0.bin?v=fixture")
    assert a.status_code == b.status_code == 200
    assert len(a.content) == 65*65*4
    left = np.frombuffer(a.content, dtype="<f4").reshape((65, 65))
    right = np.frombuffer(b.content, dtype="<f4").reshape((65, 65))
    np.testing.assert_array_equal(left[:, -1], right[:, 0])
    assert left[-1, -1] == pytest.approx(1900)
    assert np.isfinite(left).all() and float(left.max()) > float(left.min())
    assert "immutable" in a.headers["cache-control"]


def test_hillshade_is_transparent_outside_regions_and_visible_inside(local_terrain):
    client = TestClient(app)
    north = client.get("/api/terrain/imagery/0/0/0.png?v=fixture")
    assert north.status_code == 200
    north_pixels = np.asarray(Image.open(BytesIO(north.content)))
    assert north_pixels[:, :, 3].max() == 0
    south = client.get("/api/terrain/imagery/10/1024/1023.png?v=fixture")
    pixels = np.asarray(Image.open(BytesIO(south.content)))
    assert pixels[:, :, 3].max() == 255


def test_manifest_hides_local_paths_and_tiles_reject_invalid_coordinates(local_terrain):
    client = TestClient(app)
    response = client.get("/api/terrain/manifest")
    assert response.status_code == 200
    assert "file" not in response.json()["regions"][0]
    assert client.get("/api/terrain/tiles/0/2/0.bin").status_code == 404
    assert client.get("/api/terrain/tiles/21/0/0.bin").status_code == 404
    assert client.get("/api/terrain/tiles/0/0/0.bin?v=old").status_code == 409


def test_missing_downloads_and_outside_paths_are_explicit(tmp_path, monkeypatch):
    monkeypatch.setattr(terrain, "data_root", lambda: tmp_path)
    assert TestClient(app).get("/api/terrain/manifest").status_code == 503
    with pytest.raises(terrain.TerrainUnavailable):
        terrain.local_path(tmp_path, "../outside.npy")


def test_browser_assets_are_prebuilt_static_files_with_compression_and_versioned_caching(local_terrain):
    _, root = local_terrain
    encoded = np.array([1, 2, 3, 4], dtype="<i2").tobytes()
    (root/"static.gz").write_bytes(gzip.compress(encoded))
    image=BytesIO(); Image.new("RGBA",(2,2),(80,80,80,255)).save(image,format="PNG")
    (root/"relief.png").write_bytes(image.getvalue())
    metadata={"version":"browser-fixture","baseline":{"file":"static.gz"},"regions":[{"id":1,"grid_file":"static.gz","imagery_file":"relief.png","chunks":{"available":["0/0"],"file_pattern":"static.gz"}}]}
    (root/"browser-manifest.json").write_text(json.dumps(metadata))
    client=TestClient(app)
    response=client.get("/api/terrain/assets/regions/1/grid.bin?v=browser-fixture")
    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert response.content == encoded
    assert "immutable" in response.headers["cache-control"]
    assert client.get("/api/terrain/assets/regions/1/relief.png?v=browser-fixture").content == image.getvalue()
    assert client.get("/api/terrain/assets/regions/999/grid.bin").status_code == 404
    assert client.get("/api/terrain/assets/global.bin?v=old").status_code == 409
    assert client.get("/api/terrain/assets/mosaics/1/chunks/0/0.bin?v=browser-fixture").content == encoded
    assert client.get("/api/terrain/assets/mosaics/1/chunks/-1/0.bin").status_code == 404
    assert client.get("/api/terrain/assets/mosaics/1/chunks/2/2.bin").status_code == 404
    assert client.get("/api/terrain/assets/mosaics/1/chunks/0/0.bin?v=old").status_code == 409
