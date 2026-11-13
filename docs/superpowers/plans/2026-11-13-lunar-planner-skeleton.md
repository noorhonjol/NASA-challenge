# Lunar Planner Phase 1 Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skeleton that boots end to end: Flyway-migrated Postgres with fictional lunar sites, a FastAPI backend serving them, and a React/TypeScript frontend listing them through the `/api` proxy.

**Architecture:** PostgreSQL runs in Docker and is the only container along with a `tools`-profiled Flyway container; backend and frontend run on the host. The backend maps the four tables with SQLAlchemy 2.x (no `create_all()`), exposes everything under `/api`, and the Vite dev server proxies `/api` to `localhost:8000`.

**Tech Stack:** PostgreSQL 16, Flyway 10, FastAPI, SQLAlchemy 2.x, psycopg 3, Pydantic Settings, Vite 7, React, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-lunar-planner-skeleton-design.md`

## Global Constraints

- Schema changes only via `db/migration/V<number>__description.sql`; never edit an applied migration.
- Never call `create_all()`; no Alembic in `requirements.txt`.
- The database port binds to `127.0.0.1` only, never `0.0.0.0`.
- `.env` is gitignored; `.env.example` contains only placeholder passwords.
- No `cesium` dependency; the viewer is a labelled placeholder.
- All API routes live under `/api`; the frontend proxies only `/api`.
- Lunar coordinates are stored with an explicit frame label (`MOON_ME`); no `EPSG:4326` anywhere.
- Seed sites are fictional: `is_fictional = true` and "(fictional)" in every `name`.
- No seeded `analysis_runs` or `visibility_windows` rows.
- Node 22.20 / Python 3.12 in this environment; Vite 7 requires Node 20.19+.

## Review Focus

These are the failure modes the spec implies but no single task's happy-path test covers. Each has a test in the task that owns the code.

1. **Database unreachable at startup** — `/api/health` and `/api/sites` must name the problem, not return an empty list or an HTML stack trace.
2. **`DATABASE_URL` missing** — the app must say which variable is unset, rather than failing deep inside psycopg.
3. **Bad site ids** — `/api/sites/999999` returns 404 and `/api/sites/abc` returns 422, both JSON.
4. **Backend down while the page is open** — the frontend shows an error state, never a blank page or a spinner that never stops.
5. **Sites with no elevation** — `elevation_m` null must serialize as `null` and render as an em dash, not `NaN` or a crash.

---

### Task 1: Compose and environment scaffolding

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `.env` (copy of `.env.example`, never committed)

**Interfaces:**
- Consumes: nothing.
- Produces: service name `db` (Postgres 16, healthcheck `pg_isready`), service `flyway` under profile `tools` mounting `./db/migration` at `/flyway/sql`; env vars `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`. Later tasks assume database `lunar_planner` and user `lunar` reachable at `localhost:5432`.

- [ ] **Step 1: Write `.gitignore`**

Must cover: `.env`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `node_modules/`, `dist/`, `*.pyc`.

- [ ] **Step 2: Write `.env.example`**

```
POSTGRES_USER=lunar
POSTGRES_PASSWORD=local_dev_password_change_me
POSTGRES_DB=lunar_planner
DATABASE_URL=postgresql+psycopg://lunar:local_dev_password_change_me@localhost:5432/lunar_planner
```

- [ ] **Step 3: Write `docker-compose.yml`**

`db`: image `postgres:16-alpine`, `env_file: .env`, ports `127.0.0.1:5432:5432`, named volume `pgdata:/var/lib/postgresql/data`, healthcheck `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB` with interval 5s, timeout 3s, retries 10. `flyway`: image `flyway/flyway:10`, `profiles: ["tools"]`, `depends_on: db: condition: service_healthy`, `env_file: .env`, volume `./db/migration:/flyway/sql:ro`, command `-url=jdbc:postgresql://db:5432/lunar_planner -user=lunar -password=${POSTGRES_PASSWORD} -connectRetries=10 -locations=filesystem:/flyway/sql`.

- [ ] **Step 4: Copy `.env.example` to `.env`**

