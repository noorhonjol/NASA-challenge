# Project status: Lunar Landing Site Navigator

Last updated: 2026-11-15. Read this first when picking the project up on another machine.
`README.md` is the user and API manual; this file records **what was built, why, what was
verified, and what is still open**.

Last commit at the time of writing: `b2748fd` (local LOLA mosaic terrain, named site pins,
live Horizons views). Everything in "Work since b2748fd" below was uncommitted when this
file was written. Check `git log` to see whether it has been pushed since.

---

## 1. Setting up a new machine

| Step | What | Notes |
|---|---|---|
| Backend venv | `cd backend; python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt` | Python 3.13 used |
| `.env` | `backend/.env` holds the shared Neon Postgres `DATABASE_URL` and `FLYWAY_*` lines | **Not in git.** Get it from Noor. Never commit it or print the password |
| Migrations | V1–V7 are **already applied** on the shared Neon database | Skip unless you use a different database |
| Terrain data | `backend/data/terrain/` (~3.6 GB: global LDEM_16, Mosaic81 50 m overview, 5 m chunks) | **Not in git.** Copy it from a teammate, or run `scripts/download_mosaic81.py` then `scripts/prepare_mosaic81.py`. Without it, terrain-dependent endpoints fall back to a smooth sphere with warnings |
| Node.js | Node LTS (26.x used) + `cd frontend; npm install` | On Windows, PowerShell may block `npm.ps1`: use `npm.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| Run | Terminal 1: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload` · Terminal 2: `cd frontend; npm.cmd run dev` | Open http://localhost:5173. API docs at http://127.0.0.1:8000/docs. Vite proxies `/api` to port 8000 |
| Tests | `cd backend; .\.venv\Scripts\python.exe -m pytest` (98 pass) · `cd frontend; npm.cmd test` (46 pass), `npx tsc -b`, `npm.cmd run lint` | `test_health` needs the real database in `.env`; everything else runs offline |

---

## 2. What the app does now (feature map)

Moon globe (Cesium) with local LOLA terrain. The left sidebar has, top to bottom:
1. Body (Moon or Earth), terrain toggle, named LOLA sites (PGDA 78), lat/lon/altitude, **Fly to coordinates**.
2. **Mission time range** (one shared control: start, end, 1/7/14/30-day buttons, max 366 days, all UTC).
3. **Show Sun & Earth at mission start**: `/api/positions` snapshot plus "look toward" camera views.
4. **Mission checks**, both using the mission range and location:
   - **Earth contact windows**: `/api/earth-link` timeline, visible %, longest blackout, window list.
   - **Sunlight & temperature**: `/api/sun/region` with a mission-type preset, stat tiles, sunlight and
     temperature mini charts, pass/fail per criterion. **Find better spots within 10 km** runs
     `/api/sun/judge` on a 7×7 grid; **Fly here** moves the camera and the location to the pick.

### Backend endpoints

| Endpoint | Module | Purpose |
|---|---|---|
| `GET /api/health`, `/api/sites`, `/api/terrain/*`, `/api/terrain-datasets` | pre-existing | Database health, site pins, terrain tiles and manifests |
| `GET /api/positions` | `routers/positions.py`, `horizons.py` | Sun and Earth az/el at one instant (JPL Horizons) |
| `GET /api/earth-link` | `routers/earth_link.py`, `earth_link.py`, `horizon_profile.py` | Earth line-of-sight windows over a period, terrain-aware |
| `GET /api/sun/point` | `routers/sun.py`, `sun.py`, `sun_analysis.py` | Sun state, irradiance, panel advice, next sunrise and sunset, optional temperature |
| `POST /api/sun/region` | same + `thermal.py` | Per-point stats, time series, grid maps, CSV; optional `preset`/`criteria` adds `judge` |
| `POST /api/sun/judge` | same | Score and rank points or an area against criteria or presets |
| `GET /api/sun/metrics` | same | Metric names and presets |

---

## 3. Work since commit b2748fd (this session, 2026-11-15)

