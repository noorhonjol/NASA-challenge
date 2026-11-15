# Lunar Planner

A lunar surface-visibility planner with live JPL Horizons Sun and Earth positions.

## Local 3D terrain: download and prepare

The Moon renderer uses the **South Pole LOLA DEM Mosaic, NASA PGDA product 81**
(https://pgda.gsfc.nasa.gov/products/81), covering 87-90 degrees south at 5 m native
spacing. MIT's LOLA archive (https://imbrium.mit.edu/) links to this same PGDA product.
Rendering uses locally prepared files, without NASA imagery/raster requests while
navigating. A 50 m overview and relief image load once. At close zoom, small native
5 m chunks load from the local backend and are cached; at most 64 detailed chunks
remain in memory. Cesium generates its geometry from these browser arrays.
Earth satellite imagery and explicitly requested Horizons positions still use their
external services.

From `backend`, after migrations and installing `requirements.txt`:

```powershell
python scripts/download_mosaic81.py
python scripts/prepare_mosaic81.py
```

The resumable download retains the original 3,465,285,714-byte GeoTIFF under
`backend/data/terrain/Mosaic81/`. Preparation reads the 40,000 x 40,000 raster in
bounded-memory row bands, creates overlapping 1,024-cell detail chunks, and retains
a global PDS LOLA LDEM_16 backdrop under `backend/data/terrain/global/` (gitignored).
`TERRAIN_DATA_DIR` can point to a persistent data volume. The database records each
download's SHA-256, local metadata and browser readiness. No large raster blobs are
inserted into PostgreSQL. Keep this directory when deploying or run the preparation
commands on the destination machine.

Preparation produces gzip-compressed, row-delta encoded Int16 grids and a geographic
PNG relief image. Native detail spacing remains 5 m; display heights have 0.5 m
quantization (at most 0.25 m quantization error). The original float GeoTIFF remains
unchanged for future analysis. The global display grid is 8 pixels per degree
(about 3.8 km north/south sampling). A 250 m perimeter blends the polar coverage
into the global surface. This edge blend is visual, not source DEM data.

In the panel, choose **Moon** and enable **3D elevation terrain**. The product 81
mosaic is enabled by default without moving the camera. **Inspect 3D terrain** moves
to an oblique inspection view; ordinary terrain/ephemeris updates preserve the
camera. **LOLA terrain dataset** switches between the mosaic and global-only view.
Locations beyond 87 degrees south use the coarse global grid. Heights are
shown at 1x. Relief shading uses fixed light, not the chosen date's actual shadows;
Sun/Earth visibility calculations still exclude terrain obstruction.

`GET /api/terrain/browser-manifest` lists prepared regions and versioned static asset
URLs. `/api/terrain/assets/...` streams prepared files only, with no raster decoding,
reprojection or database query per request. The older `/api/terrain/manifest`,
`/tiles/...` and `/imagery/...` endpoints remain available for diagnostics; the
frontend does not use them. Restart the API and Vite after changing dependencies.

## Coordinate globe explorer

Choose **Moon** or **Earth**, enter latitude/longitude, and click **Fly to coordinates**.
This does not call Horizons or require the site database. Moon imagery is local;
Earth imagery streams from Esri World Imagery. Both have bundled NASA global images.
Left-drag orbits on a sphere centered on the selected body, preserving the current
radius. Orbiting moves the camera as one rotation about the body center, so tilt,
roll and look direction relative to the local vertical stay as they were. Scroll changes radius
along the same radial line. Right-drag looks around from a fixed position; Shift +
right-drag rolls around the viewing ray. **Center view**, or R while the globe has
focus, restores the center-facing view without moving the camera. **Whole globe**
and **Fly to site** move to explicit center-facing camera presets.

Orbit input is custom rather than Cesium's terrain-pivoted default: there is no
linear panning or post-drag inertia. Close-up orbit speed scales with altitude.
Touch supports one-finger orbit and two-finger pinch zoom. Zoom is limited to at
least 40 m above the body's enclosing reference sphere; the lunar maximum altitude
is 1,000,000 km, so the Earth–Moon relationship can also be explored from afar.

On the Moon, **Show Sun & Earth** loads live Horizons bearings and ranges; **Look toward
Earth/Sun** moves the camera above the site and looks along that body's bearing.
Earth is drawn with static NASA Blue Marble imagery: its face and phase are illustrative,
not time-resolved. Below-ground bodies are occluded. Both surfaces remain smooth reference
ellipsoids when terrain is disabled. Downloaded LOLA grids provide real lunar relief,
but are not yet used for terrain-aware visibility. The reference project's omitted
terrain/precomputed analysis files are not imported.
See `frontend/public/textures/SOURCES.md` for imagery provenance.

Sun and Earth each have a full-range dashed sight line, translucent connection polygon,
and edge lines from the lunar observer. These are illustrative sight planes, not
communication coverage or terrain-aware lighting. Changes to coordinates or date update
scene objects in the existing viewer and preserve the camera; only explicit camera-view
buttons or **Fly to coordinates** move it. X/Y/Z wheel controls have been removed.

## Terrain catalog and replacement history

Migration V3 initially registered product 78's 27 separate regional models.
V4 registers product 81 (`catalog_key: pgda-81:87S`); V5 removes product 78 records,
preserving any historical analysis-run terrain metadata before detaching its FK.
V6 adds 27 named product 78 region centers as navigation pins, and V7 removes
the fictional demonstration sites. One **Named LOLA location** selector and
clickable map pins navigate these locations while retaining the product 81 mosaic.
Pins represent regional raster centers, not official landing coordinates. Fifteen
centers are inside the 87–90°S mosaic and use elevations sampled from its native
5 m grid; the others use global LOLA terrain and show an outside-coverage note.
Applied migration files remain immutable. The active dataset keeps its original
source URL, lunar stereographic CRS, MOON_ME/DE421 frame, 5 m native spacing,
original-file SHA-256, coverage and browser-preparation metadata. Raster pixels
remain on disk rather than in PostgreSQL.

For an existing product 78 installation, prepare and verify product 81 first.
Then `python scripts/remove_legacy78.py --delete` removes only the old regional
directories from the saved replacement plan, after validating that the product 81
assets exist and all delete paths are children of the configured terrain directory.
The global baseline and `Mosaic81` are retained. The older product 78 download tools
are historical; do not run them to provision a new installation.

Read the catalog through `GET /api/terrain-datasets` and individual records through
`GET /api/terrain-datasets/{id}`. API docs are at `/docs`. Missing IDs return 404;
database failures return 503. Apply the migration with `docker compose run --rm
flyway` and restart the API to load the new routes.

When using these data, cite Barker et al. (2021), *Improved LOLA Elevation Maps for
South Pole Landing Sites: Error Estimates and Their Impact on Illumination
Conditions*, https://doi.org/10.1016/j.pss.2020.105119, as requested by NASA PGDA.

Choose saved sites or custom lunar coordinates, enter a UTC date, and select **Show Sun &
Earth**. The backend queries JPL Horizons directly for both bodies; the UI plots their
airless azimuth/elevation and shows whether their centers are above the local tangent
plane. The globe marks the returned observer coordinates alongside the named region pins.
No terrain obstruction, horizon dip, eclipses, power yield, or communication link budget
is calculated. No ephemeris samples are stored. Internet access to JPL is required.

`GET /api/positions?lat=-86&lon=2.7&elevation_m=5000&at=2026-11-14T23:05:00Z`
works independently of the database. Coordinates are MOON_ME, longitude positive east;
altitude is meters above the lunar reference ellipsoid. Explicit timezone required.
Dates are limited to 1550–2649. JPL uses UT1 before 1962; modern dates use UTC.
Upstream failures return 502 with a retryable error. Requests use observer quantity 4,
Moon center `coord@301`, Sun target 10 and Earth target 399.

`/api/positions` stays flat-horizon only. For terrain-aware Earth visibility over a
period, use `/api/earth-link` below.

## Earth line-of-sight windows

In the app: **Mission time range** → **Check Earth contact** (Moon only).


`GET /api/earth-link?lat=-89.77&lon=-171.87&start=2026-11-15T00:00:00Z&end=2026-12-15T00:00:00Z`

Given a point on the Moon and a period, it returns when the antenna has an unobstructed
line of sight to Earth's center and when it doesn't. It accounts for lunar curvature,
local mountains and crater rims (LOLA), antenna height, and Earth hidden by the Moon
itself. Nothing is stored; it needs JPL access, but no database.

How it works:
1. **Earth's track.** One JPL Horizons request returns Earth's azimuth, elevation and
   distance from the site every `step_minutes`. Earth barely moves in the lunar sky; near
   the south pole its few-degree wobble (libration) makes it rise and set.
2. **Skyline.** Rays are cast across the LOLA grid, 1° apart all round, then 0.1° apart
   wherever Earth actually passes low. Each ray samples terrain from 25 m out (steps grow
   to 900 m) up to the distance beyond which no terrain could rise above the sight line.
   The Moon is treated as a ball, so distant ground drops away; a higher antenna sees
   farther and gets a lower skyline.
3. **Compare.** clearance = Earth elevation − skyline in Earth's direction. Between
   Horizons samples, Earth's track is interpolated in steps of 0.05° or less, so a narrow
   peak between two samples is not skipped. Each status change is located to the second.
4. **Windows.** The period is divided into `available` / `blocked` / `unknown` windows
   with no gaps or overlaps. Each blocked window has a cause: `lunar_limb` (Earth is
   below the horizon a smooth Moon would have here) or `terrain` (a ridge or rim is in
   the way).

| Param | Default | Notes |
|---|---|---|
| `lat`, `lon` | required | MOON_ME degrees, longitude east-positive (−180..180). Latitude is moved to ±89.9999 at the exact pole (azimuth is undefined there); the response reports both values |
| `start`, `end` | required | Timezone-aware ISO times, whole seconds, years 1550–2649, `end > start`, at most 366 days |
| `step_minutes` | 30 | 1–1440. At most 20,000 samples; otherwise 422 with the smallest allowed step |
| `altitude_m` | 2 | Antenna height, 0–100,000 m |
| `altitude_reference` | `ground` | `ground` = above local terrain; `sphere` = above the 1,737.4 km datum (422 if that is underground) |
| `min_clearance_deg` | 0 | Margin above the skyline (−1..10). About 0.95 requires the whole Earth disc to be clear |
| `min_window_minutes` | 0 | Shorter available windows don't count as usable contact |
| `min_availability_fraction`, `max_blackout_hours`, `max_first_contact_hours` | none | Optional mission limits, assessed as `pass` / `fail` / `inconclusive`; `criteria_not_specified` when none are given |
| `include_samples` | false | Adds each Horizons epoch: azimuth, elevation, Earth's angular radius, skyline, clearance, `los`, status, cause |
| `include_skyline` | false | Adds the 1° terrain skyline (360 values) |

The response contains `location`, `period`, `target`, `criteria`, `terrain_model`,
`resolution`, `summary` (hours per status, window counts, usable fraction, longest
window, longest blackout including the period edges, time to first contact),
`assessment`, `rf`, `windows`, `warnings`, `limitations` and `source`.

What the results mean:
- This is **geometric line of sight to Earth's center**, not a radio link: `rf.assessed`
  is always `false`. There is no link budget, Fresnel zone, ground-station visibility or
  DSN schedule, and orbiters are out of scope.
- `los` per sample uses Earth's disc: `clear`, `grazing` (partly above the skyline),
  `blocked`, or `unknown`.
- If terrain isn't prepared, the request still succeeds with `terrain_model.type =
  smooth_sphere` and a warning. Times when the Moon itself must hide Earth are
  `blocked`; everything else is `unknown`, never assumed clear.
- Sites outside the 87–90°S high-resolution mosaic, and terrain beyond about 91 km from
  the pole, use the ~1.9 km global grid. A warning says so when it applies at the site.
- Errors: 422 for invalid input, 502 when Horizons fails.

## Sunlight, temperature and site judging

In the app: **Mission time range** → **Sunlight & temperature**. Pick a mission type and
click **Check sunlight & temperature**. **Find better spots within 10 km** ranks a 7×7 grid
around the site, and **Fly here** moves to a result.

Merged from the `lunar_sun` prototype, reusing this backend's Horizons client, LOLA
terrain and skyline rays (the same as `/api/earth-link`). No database is needed.

| Endpoint | Input | Output |
|---|---|---|
| `GET /api/sun/point` | `lat`, `lon`, `time` (default now), `power_threshold_wm2`, `events`, `temperature` | Sun state (`full_sun`, `partial_sun`, `terrain_shadow`, `night`), angles, irradiance, panel advice, next sunrise and sunset, 360-value skyline |
| `POST /api/sun/region` | `region` (lat/lon box, up to 60×60) or `points`, `start`, `stop`, `step_min`; optional `thermal_model`, `earth`, `grid_series`, `format: "csv"`, `preset` / `criteria` | Per-point statistics, region time series, grid maps; with a preset or criteria also `judge` |
| `POST /api/sun/judge` | area and period as above, plus `preset` and/or `criteria`, `top_n` | Pass/fail per criterion, weighted score, ranking, score map |
| `GET /api/sun/metrics` | | Metric names and presets |

How it works:
1. **Sun and Earth positions.** One Horizons series per body at a reference site near
   the middle of the points. The body's position is rebuilt as site + direction × range
   and viewed from every point, so the shift across a region is included. Checked live:
   positions rebuilt from one site match Horizons at a site 300 km away to within 0.00001°.
2. **Terrain.** Each point gets a ground-level skyline (1° apart for up to 25 points,
   5° for more) and a slope from LOLA heights one grid cell to each side.
3. **Sunlight.** The visible part of the Sun's disc above the skyline sets the direct
   sunlight: 1,361 W/m² × (1 AU / distance)² × visible fraction, on a sun-tracking panel,
   a flat panel and the sloped ground.
4. **Temperature.** A 1-D regolith heat model (Hayne et al. 2017) warms up over one
   synodic month before `start`, then runs through the period.
5. **Judging.** Each criterion is `{metric, op, value, weight, required}` with
   `op` one of `>= <= > < == between`. Score = weighted share of criteria met; PASS needs
   every required criterion. Presets: `crewed_landing` (slope, Earth visibility,
   sunlight), `lander_survival`, `solar_rover`, `ice_cold_trap`.

Metrics: `illumination_fraction`, `max_darkness_hours`, `mean_irradiance_wm2`,
`energy_tracking_kwh_m2`, `energy_flat_kwh_m2`, `slope_deg`, `elevation_m`, `min_temp_K`,
`max_temp_K`, `mean_temp_K`, `temp_range_K`, `earth_visible_fraction`,
`max_earth_blackout_hours`. Earth metrics use the same ground-level skyline at the sample
times; at −88.85°, 90° for December 2026 they agree with `/api/earth-link` (41.9% vs 42.0%).

Limits: up to 900 points, 8,000 time steps per body (spin-up included) and 2,000,000
points × steps per request. A single site with temperature over 7 days takes about 12 s.

What the results mean:
- Direct sunlight only: no light or heat reflected from nearby terrain, so permanently
  shadowed floors read about 10–30 K too cold.
- Without prepared terrain the request still succeeds on a smooth sphere, with a warning
  that sunlight and Earth visibility are overstated.
- Errors: 422 for invalid input, 502 when Horizons fails.

Not merged from the prototype: its offline astropy ephemeris fallback (Horizons is the
single source here), its rasterio GeoTIFF loader (`LOLA_DEM_PATH`; the prepared LOLA
grids are used instead), its standalone Plotly page, and its `/v1/...` paths.

Apply migration V2 using `docker compose run --rm flyway` to drop `ephemeris_samples`
if it exists; previously applied migrations are unchanged. Restart the backend after
updating so `/api/positions` appears in `/docs`. If Vite returns 404, check its
`API_PROXY_TARGET` and restart the API on that port.

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
