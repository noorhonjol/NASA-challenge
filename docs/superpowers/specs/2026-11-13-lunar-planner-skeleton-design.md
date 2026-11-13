# Lunar Planner — Phase 1 skeleton

Date: 2026-11-13
Status: awaiting approval

## Intent

The repository is empty except for a stub README. The goal of this phase is a
skeleton that genuinely boots: a migrated PostgreSQL schema with fictional seed
sites, a FastAPI backend reading from it, and a Vite/React frontend listing those
sites through the `/api` proxy. It is deliberately **not** a lunar visibility
calculator.

Why it matters: every later milestone (ephemeris, LOLA terrain, visibility
windows, Cesium viewer, run comparison) needs a schema, a connection path, and a
proxy that are already known to work. This phase establishes exactly that seam
and nothing more, so later failures are about astronomy or raster handling rather
than plumbing.

## Goals

- `docker compose up -d db` and `docker compose --profile tools run --rm flyway`
  bring up a schema with four tables and fictional seed sites.
- Backend serves `/api/health` (with a real database round-trip) and
  `/api/sites` from SQLAlchemy-mapped tables, documented at `/docs`.
- Frontend lists the seeded sites from `/api/sites` through the Vite proxy.
- README instructions reproduce this from a clean checkout.

## Non-goals

- Any astronomical or visibility computation.
- CesiumJS or any 3D viewer; a labelled placeholder panel only, and no `cesium`
  dependency in `package.json`.
- Horizons/SPICE integration, LOLA DEM import, raster processing.
- Authentication, multi-user concerns, deployment configuration.

## Anti-goals

- Data that looks real but is invented. Seed rows are marked fictional; no
  computed illumination or visibility values are stored or displayed.
- Moon coordinates presented as Earth coordinates. No `EPSG:4326` anywhere.
- `create_all()` or Alembic. Schema lives only in Flyway migrations.
- Editing an applied migration; changes arrive as new `V<number>__*.sql` files.
- Committing `.env`, or binding the database port beyond localhost.

## Constraints

- PostgreSQL in Docker; Flyway container connects to host `db`, host-run backend
  to `localhost`.
- Python 3.12 and Node 22.20 are installed; Vite 7 requires Node 20.19+/22.12+.
- `terrain_datasets.file_uri` is provenance metadata, never a raster blob or a
  path the application reads.
- Selenographic coordinates are stored with an explicit lunar frame label, not an
  Earth CRS.

## Approaches considered

1. **Four-table core** (chosen) — `sites`, `terrain_datasets`, `analysis_runs`,
   `visibility_windows`, with provenance columns on data-bearing tables. Every
   later milestone extends by new migration.
2. **Two tables** — `sites` and `analysis_runs`. Fastest, but milestones 2–4 each
   need a migration before they can store anything.
3. **Full domain up front** — six to eight tables including horizon profiles and
   ephemeris datasets. Guesses at columns not yet needed.

Frontend language: **TypeScript** over JavaScript, since CesiumJS ships its own
types. Boot proof: **one real read path** (`/api/health` + `/api/sites` rendered
in the browser) over a health check alone, because it exercises migrations,
mapping, proxy, and serialization at once.

## The build

### Schema — `db/migration/`

`V1__core_schema.sql`

| Table | Columns |
|---|---|
| `sites` | `id` bigserial PK, `slug` text unique not null, `name` text not null, `lat_deg` double precision not null, `lon_deg` double precision not null, `elevation_m` double precision, `frame` text not null (e.g. `MOON_ME`), `is_fictional` boolean not null default true, `notes` text, `created_at` timestamptz not null default now() |
| `terrain_datasets` | `id` bigserial PK, `name` text not null, `product` text, `file_uri` text, `crs` text, `resolution_m` double precision, `source` text, `retrieved_at` timestamptz, `license` text, `notes` text |
| `analysis_runs` | `id` bigserial PK, `site_id` FK → `sites` not null, `terrain_dataset_id` FK → `terrain_datasets` null, `label` text, `status` text not null default `pending` CHECK in (`pending`,`running`,`succeeded`,`failed`), `config` jsonb not null default `'{}'`, `provenance` jsonb not null default `'{}'`, `started_at` timestamptz, `finished_at` timestamptz, `created_at` timestamptz not null default now()` |
| `visibility_windows` | `id` bigserial PK, `analysis_run_id` FK → `analysis_runs` not null, `kind` text not null, `start_utc` timestamptz not null, `end_utc` timestamptz not null, `confidence` double precision, `notes` text, CHECK (`end_utc` > `start_utc`) |

Latitude/longitude range CHECKs (`-90..90`, `-180..180`). FKs `ON DELETE
CASCADE` from runs to sites and windows to runs. Indexes on `analysis_runs.site_id`
and `visibility_windows.analysis_run_id`.

`V2__seed_fictional_sites.sql` — three clearly fictional sites (`is_fictional =
true`) with lunar frame labels and notes stating they are placeholders, no
analysis runs and no visibility windows.

### Backend — `backend/`

- `requirements.txt`: fastapi, uvicorn[standard], sqlalchemy, psycopg[binary],
  pydantic-settings.
- `app/settings.py`: `DATABASE_URL` from environment or `backend/.env`, no
  default password.
- `app/db.py`: engine, `SessionLocal`, FastAPI dependency yielding a session.
- `app/models.py`: the four tables mapped; no `create_all()`.
- `app/schemas.py`: Pydantic response models.
- `app/routers/health.py`: `GET /api/health` executes `SELECT 1` and reports DB
  status.
- `app/routers/sites.py`: `GET /api/sites` list, `GET /api/sites/{id}` with 404.
- `app/main.py`: app factory, CORS for `http://localhost:5173`, routers under
  `/api`.

### Frontend — `frontend/`

- Vite 7 React + TypeScript template, `vite.config.ts` proxying `/api` to
  `http://localhost:8000`.
- `src/api/client.ts`: typed `fetchSites()`.
- `src/components/SiteList.tsx`: table of sites incl. lunar frame, loading and
  error states.
- `src/components/ViewerPlaceholder.tsx`: labelled placeholder where the Cesium
  viewer will go.
- `src/App.tsx`: composes both, plus a banner noting fictional data.

### Repo root

`docker-compose.yml` (db + `tools`-profiled flyway, DB port bound to `127.0.0.1`),
`.env.example` (`POSTGRES_*`, `DATABASE_URL`, password placeholder), README
rewritten to match these exact steps, `.gitignore` covering `.env`, `.venv`,
`node_modules`, `dist`.

## Decided by you

Four-table core; TypeScript; one real read path; skeleton only, no milestone work.

## Left to the builder

Exact file layout inside `backend/app` and `frontend/src`, styling approach for
the site table, and the precise wording of the fictional-site notes.
