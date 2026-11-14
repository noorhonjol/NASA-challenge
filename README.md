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
Left-drag orbits on a sphere centered on the selected body,
preserving the current radius and pointing toward its center. Scroll changes radius
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

## Lunar Energy API v1

The energy component is rebuilt from the [v1 specification](docs/requirements/lunar-energy-api-v1.md).
The previous `/api/planning/*` endpoints and their frontend are removed. Existing
site, terrain, globe and `/api/positions` functionality remains available.

| Route | Inputs and output |
|---|---|
| `GET /v1/solar/point` | Coordinates and UTC instant → terrain height/slope/aspect, Sun/Earth positions, partial solar visibility and irradiance |
| `POST /v1/solar/region` | Bbox/polygon/circle, physical grid spacing and period → masked metric grids, ranking and optional time series |
| `POST /v1/power/mission` | Location, mission period, operating/survival load and panel configuration → panel/battery sizing and simulated SOC |
| `POST /v1/power/windows` | Location, search period, installed equipment and criteria → battery-supported windows, scores and unsuitable reasons |

Install `backend/requirements.txt`, prepare the existing LOLA mosaic, then run:

```sh
cd backend
.venv/bin/python scripts/prepare_energy.py
.venv/bin/python -m uvicorn app.main:app --reload
```

`prepare_energy.py` downloads about 45 MB of pinned NAIF kernels into
`backend/data/spice/`, verifies SHA-256 hashes, and records provenance. Kernels and
horizon caches stay on disk and are gitignored. No ephemeris network requests occur
during energy analysis. The API uses DE440s, the DE440 lunar orientation PCK,
`MOON_ME_DE440_ME421` frame definitions, and NAIF leap seconds. Missing/corrupt
kernels or DEM files return structured errors. Restart Vite: its proxy now forwards
both `/api` and `/v1` to `API_PROXY_TARGET`.

Open **Mission planner** in the top navigation bar. Its modal provides all four
analysis tasks. Point and region solar analysis require no equipment. Mission sizing
requires demand because sunlight cannot determine equipment consumption. Elevation,
slope and aspect come from LOLA; **height_m** is only the sensor/panel height above
that surface. The modal includes grid heatmaps, ranked cells, energy budgets,
panel comparisons, SOC/power timelines, warnings, and full JSON download. Closing
and reopening preserves the form/results. The globe remains mounted underneath.

Example requests:

```sh
curl 'http://127.0.0.1:8000/v1/solar/point?lat=-89.45&lon=-137.3&height_m=2&time=2026-12-01T12:00:00Z'
```

```json
{
  "location": {"lat": -89.45, "lon": -137.3, "height_m": 2},
  "start": "2026-12-01T00:00:00Z",
  "duration_hours": 336,
  "load": {"average_w": 150, "survival_w": 40, "peak_w": 400},
  "panel": {"mode": "auto", "efficiency": 0.3, "degradation_pct": 10},
  "assumptions": {"battery_dod": 0.8, "battery_efficiency": 0.95, "margin_pct": 20}
}
```

Submit the JSON body to `/v1/power/mission`; all schemas and other request shapes
are available at `/docs`. Region periods default to six-hour steps; mission/window
periods to one hour. The exact final epoch is included, including a shorter last
interval. Time support is 2020 through 2035 UTC, step range 0.25–24 h, region/window
span at most 731 days, and mission duration at most 8760 h. Region cell × epoch
work is capped at 2,000,000 before any expensive terrain calculation. Requests
remain synchronous: large, uncached regions can take substantial time. The work
limit is an admission bound, not a latency guarantee or a claim of maximum-size
production performance. JSON downloads contain complete results; the UI limits
very large grid/time-series previews to keep the page responsive.

### Terrain and numerical conventions

- Source elevation and gradients: original product 81 5 m raster within 87–90°S;
  global LOLA elsewhere. Heights do not use browser blending or quantization.
- Terrain horizons: 360 azimuth bins; native 5 m samples within 250 m, prepared
  50 m polar overview farther away, global LOLA outside polar coverage. Curved
  surface rays extend to 500 km with dense near-field/log-spaced far-field samples.
  Profiles are cached per DEM version, coordinates, algorithm and observer height.
  Missing overview edge pixels use valid global terrain. Invalid global coverage
  fails rather than becoming a flat horizon. Sites where the finite horizon extent
  is insufficient are rejected.
- Solar disk: fixed 0.53° diameter, circular segment over an interpolated straight
  terrain horizon. Irradiance projects the center vector onto each surface and is
  clamped nonnegative. This approximation can miss thin ridges/partial-disk effects.
- Fixed-horizontal panels use the local tangent plane; terrain irradiance uses the
  DEM normal. Aspect is downslope azimuth, north=0° clockwise; flat aspect=0°.
- Region cells are anchored in projected meters. South/north polar grids use polar
  stereographic coordinates; other regions use a centered equidistant cylindrical
  grid. Requested spacing snaps upward to supported analysis sampling levels
  (5, 10, 20, 40, 80, 160, 240, 480, 960, 1920 m, and coarser doubles). Outside the
  native south-pole coverage, the minimum spacing is 1920 m to match global data.
  These are sampling levels, not a claim that all source DEMs have that resolution.
- Energy integrates actual interval lengths. Solar power is linearly interpolated;
  loads are held at interval starts. Custom-load timestamps are inserted into the
  mission timeline so changes are integrated at their actual times.
- Mission load is operating/custom power while lit and survival power while dark.
  Minimum panel sizing includes storage losses and requires net energy balance;
  battery sizing tracks maximum cumulative deficit, including internal zero crossings.
  Recommended sizes apply the design margin. Infeasible sizes are null, never infinity.
- Battery round-trip loss is split equally between charge/discharge. SOC is **usable
  SOC**: 0% corresponds to the specified DoD floor. All simulations start full.
  Optional `assumptions.max_charge_w` and `max_discharge_w` model rate limits.
  Wh alone cannot determine discharge W: missing discharge limits produce a
  `PEAK_RATE_UNCHECKED` warning instead of an invented peak-rate result.
- Windows deliver full required operating power even while dark. Outside eligible
  intervals the survival load applies. SOC proceeds chronologically and is never
  reset at a candidate window. A zero survival load gives no derived survival
  darkness limit. Explicit darkness limits still apply. A zero average-margin
  criterion disables that extra filter; a positive criterion filters by mean solar
  power margin. Scores clamp every normalized term to [0,1]. Summary window counts
  and duration describe all qualifying windows, before `max_results` truncation.
- `auto` evaluates all 5° fixed-tilt/azimuth pairs against the endpoint objective,
  retaining the best fixed pair for comparison with horizontal and tracking modes.
  `prefer_simple` excludes full tracking and chooses a fixed mode within tolerance
  of the best remaining option; otherwise vertical tracking can win. This resolves
  the specification's otherwise conflicting full-tracking preference rules.

Responses identify actual DEM products and DE440; example labels such as
`LDEM_80S_20M` are not substituted for installed datasets. Results are engineering
screening estimates, not validated mission certification. No secondary illumination,
eclipses, thermal survival prediction, radio link budget or peak-load duration model
is included. Low-angle results are sensitive to terrain/horizon sampling. See the
[implementation decisions](docs/requirements/lunar-energy-api-v1-decisions.md).

To precompute horizons for known sites, supply a JSON list of Location objects:
`python scripts/prepare_energy.py --horizons locations.json`. Normal requests reuse
these profiles and lazily create missing profiles. Changing observer height or the
DEM/algorithm version creates a different cache entry.