Run: `Copy-Item .env.example .env`

- [ ] **Step 5: Verify the database starts**

Run: `docker compose up -d db`
Then: `docker compose exec db psql -U lunar -d lunar_planner -c 'SELECT 1;'`
Expected: `(1 row)` and no error. `docker compose ps` shows `db` as `healthy`.

- [ ] **Step 6: Confirm the port is loopback-only**

Run: `docker compose port db 5432`
Expected: `127.0.0.1:5432`, never `0.0.0.0:5432`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .env.example docker-compose.yml
git commit -m "chore: add compose stack and environment scaffolding"
```

---

### Task 2: Flyway migrations for the four-table core

**Files:**
- Create: `db/migration/V1__core_schema.sql`
- Create: `db/migration/V2__seed_fictional_sites.sql`

**Interfaces:**
- Consumes: `db` service and `flyway` profile from Task 1.
- Produces: tables `sites`, `terrain_datasets`, `analysis_runs`, `visibility_windows` with exactly the columns in the spec's schema table, and three seeded `sites` rows with slugs `shackleton-rim-fictional`, `malapert-massif-fictional`, `de-gerlache-basin-fictional`.

- [ ] **Step 1: Write `V1__core_schema.sql`**

Implement the spec's four tables verbatim, including: `sites.slug` unique, `sites.frame` not null, `sites.is_fictional` not null default `true`, range CHECKs on `lat_deg`/`lon_deg`, FK `analysis_runs.site_id` and `visibility_windows.analysis_run_id` with `ON DELETE CASCADE`, `analysis_runs.status` CHECK in `('pending','running','succeeded','failed')`, `visibility_windows` CHECK `end_utc > start_utc`, and indexes `ix_analysis_runs_site_id`, `ix_visibility_windows_analysis_run_id`. All timestamps `timestamptz`.

- [ ] **Step 2: Write `V2__seed_fictional_sites.sql`**

```sql
INSERT INTO sites (slug, name, lat_deg, lon_deg, elevation_m, frame, is_fictional, notes)
VALUES
  ('shackleton-rim-fictional', 'Shackleton Rim (fictional)', -89.45, 129.20, 1400.0, 'MOON_ME', true,
   'Fictional placeholder near the lunar south pole rim. Not a surveyed site; no terrain or ephemeris data behind it.'),
  ('malapert-massif-fictional', 'Malapert Massif (fictional)', -86.00, 2.70, 5000.0, 'MOON_ME', true,
   'Fictional placeholder on a high peak near the south pole. Coordinates are illustrative only.'),
  ('de-gerlache-basin-fictional', 'de Gerlache Basin Floor (fictional)', -88.50, -87.10, NULL, 'MOON_ME', true,
   'Fictional permanently shadowed basin placeholder with unknown elevation, used to exercise null handling.');
```

No rows are inserted into `analysis_runs` or `visibility_windows`.

- [ ] **Step 3: Apply migrations**

Run: `docker compose --profile tools run --rm flyway`
Expected: output lists `Migrating schema "public" to version "1 - core schema"` and `"2 - seed fictional sites"`, ending with `Successfully applied 2 migrations`.

- [ ] **Step 4: Verify schema history and seed rows**

Run: `docker compose exec db psql -U lunar -d lunar_planner -c "SELECT installed_rank, version, success FROM flyway_schema_history ORDER BY installed_rank;"`
Expected: two rows, both `success = t`.

Run: `docker compose exec db psql -U lunar -d lunar_planner -c "SELECT slug, frame, is_fictional, elevation_m FROM sites ORDER BY slug;"`
Expected: three rows, all `is_fictional = t`, all `frame = MOON_ME`, and `de-gerlache-basin-fictional` with empty (NULL) elevation.

- [ ] **Step 5: Verify the migrations are idempotent and the checks guards hold**

Run the flyway command from Step 3 a second time.
Expected: `Schema "public" is up to date. No migration necessary.`

Then run:
`docker compose exec db psql -U lunar -d lunar_planner -c "INSERT INTO visibility_windows (analysis_run_id, kind, start_utc, end_utc) VALUES (1, 'test', now(), now() - interval '1 hour');"`
Expected: error `violates check constraint`. This confirms the end-after-start guard exists.

- [ ] **Step 6: Commit**

```bash
git add db/migration
git commit -m "feat: add core schema and fictional seed sites"
```

---

### Task 3: Backend service, settings, and `/api/health`

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/.env.example`
- Create: `backend/app/__init__.py`
- Create: `backend/app/settings.py`
- Create: `backend/app/db.py`
- Create: `backend/app/main.py`
- Create: `backend/pytest.ini`
- Test: `backend/tests/test_health.py`
- Test: `backend/tests/conftest.py`

