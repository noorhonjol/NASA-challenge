import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.main import app


def test_health_reports_database_ok():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_missing_database_url_names_the_variable(monkeypatch):
    from app import settings

    monkeypatch.delenv("DATABASE_URL", raising=False)
    # _env_file=None keeps the test hermetic: a contributor's backend/.env must
    # not satisfy the requirement this test is asserting.
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        settings.Settings(_env_file=None)


def test_health_reports_503_when_database_unavailable():
    from app.db import get_session

    class BrokenSession:
        def execute(self, *args, **kwargs):
            raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    def broken_session():
        yield BrokenSession()

    app.dependency_overrides[get_session] = broken_session
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/health")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json() == {"status": "error", "database": "unavailable"}
