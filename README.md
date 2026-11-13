# Lunar Planner

A lunar surface-visibility planner, currently at **Phase 1: a runnable skeleton**.

This is not a working visibility calculator. The seeded sites are **fictional**, and no
astronomical, terrain, or illumination analysis is computed or displayed. What works is
the plumbing later phases depend on: a PostgreSQL schema applied from SQL files, a FastAPI
backend reading it through SQLModel, and a React/TypeScript frontend that lists the sites
and shows them on a lunar globe.

## How to run

### Prerequisites

- Docker Desktop (only for running Flyway migrations; the app itself is not containerised)
- Python 3.11+ (3.12 tested)
- Node.js 20.19+ or 22.12+ (Vite 8)
- A PostgreSQL database. A hosted Neon database is what this project is configured for;
  any Postgres 15+ works.

### 1. Point the backend at a database

```powershell
cd C:\workspace\NASA-challenge\backend
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` to your database. It must start with `postgresql+psycopg://`, and a
hosted URL must keep its TLS parameters:

```text
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require&channel_binding=require
```

The same file carries the Flyway settings (`FLYWAY_URL`, `FLYWAY_USER`, `FLYWAY_PASSWORD`,
`FLYWAY_LOCATIONS`, `FLYWAY_BASELINE_ON_MIGRATE`, `FLYWAY_BASELINE_VERSION`). `FLYWAY_URL`
is the JDBC form of the same connection, so the credentials live in one place.

`backend/.env` is gitignored — it holds a real password, so never commit it.

### 2. Apply the migrations (once per database)

```powershell
cd C:\workspace\NASA-challenge
docker compose run --rm flyway
```

The Flyway container mounts `db/migration` and connects using `backend/.env`; no password
appears in `docker-compose.yml` or on the command line. On a database that already has
tables, `FLYWAY_BASELINE_ON_MIGRATE=true` records the current schema as baselined at
version 1 instead of re-running `CREATE TABLE`; on an empty database the migrations run
normally and create everything.

Expected on an already-migrated database:

```text
Schema "public" is up to date. No migration necessary.
```

### 3. Start the backend

```powershell
cd C:\workspace\NASA-challenge\backend
py -m venv .venv                                   # first time only
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Defaults to <http://127.0.0.1:8000>. If 8000 is taken:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8010
```

### 4. Start the frontend

In a second terminal:

```powershell
cd C:\workspace\NASA-challenge\frontend
npm.cmd install                                    # first time only
npm.cmd run dev
```

Vite prints the URL, normally <http://localhost:5173>. It proxies `/api` to
`http://127.0.0.1:8000`; point it elsewhere with an environment variable:

```powershell
$env:API_PROXY_TARGET = 'http://127.0.0.1:8010'
npm.cmd run dev
```

### 5. Open it

- App: <http://localhost:5173>
- API docs: <http://127.0.0.1:8000/docs> (or your chosen port)

Expected: a banner saying sites are fictional, a table of three lunar sites with frame
`MOON_ME` (one elevation shown as `—`), and an interactive lunar globe with three pins.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Database round-trip; `503` with `database unavailable` if the DB is down |
| `GET /api/sites` | All seeded sites, ordered by name |
| `GET /api/sites/{id}` | One site; `404` if unknown, `422` if the id is not an integer |

## Verify the database

```powershell
cd C:\workspace\NASA-challenge\backend
.\.venv\Scripts\python.exe -c "import psycopg; from app.settings import get_settings; u=get_settings().database_url.replace('postgresql+psycopg://','postgresql://',1)
with psycopg.connect(u) as c:
    print(c.execute('SELECT installed_rank, version, description, success FROM flyway_schema_history ORDER BY installed_rank').fetchall())
    print(c.execute('SELECT slug, frame, is_fictional FROM sites ORDER BY slug').fetchall())"
```

Expected: the Flyway baseline row for version 1 with `success = True`, and the three
fictional sites with `frame = MOON_ME`.

## Tests

```powershell
cd C:\workspace\NASA-challenge\backend
.\.venv\Scripts\python.exe -m pytest        # 10 tests; uses DATABASE_URL from backend/.env

cd ..\frontend
npm.cmd test                                # 11 tests
npm.cmd run build                           # type-check + production build
```

## Schema and migrations

`db/migration/V1__lunar_planner_schema.sql` creates `sites`, `terrain_datasets`,
`analysis_runs`, and `visibility_windows`, plus the three fictional seed sites. Runs and
windows are intentionally empty — there is no ephemeris or terrain data behind them yet.

- The SQL files are the only source of schema truth. `backend/app/models.py` maps them
  with SQLModel and never calls `create_all()`.
- Add changes as a NEW file (`V2__...sql`), never edit a migration that has been applied;
  Flyway checksums applied files and fails validation if one changed.
- Flyway runs from Docker (`docker compose run --rm flyway`) and reads its connection from
  `backend/.env`. `docker compose run --rm flyway info` lists applied and pending versions.

## The lunar globe

`frontend/src/globe/` holds an interactive CesiumJS globe. It is deliberately lunar, not
an Earth globe:

- CesiumJS is used directly inside a React effect (`createLunarViewer.ts`), not through
  the unmaintained `cesium-react` wrapper from Cesium's 2018 blog post; that post predates
  Vite and assumed webpack.
- `Cesium.Ellipsoid.default` is set to `Ellipsoid.MOON`, and the `Globe`, terrain provider
  and every site position use that ellipsoid. Setting the default *before* the viewer is
  constructed matters: otherwise the camera converts through WGS84 and ends up "below
  ground" on a 1,737 km sphere, rendering a black canvas.
- The base layer is NASA SVS's CGI Moon Kit colour map (LRO LROC WAC mosaic, public
  domain), bundled at `frontend/public/textures/lroc_color_2k.jpg`. No Cesium ion token is
  needed. Earth-only scene effects (atmosphere, fog, sky sun/moon) are disabled.
- Sites come from `GET /api/sites`; a null elevation is drawn at 0 m rather than dropped.
- Without WebGL the panel says so instead of showing a blank canvas.

## Architecture cautions

- `DATABASE_URL` must carry the `+psycopg` driver suffix. A plain `postgresql://` URL makes
  SQLAlchemy import psycopg2, which is not a dependency here.
- Use `127.0.0.1`, not `localhost`, for a local database: on Windows `localhost` resolves
  to `::1` first, which can stall each connection for around two minutes.
- Rotate the database password if it is ever pasted somewhere public; it lives only in
  `backend/.env`, which is gitignored.
- `terrain_datasets.file_uri` is provenance metadata, not a raster file the app reads.
- Do not assign Earth `EPSG:4326` to Moon data. Sites carry an explicit lunar frame
  (`frame`), and terrain datasets carry their own `crs`.

## Next milestones

1. Analysis-run CRUD and run status transitions.
2. Integrate Horizons or SPICE behind `ephemeris_service.py`; store data with provenance.
3. Import a real LOLA DEM and compute terrain-aware horizon profiles.
4. Implement visibility windows with transition refinement.
5. Add terrain relief to the globe (Cesium Moon 3D Tiles via an ion token, or an imported
   LOLA DEM) and add visibility charts.
6. Compare two analysis runs and document uncertainty and limitations.