**Interfaces:**
- Consumes: database from Tasks 1–2.
- Produces: `app.settings.Settings` with field `database_url` (env alias `DATABASE_URL`) and `app.settings.get_settings() -> Settings`; `app.db.engine`, `app.db.SessionLocal`, `app.db.get_session() -> Iterator[Session]`; `app.main.create_app() -> FastAPI` and module-level `app`. `GET /api/health` returns `{"status": "ok", "database": "ok"}`.

- [ ] **Step 1: Write `backend/requirements.txt`**

```
fastapi
uvicorn[standard]
sqlalchemy
psycopg[binary]
pydantic-settings
pytest
httpx
```

- [ ] **Step 2: Create the virtualenv and install**

Run: `py -m venv .venv`, then `.\.venv\Scripts\python.exe -m pip install -r requirements.txt` (both from `backend`).

- [ ] **Step 3: Write the failing tests**

`backend/tests/conftest.py` must, before importing `app.main`, set `os.environ["DATABASE_URL"]` from a `DATABASE_URL` already present in the environment or the local default in `.env.example`.

`backend/tests/test_health.py`:

```python
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
    monkeypatch.setattr(settings, "ENV_FILE", None)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        settings.Settings()


def test_health_reports_503_when_database_unavailable():
    from app.db import get_session

    def broken_session():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    app.dependency_overrides[get_session] = broken_session
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/health")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json() == {"status": "error", "database": "unavailable"}
```

Add `import pytest` at the top of that file.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_health.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 5: Implement `backend/app/settings.py`**

`ENV_FILE = ".env"` module constant. `Settings(BaseSettings)` with `database_url: str` validated to be non-empty and to start with `postgresql`, model_config reading `ENV_FILE`, and a `model_validator` that raises `RuntimeError("DATABASE_URL is not set. Copy backend/.env.example to backend/.env or export DATABASE_URL.")` when unset. `get_settings()` cached with `functools.lru_cache`.

- [ ] **Step 6: Implement `backend/app/db.py`**

`engine = create_engine(get_settings().database_url, pool_pre_ping=True)`, `SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)`, and `get_session()` as a generator-yielding dependency that closes the session in `finally`.

- [ ] **Step 7: Implement `backend/app/main.py` with the health route**

`create_app()` builds `FastAPI(title="Lunar Planner API")`, adds `CORSMiddleware` allowing origin `http://localhost:5173` only, and registers `GET /api/health` that executes `text("SELECT 1")` on the session. On success return `{"status": "ok", "database": "ok"}`; on `SQLAlchemyError` return `JSONResponse(status_code=503, content={"status": "error", "database": "unavailable"})`. Module-level `app = create_app()`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_health.py -v`
Expected: 3 passed.

- [ ] **Step 9: Verify the server serves docs and health on the host**

Run in one terminal: `$env:DATABASE_URL = 'postgresql+psycopg://lunar:local_dev_password_change_me@localhost:5432/lunar_planner'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload`
Then: `curl.exe -s http://localhost:8000/api/health` and `curl.exe -s -o NUL -w "%{http_code}" http://localhost:8000/docs`
Expected: `{"status":"ok","database":"ok"}` and `200`.

- [ ] **Step 10: Commit**

```bash
git add backend/requirements.txt backend/.env.example backend/app backend/tests backend/pytest.ini
git commit -m "feat: add backend service with database health check"
```

---

