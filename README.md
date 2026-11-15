# Lunar Planner

**NASA Space Apps 2026 · Lunar Landing Site Navigator**

> Missions to the Moon's south pole live or die by sunlight and Earth contact: the Sun skims the
> horizon, crater rims cast shadows for days, and Earth dips behind the terrain. Lunar Planner lets
> mission planners, educators and the public compare landing sites and dates quickly, and see the
> Sun and Earth against the real terrain horizon.

![Best mission windows and places at an Artemis III region, with the score surface on the Moon](docs/images/planner-results.png)

## What it answers

| The challenge asks to… | In Lunar Planner |
|---|---|
| Compare landing sites | Pick any PGDA south-pole site, your own pin, or one of NASA's 9 Artemis III candidate regions. **Compare sites side by side** ranks several at once; a region search ranks every spot inside it and draws a coloured score surface on the Moon. |
| Compare dates | Give a long period (up to 180 days) and a mission length: the planner scores every window and lists the best, with a chart of the score through the period. |
| See the Sun and Earth relative to the horizon | A **horizon chart** draws the real terrain skyline (LOLA, 5 m near the site) with the Sun's and Earth's tracks over the window; **Stand here** puts you on the ground with **Sky & time** to play the sky forward. |
| Assess power | Energy from sun-tracking or fixed panels against the energy the mission needs, and the longest darkness against the battery. |
| Assess direct-to-Earth contact | Share of time Earth is in view from the antenna, and the longest blackout. |
| Be intuitive | Three plain choices (power, heat, communication), a one-click demo, and a verdict that says in words whether every need is met and why not. |

## Try it in 30 seconds

1. Open the app (see **Run it yourself** below): it starts over the south pole.
2. Press **▶ Try it: best 14 days at Artemis III "de Gerlache Rim 2"**. The planner searches the next
   60 days in about half a minute.
3. Read the verdict at the top: does any window meet every need, and if not, what fails (for example
   "darkness lasts 52 h, battery covers 30 h").
4. Look at the Moon: the coloured surface shows where in the region it is best; dashed lines join the
   base to its solar panels and antenna, with distances.
5. Look at the horizon chart: gold dots are the Sun, blue dots Earth, faded where terrain hides them.
6. Press **Fly to the base**, then **Stand here** and **Sky & time**, and press Play.

| Sun and Earth against the real horizon | All 9 Artemis III regions side by side | Standing on the rim |
|---|---|---|
| ![Horizon chart](docs/images/horizon-chart.png) | ![Site comparison](docs/images/compare-sites.png) | ![Street view](docs/images/street-view.png) |

## Run it yourself

You need **Git**, **Python 3.11+**, **Node.js 20.19+ or 22.12+**, **Docker Desktop** (for the
database) and about **8 GB** of free disk space for the NASA terrain. Commands are for Windows
PowerShell; macOS/Linux differences are noted after the steps.

**1. Get the code**
```powershell
git clone https://github.com/noorhonjol/NASA-challenge.git
cd NASA-challenge
```

**2. Start a local database** (PostgreSQL in Docker) and create its tables
```powershell
docker run -d --name lunar-db -p 5432:5432 -e POSTGRES_USER=lunar `
  -e POSTGRES_PASSWORD=local_dev_password_change_me -e POSTGRES_DB=lunar_planner postgres:16
Copy-Item backend\.env.example backend\.env
Add-Content backend\.env @"
FLYWAY_URL=jdbc:postgresql://host.docker.internal:5432/lunar_planner
FLYWAY_USER=lunar
FLYWAY_PASSWORD=local_dev_password_change_me
FLYWAY_LOCATIONS=filesystem:/flyway/sql
"@
docker compose run --rm flyway
```
The last command should end with `Successfully applied 7 migrations`. They create the tables and
the PGDA south-pole sites.

**3. Install the backend and download the NASA data**
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\prepare_energy.py      # NAIF SPICE DE440 kernels, about 45 MB
.\.venv\Scripts\python.exe scripts\download_mosaic81.py   # NASA PGDA 81 LOLA mosaic, about 3.5 GB (resumable)
.\.venv\Scripts\python.exe scripts\prepare_mosaic81.py    # prepares the terrain tiles; takes a while
cd ..
```