### 3.1 Earth line-of-sight endpoint (`/api/earth-link`)
Merged from two designs: the pasted "Earth-link availability endpoint" plan and
`lunar_communication_backend_requirements_v2.md` (from another teammate or model).
- **Kept from v2:** an `unknown` status that is never silently treated as clear; geometric line of
  sight vs RF (`rf.assessed: false`); per-sample `los` of clear/grazing/blocked/unknown using Earth's
  disc; track refinement (substeps ≤ 0.05°); blocked causes `lunar_limb` vs `terrain`; hard criteria
  graded pass/fail/inconclusive/criteria_not_specified, with pessimistic vs optimistic handling of
  unknown time; blackout counted including the period edges; minimum usable window.
- **Deferred from v2:** region search, async jobs, rerank, `/api/v1` naming, RF link budget, ground stations.
- **Geometry** (`horizon_profile.py`): great-circle ray destinations (vector form, stable at the poles).
  Ray length is `acos(r_min/r_o) + acos(r_min/r_max)`, beyond which no terrain can rise above the sight
  line. Steps run from 25 m and grow 0.5% per step to 900 m. Elevation is
  `atan2(r_t cosθ − r_o, r_t sinθ)`; the smooth-sphere limb is `−acos(r_ground/r_o)`.
- **Skyline:** 1° coarse, then 0.1° fine only where Earth passes within (max skyline + 2° + margin).
- **Without terrain:** smooth-sphere lower bound. Times are `blocked` when Earth must be hidden,
  otherwise `unknown`.
- `terrain.py`: the Mosaic81 overview has a circular coverage (`coverage_radius_m` ≈ 91 km); edge
  blending now includes the circle, not just the square bounds.

### 3.2 Bug fixed in `horizons._epoch`
Horizons drops the seconds (`2027-Mar-10 06:30`) when a series starts off the hour, even with
`TIME_DIGITS='SECONDS'`. Before the fix, any range starting off the hour returned 502
"Horizons returned no usable observer series". The parser now accepts `HH:MM`, `HH:MM:SS` and
`HH:MM:SS.fff`, with a regression test using a real Horizons row.

### 3.3 Frontend Earth contact panel, then the shared mission range
- `EarthLinkPanel.tsx`: on-demand request, SVG timeline (visible, blocked, striped unknown), metrics,
  window list, warnings, terrain and RF notes.
- The step size is chosen automatically (`stepFor` in `api/client.ts`): the smallest of 10/15/30/60/120/180/360 min
  that keeps ≤ ~1,500 Horizons samples.
- The user asked for one time range for everything. The mission range is now `MissionRange.tsx`
  plus `mission.ts` helpers, owned by `App.tsx`. The old separate "Date & time" field was removed;
  the positions snapshot uses the mission start. Panels are keyed on location + range, so results
  clear whenever either changes.

### 3.4 Orbit camera keeps tilt and roll
`globe/orbitCameraMath.ts` `orbitFrame` used to re-center the camera on every step, losing free-look
tilt and roll. It is now one rigid rotation about the body center applied to position, direction and
up. Axes follow the screen (camera right projected onto the tangent plane), with a fallback when the
camera is rolled onto its side. Compass heading can still drift over long orbits; that is inherent.
**Center view** or **R** still re-centers.

### 3.5 Merged the `lunar_sun` prototype (Sun, heat, judge)
Source: a standalone FastAPI project (`lunar_sun/`, from a teammate) with `/v1/sun/point`,
`/v1/heat/region`, `/v1/judge`, a rasterio DEM loader, astropy offline ephemeris and a Plotly page.
- **Replaced with our code:** its Horizons parser (now `horizons.body_series(target, ...)`, with
  `earth_series` as a wrapper); its DEM and horizon code (now our LOLA `terrain.sample_heights` +
  `horizon_profile.terrain_horizon`, at ground level, 1° skyline for ≤ 25 points and 5° above that).