### Task 4: Models, schemas, and site endpoints

**Files:**
- Create: `backend/app/models.py`
- Create: `backend/app/schemas.py`
- Create: `backend/app/routers/__init__.py`
- Create: `backend/app/routers/sites.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_sites.py`

**Interfaces:**
- Consumes: `app.db.get_session`, `create_app()` from Task 3.
- Produces: `app.models.Base`, `Site`, `TerrainDataset`, `AnalysisRun`, `VisibilityWindow` mapped with `Mapped[...]` 2.0 style; `app.schemas.SiteOut`; `app.routers.sites.router` with `GET /api/sites -> list[SiteOut]` and `GET /api/sites/{site_id} -> SiteOut`. `SiteOut` fields: `id: int`, `slug: str`, `name: str`, `lat_deg: float`, `lon_deg: float`, `elevation_m: float | None`, `frame: str`, `is_fictional: bool`, `notes: str | None`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_sites.py`:

```python
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import get_session
from app.main import app


def test_sites_lists_seeded_fictional_sites():
    response = TestClient(app).get("/api/sites")
    assert response.status_code == 200
    sites = response.json()
    assert len(sites) >= 3
    slugs = {site["slug"] for site in sites}
    assert {"shackleton-rim-fictional", "malapert-massif-fictional"} <= slugs
    assert all(site["is_fictional"] is True for site in sites)
    assert all(site["frame"] == "MOON_ME" for site in sites)


def test_site_with_null_elevation_serializes_as_null():
    sites = TestClient(app).get("/api/sites").json()
    basin = next(site for site in sites if site["slug"] == "de-gerlache-basin-fictional")
    assert basin["elevation_m"] is None


def test_unknown_site_id_returns_404():
    response = TestClient(app).get("/api/sites/999999")
    assert response.status_code == 404
    assert "detail" in response.json()


def test_non_numeric_site_id_returns_422():
    assert TestClient(app).get("/api/sites/abc").status_code == 422


def test_sites_reports_503_when_database_unavailable():
    def broken_session():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    app.dependency_overrides[get_session] = broken_session
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/sites")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"] == "database unavailable"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_sites.py -v`
Expected: FAIL — `404` on `/api/sites` (route does not exist yet) or import errors for `app.models`.

- [ ] **Step 3: Implement `backend/app/models.py`**

`Base = DeclarativeBase`, then the four classes with `__tablename__` matching the spec exactly and column names/types matching `V1`. Relationships: `Site.analysis_runs`, `AnalysisRun.site`, `AnalysisRun.visibility_windows`. Do not add `create_all()` calls anywhere.

- [ ] **Step 4: Implement `backend/app/schemas.py`**

`SiteOut(BaseModel)` with `model_config = ConfigDict(from_attributes=True)` and the fields listed in Interfaces.

- [ ] **Step 5: Implement `backend/app/routers/sites.py`**

`router = APIRouter(prefix="/api/sites", tags=["sites"])`. List endpoint: `select(Site).order_by(Site.name)`. Detail endpoint: `session.get(Site, site_id)` and `HTTPException(404, "site not found")` when absent. A small helper `_unavailable()` returns `HTTPException(503, "database unavailable")`; the router catches `SQLAlchemyError` and raises it.

- [ ] **Step 6: Register the router in `backend/app/main.py`**

`create_app()` includes `sites.router` after the health route.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `.\.venv\Scripts\python.exe -m pytest -v`
Expected: 8 passed (3 health + 5 sites).

- [ ] **Step 8: Spot-check the live API**

With uvicorn running, run: `curl.exe -s http://localhost:8000/api/sites` and `curl.exe -s -o NUL -w "%{http_code}" http://localhost:8000/api/sites/999999`
Expected: JSON array of three sites with `frame: "MOON_ME"`; then `404`.

- [ ] **Step 9: Commit**

```bash
git add backend/app/models.py backend/app/schemas.py backend/app/routers backend/app/main.py backend/tests/test_sites.py
git commit -m "feat: add site models and read endpoints"
```

---

### Task 5: Frontend scaffold with `/api` proxy