**4. Install the frontend**
```powershell
cd frontend
npm.cmd install
cd ..
```

**5. Run** (two terminals, both from the `NASA-challenge` folder)
```powershell
# Terminal 1: the API
cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app

# Terminal 2: the app
cd frontend; npm.cmd run dev
```
Open **<http://localhost:5173>** and press **▶ Try it**. The API docs are at
<http://127.0.0.1:8000/docs>. Next time, only step 5 is needed (and `docker start lunar-db`
after a reboot).

**macOS / Linux:** use `python3 -m venv .venv`, `.venv/bin/python` instead of
`.\.venv\Scripts\python.exe`, `npm` instead of `npm.cmd`, `cp` instead of `Copy-Item`, and
`\` instead of `` ` `` for line breaks; append the four `FLYWAY_*` lines to `backend/.env` with
any editor. On Linux, `host.docker.internal` needs `--add-host=host.docker.internal:host-gateway`
on the `docker compose run` (or use the host's IP address).

**If something fails:**
- *PowerShell refuses to run `npm`*: use `npm.cmd` as above, or run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
- *"DATABASE_URL is not set"*: step 2 did not create `backend\.env`.
- *"Installed LOLA mosaic unavailable" or "DE440 kernels" errors*: rerun the step 3 data scripts.
- *A page or route says "Not Found" after an update*: stop the API (`Ctrl+C`) and start it again.

## How to read a result

- **✓ / ✗ meets all needs** is strict: every need (power, heat, communication, slope, cable length)
  must be met in full by the base and the panel and antenna spots it can reach.
- **Score 0–100** shows how close: each need scores 0–100 (100 when met, falling to 0 at twice its
  limit) and the window score averages the base's heat with the best panel and antenna spots.
- Windows that meet every need always rank above ones that do not.
- All thresholds are illustrative screening values, not agency requirements.

## Data and models

| | Source |
|---|---|
| Terrain | NASA PGDA product 81 (LOLA south-pole 5 m mosaic, 87–90°S); global LOLA LDEM_16 beyond |
| Named sites | NASA PGDA product 78 south-pole regions |
| Candidate regions | NASA Artemis III candidate landing regions (2024), digitized from NASA's map (a few km accuracy) |
| Sun and Earth | NAIF SPICE DE440 (offline, for the planner and horizon chart); JPL Horizons (live, for the globe and Sky & time) |
| Surface temperature | 1-D regolith model, Hayne et al. 2017 (JGR Planets 122) |
| Earth image | NASA Blue Marble (illustrative) |

Panels and antenna are evaluated 2 m above the ground by default (the nearest bumps would hide a
sky seen from 0 m); the heat model uses the ground itself. Earth contact is geometric line of sight
to Earth's centre, not a radio link or a DSN schedule. The heat model has no light or infrared from
nearby terrain, so permanently shadowed floors read about 10–30 K too cold.

---

# Developer notes

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
shown at 1x. Relief shading uses fixed light, not the chosen date's actual shadows. Sun and
Earth visibility in the planner, the horizon chart and `/api/earth-link` do account for terrain.

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
Touch supports one-finger orbit and two-finger pinch zoom. Zoom is measured from the
ground below the camera. On the Moon, zooming below 800 m switches to the street-level
surface view (see "The lunar globe"); the lunar maximum altitude is 1,000,000 km, so
the Earth–Moon relationship can also be explored from afar.

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
the fictional demonstration sites. One **Site** selector and
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

## Mission planner (power, heat and communication)

Pick a site and press **Check this site**, or press **Open mission planner** in the left panel.
The planner opens as a drawer on the right, beside the globe; the Moon stays usable.

**Plan tab: find the best mission windows.** Give a long search period and a mission length;
the planner tries every window of that length inside the period and ranks them, with the best
places for the base, the solar panels and the antenna in each.
1. **Where:** the selected site; a known region or site (the 9 NASA Artemis III candidate
   regions as polygons, plus the PGDA 78 sites and your pins as points); or a region you draw
   (**Draw region on the Moon**, click the corners, **Finish region**).
2. **When:** the search period (**Search from / until**, presets 30/60/90/180 days, at most
   180 days, 2020-2035) and the **mission length** (presets 3/7/14/28 days, at most 60).
3. **Power:** low (small robotic payload, 100 W), mid (rover or robotic lander, 1 kW) or high
   (crewed lander or habitat, 10 kW); **Panels turn to follow the Sun** on or off. Advanced:
   energy needed over the whole mission (kWh), panel area, panel efficiency, battery (hours of load).
4. **Heat:** crewed (100-330 K surface), robotic (70-380 K) or cold-trap science (at most 110 K).
   Advanced: lowest and highest surface temperature.
5. **Communication:** very frequent (Earth in view 90%, blackout at most 12 h), frequent (50%,
   48 h) or occasional (20%, 168 h). Advanced: both numbers. Also: steepest ground for the base.

**Find the best windows** starts a search (`POST /api/mission/search`, then polled at
`GET /api/mission/search/{id}` with a progress bar). Results:
- A chart of the window score through the whole period, and the ranked best windows (no two
  overlapping by more than half), each with its power, heat and communication parts.
- For a region: a smooth, coloured **score surface draped on the Moon** over the area (layers:
  overall base site, power, heat, communication), the best **base site**, the best **solar panel**
  spots and the best **antenna** spots, each with **Fly here**. For one point: the best windows.
- **How a spot does in the window:** energy from the panels against the need, longest darkness
  against the battery, time in the allowed temperature range, Earth in view and longest blackout,
  slope.
- **Compare other spots:** **Pick a spot on the Moon**, click anywhere: an instant estimate from the
  nearby samples, then **Compute exactly** for that point (same search, a few seconds).
- Scores are 0-100. A window's score averages the base site's heat with the best power spot and
  the best antenna spot in the area (equipment can stand apart from the base); a base steeper
  than the limit scores 0. All thresholds are illustrative screening values.

How the search works (`backend/app/mission_search.py`, no network): one series per sampled cell
over the period plus one lunar month before it, from the offline Lunar Energy v1 data (SPICE
DE440, LOLA terrain): Sun visibility and direction, panel irradiance, Earth visibility. Surface
temperature comes from the same sunlight through the 1-D regolith model. Every window is then
scored with sliding sums. Time step 1/2/3 h for periods up to 45/120/180 days; windows start
every 12 h (periods up to 60 days) or 24 h. Cells: the finest grid with at most 120 cells and
160,000 cell-steps. Measured: 100 cells over 60 days in about 10 s; one point in about 2 s.
The older one-period analysis (`POST /api/mission/analyze`) is still available in the API.

The former **Detailed analysis** tab (Noor's Lunar Energy v1 forms, the Earth contact and the
Sunlight & temperature panels) was removed from the UI: the planner covers the same questions in one
place. Its components (`EnergyPlanner.tsx`, `EarthLinkPanel.tsx`, `SunPanel.tsx`) and every API route
(`/v1/*`, `/api/earth-link`, `/api/sun/*`) remain and are tested, so the tab can be re-added.

How `/api/mission/analyze` combines the engines:
- **Cells:** a point, or the cell centres of the polygon on the Lunar Energy v1 grid, at
  the finest analysis spacing that keeps at most 200 cells.
- **Power and Earth visibility per cell:** Lunar Energy v1 (offline SPICE DE440, LOLA,
  360 horizon bins). The definitions match `/v1/solar/region`. Energy is for a
  sun-tracking vertical panel, per m², before efficiency.
- **Heat per cell:** the regolith model behind `/api/sun`, run on the same cell centres,
  with the Sun from JPL Horizons and one lunation of warm-up.
- **Single site:** refined Earth windows from `/api/earth-link` (2 m antenna).
- **Scores:** the mission-type presets in `app/mission.py`. They are illustrative
  screening thresholds, not agency requirements.

`GET /api/mission/regions` returns the Artemis III regions
(`backend/app/data/artemis_iii_regions.json`). NASA publishes them only as boxes on a map
([release](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/),
[LPSC 2026 abstract](https://ntrs.nasa.gov/citations/20250011660)), so the corners were
digitized from that map. The pole is the marked star, the scale comes from the 50 km bar,
and the orientation was checked against Shackleton and de Gerlache craters. Expect errors
of a few km. One check: a published optimal site in Nobile Rim 2 (−84.20°, 60.70°E) is
about 5 km from that box's centre.

Typical times (live): one site over 7 days, about 5 s; an Artemis region over 30 days
(64-80 cells), about 16 s; a 195-cell drawn region over 14 days, about 45 s.

## Earth line-of-sight windows

API only since the Detailed analysis tab was removed from the UI; the planner's communication criterion covers it.


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

API only since the Detailed analysis tab was removed from the UI. Pick a mission type and
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
`max_earth_blackout_hours`. Earth metrics use this endpoint's ground-level skyline at the sample
times; at −88.85°, 90° for December 2026 they agree with `/api/earth-link` (41.9% vs 42.0%).
Note: `/api/earth-link` and `/api/sun` use one skyline engine (`horizon_profile.py`, from 25 m out),
the mission planner another (`energy_v1/terrain.py`, from 5 m out on the 5 m map). From 2 m up they
agree within about 2–3 percentage points; at 0 m the nearest ground dominates and they can differ a
lot, so equipment is evaluated at 2 m by default.

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
cd <repo>\backend
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
cd <repo>
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
cd <repo>\backend
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
cd <repo>\frontend
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

Expected: the lunar globe over the south pole with the PGDA 78 site pins, the left panel and the
**▶ Try it** demo button.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Database round-trip; `503` with `database unavailable` if the DB is down |
| `GET /api/sites` | All seeded sites, ordered by name |
| `GET /api/sites/{id}` | One site; `404` if unknown, `422` if the id is not an integer |
| `POST /api/mission/search`, `GET /api/mission/search/{id}` | Best mission windows and places (background job) |
| `GET /api/mission/sky` | Terrain skyline with Sun and Earth tracks from one spot |
| `GET /api/earth-link`, `/api/sun/*`, `/api/positions*`, `/v1/*` | See the sections below and <http://127.0.0.1:8000/docs> for all routes |

## Verify the database

```powershell
cd <repo>\backend
.\.venv\Scripts\python.exe -c "import psycopg; from app.settings import get_settings; u=get_settings().database_url.replace('postgresql+psycopg://','postgresql://',1)
with psycopg.connect(u) as c:
    print(c.execute('SELECT installed_rank, version, description, success FROM flyway_schema_history ORDER BY installed_rank').fetchall())
    print(c.execute('SELECT slug, frame, is_fictional FROM sites ORDER BY slug').fetchall())"
```

Expected: the Flyway history rows with `success = True`, and the PGDA 78 sites with
`frame = MOON_ME` (the early fictional sites were removed in migration V7).

## Tests

```powershell
cd <repo>\backend
.\.venv\Scripts\python.exe -m pytest        # about 160 tests; uses DATABASE_URL from backend/.env

cd ..\frontend
npm.cmd test                                # about 100 tests
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
- **The 87–90° S cap is drawn by its own mesh** (`polarCap.ts`), not by globe tiles.
  Cesium's globe tiles follow latitude/longitude, so near the pole they become slivers:
  covering a 20 km disc at ~10 m detail took about 32,768 tiles, each built on the main
  thread (~0.9 ms), which made loading and camera movement very slow. The cap uses
  square tiles on a south-polar stereographic quadtree instead: 64 × 64 cells per
  tile, from 2.56 km cells down to the mosaic's native 5 m. Detail is chosen so cells
  are at most ~2 px apart on screen, and tile building is limited to ~10 ms per frame.
  The globe is clipped at 87° S (`Globe.cartographicLimitRectangle`). Each vertex is
  shaded with the same fixed-light hillshade formula as the former relief image.
  - Measured in Chrome (AMD Radeon, 1280×800) at Site04: orbiting near the pole went
    from 8.5 fps (and over 95 s of main-thread blocking after one drag) to 40 fps with
    no blocking. A close-up view loads in about 4 s with ~430 tiles drawn.
  - Seam with the globe: past 87° S the cap continues as a band two cells wide, lowered
    below the surface, so the globe draws over it. Where the globe's coarser edge tiles
    fall short, the band fills the gap.
  - `globe.depthTestAgainstTerrain` is on for the Moon. Otherwise Cesium clears the
    globe's depth and, near the ground, draws a depth plane at the reference sphere,
    which hides cap terrain below the sphere and lets the cap draw over globe mountains
    in front of it. Cap tiles use `cull: false`: the cap's own selection already culls
    to the view, while Cesium's horizon occluder (sized from the globe's terrain) would
    hide deep crater floors.
**Orbit drag:** left-drag orbits; up/down is inverted (dragging up tilts the Moon toward you).
**Sun and Earth discs** are drawn on a sky dome around the camera in their true direction from
the site and at their true angular size (with a minimum size), always beyond the Moon so ridges
still hide them. They are created once and only moved, so Sky & time steps keep them visible.

**Surface view (street-level).** Scrolling in toward the ground measures zoom from the
terrain below, not from the reference sphere. Below **800 m** the camera descends to a
**4 m** eye height and tilts to the horizon, like an astronaut standing there. **Stand on
surface** in the toolbar does the same at the screen centre.
- **Look:** drag to look around. The ground follows the pointer, as in Street View; the
  view tilts up or down at most 85°.
- **Move:** W A S D or the arrow keys walk at 30 m/s; hold Shift to run at 240 m/s. The
  camera follows the terrain at eye height.
- **Click to jump:** a click (not a drag) jumps there in about half a second (fade out, move,
  fade in), keeping the view pointed the same way. Near the pole the compass heading can
  shift a little on long jumps, because meridians converge there.
- **Scroll:** narrows the lens. At the normal lens, only a long scroll out (about 12 notches
  without pausing) rises to orbit view at 1,500 m; the overlay shows the progress. A pause
  of 0.8 s starts the count again.
- **Leave:** Esc, the overlay's **Leave surface view**, or any camera preset.
- **Re-centre:** the round **Re-centre** button at the bottom right of the globe (or R) points the camera at the Moon's centre again.
- Movement uses vectors rather than latitude/longitude, so walking across the south pole
  keeps going straight. The code is in `globe/surfaceView.ts` (math) and
  `globe/orbitCamera.ts` (controls).
- Measured in Chrome at Site04: about 34 fps at street level, idle or walking.
- **Sky & time** (the overlay button on the surface, or **Sky & time** in the camera toolbar in
  any orbit view, for the selected site): a Stellarium-style time slider for the spot you
  stand on or the selected site. It stays open when you switch views. It loads 30 days of Sun and Earth positions from JPL Horizons once (every 30 min,
  `GET /api/positions/track`) and interpolates between them. Play runs at 10 min/s up to
  1 day/s. **Keep centred** turns the camera to follow the Sun or Earth as time moves. Near
  the pole the Sun circles just above the horizon and often grazes or hides behind ridges.
  - Moon pins skip per-pixel depth testing and are hidden only when the Moon's body is
    between them and the camera, so terrain never slices them. Inside the cap they
    follow the drawn surface. Clicks inside the cap (pins, region corners) use the
    depth buffer, and the camera's ground limit uses the cap's heights.

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

## Next steps

See `docs/PROJECT_STATUS.md` sections 5-6 for known issues and ideas. Main candidates: validate
illumination and Earth visibility against published polar maps (Mazarico et al. 2011, PGDA
illumination products) and Diviner temperatures; use one skyline engine everywhere; DSN station
visibility; real-Sun shading of the terrain in Sky & time.

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

The UI form (`EnergyPlanner.tsx`) is no longer mounted; the API provides all four
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

### Pins to calculations

On the Moon page, enter an optional **Pin title**, click **Add pin on Moon**, then
click the surface. Alternatively enter coordinates and click **Pin these coordinates**.
The selected pin gets a tile with its title, coordinates and the page's UTC time.
Choose that time and click **Calculate energy for this pin**. The modal receives
both the pin's coordinates and the first page's time. Choosing another pin or time
opens a fresh calculation; reopening the same selection preserves its current form.
Pins are available in the location selector for the current session. Energy analysis
still samples elevation from LOLA, independently of the marker's display height.