- **Kept from it:** Sun-disc visible fraction, irradiance (1,361 W/m² at 1 AU), `thermal.py`
  (Hayne et al. 2017 1-D regolith model, copied unchanged, one-lunation spin-up before `start`),
  region statistics, judge scoring and presets (`solar_rover`, `lander_survival`, `ice_cold_trap`).
- **Added:** Earth metrics (`earth_visible_fraction`, `max_earth_blackout_hours`) from the same
  skyline; a `crewed_landing` preset; a memory cap `MAX_CELLS` = 2,000,000 points × steps;
  `elevation_m` in judge rankings (used by **Fly here**); `preset`/`criteria` on `/api/sun/region`
  so the panel needs one request.
- **Approach:** one Horizons series per body at a reference site (the centroid, kept off the exact
  pole). The body position is rebuilt as site + direction × range and viewed from each point,
  so parallax is included.
- **Not merged:** the astropy offline ephemeris fallback (Horizons is the single source), the rasterio
  GeoTIFF loader (`LOLA_DEM_PATH`), the standalone Plotly page (region heatmaps exist in the API but
  are not drawn in the app), and the `/v1` paths.

---

## 4. Verified live (real LOLA terrain and Horizons)

- Earth-link at −89.9°, 0° over Dec 1–8, 2026: blocked all week. At −85°, 0°: visible for the first
  19.8 h, then blocked by the limb and terrain.
- The range starting off the hour (Mar 10 06:30 to Apr 9 06:30, 2027, at −85°, 0°) works after the
  `_epoch` fix: 63% visible, 2 windows.
- **Frame check:** Sun and Earth positions rebuilt at (−85°, 0°) and viewed from (−87°, 60°) match
  Horizons' direct output there to < 0.00001°. The two sites differ by about 60° in azimuth, so this
  is a real test.
- Judge Earth fraction vs `/api/earth-link` at −88.85°, 90°, December 2026: 0.419 vs 0.4199.
- `/api/sun/point` at −89.76°, −171.87°: a 33° west-facing slope, so the low eastern Sun is behind a
  32° skyline (terrain_shadow), at 86 K. Physically consistent.
- **Timing:** one site with temperature over 7 days, about 12 s. 49-point crewed-landing judge, about
  5.5 s. 25-point month judge with temperature and Earth, about 14 s. One-year earth-link, about 8.5 s
  (mostly Horizons).
- JPL Horizons sometimes times out (60 s). The API then returns 502, and a retry usually works.

## 5. Not verified / known issues

- **None of the new UI has been looked at in a real browser** (mission range layout, Sun panel charts,
  orbit feel). The component tests pass and the type check is clean, but a visual check is still needed.
- Assumption: Horizons `SITE_COORD` and the LOLA grids are both MOON_ME on a 1,737.4 km sphere. The
  frame check above supports Horizons being self-consistent, but it has not been checked against an
  independent MOON_ME source.
- The heat model has no scattered light or terrain infrared, so shadowed floors read 10–30 K too cold.
- Pre-existing lint warning: `react(set-state-in-effect)` in `App.tsx` (the positions fetch effect).
- Pytest shows a Starlette/httpx deprecation warning; it is harmless.

## 6. Ideas and next steps (not started)

- Draw region heatmaps (score map, sunlit fraction, temperature) on the globe or in a panel.
- An Earth-link timeline overlaid with the Sun timeline for the same mission range.
- An offline ephemeris fallback when Horizons is down (would need astropy or SPICE).
- RF link budget / DSN station visibility (deferred from v2).
- Async jobs for big region requests (deferred from v2).

## 7. Conventions to keep

- Report geometric line of sight, never claim a radio link; never treat unknown as clear.
- Every terrain-dependent response carries `terrain_model`, `warnings` and `limitations`.
- Time inputs are timezone-aware UTC; datetime-local fields in the UI are read as UTC.
- Ask JPL Horizons one query at a time, never in parallel.
- Large data (`backend/data/terrain/`) and secrets (`.env`) stay out of git.