**Files:**
- Create: `frontend/` (Vite React-TS template), including `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`

**Interfaces:**
- Consumes: backend on `localhost:8000`.
- Produces: dev server on `5173` proxying `/api` to the backend; `src/App.tsx` exporting default `App`.

- [ ] **Step 1: Scaffold the template**

Run from the repo root: `npm.cmd create vite@latest frontend -- --template react-ts`
Then: `cd frontend; npm.cmd install`

- [ ] **Step 2: Configure the proxy in `frontend/vite.config.ts`**

Add `server: { proxy: { "/api": "http://localhost:8000" } }` to the existing config, leaving the React plugin intact.

- [ ] **Step 3: Verify the proxy reaches the backend before writing any UI**

With uvicorn running, start `npm.cmd run dev`, then run: `curl.exe -s http://localhost:5173/api/sites`
Expected: the same JSON array the backend returns. A 500 or HTML response means the proxy target is wrong.

- [ ] **Step 4: Verify non-API paths are not proxied**

Run: `curl.exe -s http://localhost:5173/src/main.tsx`
Expected: JavaScript module source, not a backend response. This proves only `/api` is forwarded.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "chore: scaffold Vite React TypeScript frontend with api proxy"
```

---

### Task 6: Typed client, site table, and viewer placeholder

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/components/SiteList.tsx`
- Create: `frontend/src/components/ViewerPlaceholder.tsx`
- Create: `frontend/src/api/client.test.ts`
- Create: `frontend/src/components/SiteList.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/index.css`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/package.json`
- Delete: `frontend/src/App.css`, `frontend/src/assets/react.svg` (unused template assets)

**Interfaces:**
- Consumes: proxy from Task 5.
- Produces: `export type Site = { id: number; slug: string; name: string; lat_deg: number; lon_deg: number; elevation_m: number | null; frame: string; is_fictional: boolean; notes: string | null }` and `export async function fetchSites(): Promise<Site[]>` in `src/api/client.ts`; `SiteList({ sites }: { sites: Site[] })` and `ViewerPlaceholder()` components.

- [ ] **Step 1: Add test tooling**

Run: `npm.cmd install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`
Add `"test": "vitest run"` to `package.json` scripts and to `vite.config.ts`: `test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] }` (import `@testing-library/jest-dom/vitest` there).

- [ ] **Step 2: Write the failing client test**

`frontend/src/api/client.test.ts`:

```ts
import { afterEach, expect, test, vi } from "vitest";
import { fetchSites } from "./client";

afterEach(() => vi.unstubAllGlobals());

test("fetchSites requests /api/sites and returns parsed sites", async () => {
  const payload = [
    { id: 1, slug: "a", name: "A (fictional)", lat_deg: -89.45, lon_deg: 129.2, elevation_m: null, frame: "MOON_ME", is_fictional: true, notes: null },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
  await expect(fetchSites()).resolves.toEqual(payload);
  expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/sites");
});

test("fetchSites throws with the status when the backend fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "database unavailable" }) }));
  await expect(fetchSites()).rejects.toThrow("503");
});
```

- [ ] **Step 3: Write the failing `SiteList` test**

`frontend/src/components/SiteList.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SiteList } from "./SiteList";

const basin = { id: 3, slug: "basin", name: "Basin (fictional)", lat_deg: -88.5, lon_deg: -87.1, elevation_m: null, frame: "MOON_ME", is_fictional: true, notes: null };

test("renders site name, frame, and an em dash for null elevation", () => {
  render(<SiteList sites={[basin]} />);
  expect(screen.getByText("Basin (fictional)")).toBeInTheDocument();
  expect(screen.getByText("MOON_ME")).toBeInTheDocument();
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("renders an empty message when there are no sites", () => {
  render(<SiteList sites={[]} />);
  expect(screen.getByText(/no sites/i)).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm.cmd test`
Expected: FAIL — cannot resolve `./client` and `./SiteList`.

- [ ] **Step 5: Implement `frontend/src/api/client.ts`**

The `Site` type from Interfaces, and `fetchSites()` doing `fetch("/api/sites")`, throwing `new Error(\`Request failed with status ${res.status}\`)` when `!res.ok`, otherwise `res.json()`.

- [ ] **Step 6: Implement `frontend/src/components/SiteList.tsx`**

A table with headers Name, Slug, Latitude, Longitude, Elevation (m), Frame. `elevation_m` renders `site.elevation_m ?? "—"`; latitudes/longitudes render with `toFixed(2)`. When `sites.length === 0`, render `<p>No sites yet.</p>` instead of the table.

- [ ] **Step 7: Implement `frontend/src/components/ViewerPlaceholder.tsx`**

A bordered panel with heading "Lunar viewer" and body text "Placeholder for the CesiumJS lunar globe. Terrain and ephemeris data arrive in later phases." No Cesium import.

- [ ] **Step 8: Rewrite `frontend/src/App.tsx`**

`useState<Site[] | null>(null)`, `useState<string | null>(null)`, a `useEffect` calling `fetchSites()` with a cancelled flag. Render: heading "Lunar Planner", a banner "Phase 1 skeleton — sites are fictional and no visibility analysis is computed.", then the loading text, the error state (heading "Could not load sites" plus the error message and a "Retry" button that re-runs the fetch), the `SiteList`, and the `ViewerPlaceholder`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm.cmd test`
Expected: 4 passed.

- [ ] **Step 10: Pin the App error state with a test**

`frontend/src/App.test.tsx`: the App already renders an error state from Step 8; this test locks that behaviour in and guards against a future change turning a failed fetch into a blank page.

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

afterEach(() => vi.unstubAllGlobals());

test("shows an error state when the backend is unreachable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  render(<App />);
  expect(await screen.findByText(/could not load sites/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});
```

Run: `npm.cmd test`
Expected: 5 passed.

- [ ] **Step 11: Verify in the browser**

With backend running, `npm.cmd run dev`, open `http://localhost:5173`.
Expected: three fictional sites in the table, the basin row showing `—`, and the viewer placeholder panel. Stop the backend and press Retry: the error state appears instead of a blank page.

- [ ] **Step 12: Commit**

```bash
git add frontend
git commit -m "feat: add typed site client, site table, and viewer placeholder"
```

---

### Task 7: README and clean-checkout verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: instructions a new contributor can follow on this machine.

- [ ] **Step 1: Rewrite `README.md`**

Sections: brief Phase 1 description ("runnable skeleton, not a working visibility calculator; sites are fictional"), Prerequisites (Docker Desktop, Python 3.11+, Node 20.19+/22.12+), the six setup steps (env copy, `docker compose up -d db`, flyway profile run, backend venv + uvicorn, frontend install + dev), the psql verification query for `flyway_schema_history`, the workflow rules from the spec (new migrations only, no `create_all()`, `/api` proxy), the architecture cautions (flyway host `db` vs backend `localhost`, `file_uri` is metadata, no Earth CRS on lunar data, never `down -v`), the Phase 1 next milestones, and one line stating how to run the backend (`pytest`) and frontend (`npm test`) suites.

- [ ] **Step 2: Verify the suites from a clean state**

Run: `docker compose down` (never `-v`), then `docker compose up -d db`, `docker compose --profile tools run --rm flyway`.
Expected: migrations report `up to date`.
Then `cd backend; .\.venv\Scripts\python.exe -m pytest -v` → 8 passed, and `cd frontend; npm.cmd test` → 5 passed, and `npm.cmd run build` → build succeeds.

- [ ] **Step 3: Verify the documented psql query verbatim**

Run: `docker compose exec db psql -U lunar -d lunar_planner -c 'SELECT installed_rank, version, description, success FROM flyway_schema_history ORDER BY installed_rank;'`
Expected: two successful rows, matching what the README shows.

- [ ] **Step 4: Confirm nothing private is tracked**

Run: `git status --short` and `git check-ignore -v .env backend/.env`
Expected: `.env` and `backend/.env` reported as ignored; no `.env`, `node_modules`, or `.venv` entries in `git status`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document Phase 1 setup and verification"
```
