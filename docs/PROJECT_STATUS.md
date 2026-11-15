# Project status: Lunar Landing Site Navigator

Last updated: 2026-11-15. Read this first when picking the project up on another machine.
`README.md` is the user and API manual; this file records **what was built, why, what was
verified, and what is still open**.

Commits covered: `f5b14f2` (section 3 below, pushed to `main`) and Noor's merged PR #1
`1139cdc` (energy planner, section 3.6). Check `git log` for anything newer.

---

## 1. Setting up a new machine

| Step | What | Notes |
|---|---|---|
| Backend venv | `cd backend; python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt` | Python 3.13 used |
| `.env` | `backend/.env` holds the shared Neon Postgres `DATABASE_URL` and `FLYWAY_*` lines | **Not in git.** Get it from Noor. Never commit it or print the password |
| Migrations | V1–V7 are **already applied** on the shared Neon database | Skip unless you use a different database |
| Terrain data | `backend/data/terrain/` (~3.6 GB: global LDEM_16, Mosaic81 50 m overview, 5 m chunks) | **Not in git.** Copy it from a teammate, or run `scripts/download_mosaic81.py` then `scripts/prepare_mosaic81.py`. Without it, terrain-dependent endpoints fall back to a smooth sphere with warnings |
| SPICE kernels | `cd backend; .\.venv\Scripts\python.exe scripts\prepare_energy.py` downloads ~45 MB of pinned NAIF kernels into `backend/data/spice/` | **Not in git.** Needed by the `/v1` energy planner (PR #1). Requires `spiceypy` and `shapely` from `requirements.txt` |
| Node.js | Node LTS (26.x used) + `cd frontend; npm install` | On Windows, PowerShell may block `npm.ps1`: use `npm.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| Run | Terminal 1: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload` · Terminal 2: `cd frontend; npm.cmd run dev` | Open http://localhost:5173. API docs at http://127.0.0.1:8000/docs. Vite proxies `/api` to port 8000 |
| Tests | `cd backend; .\.venv\Scripts\python.exe -m pytest` (98 pass) · `cd frontend; npm.cmd test` (46 pass), `npx tsc -b`, `npm.cmd run lint` | `test_health` needs the real database in `.env`; everything else runs offline |

---

## 2. What the app does now (feature map)

Moon globe (Cesium) with local LOLA terrain, opening over the south pole. Moon only (the Earth
globe option was removed in 3.12). The screen has three parts (section 3.12):
1. **Left panel ("Lunar Planner")**, top to bottom: a one-line intro; **Site** (one selector for the
   PGDA 78 sites and your pins; **Drop a pin**, with an optional name; **Enter coordinates…** folded,
   with Fly to coordinates and Pin these coordinates); the **site card** for the chosen site or spot
   (name, coordinates, elevation, notes; **Check this site**, **Stand here**, **Inspect terrain**,
   **Show Sun & Earth** at the mission start); **Open mission planner**; and **Display & data**
   folded (terrain toggle, controls help, data sources).
2. **Camera views**, floating top right: Whole Moon, South pole, Center view, Inspect 3D terrain,
   Look toward Earth/Sun (after Show Sun & Earth), and **Stand on surface** (section 3.10).
3. **Mission planner drawer** on the right, beside the globe (not a modal). It is the hub for all
   three aspects (section 3.7):
   - **Plan tab:** Where (selected site / Artemis III region or known site / region drawn on the
     globe) → When (the one shared mission range: start, end, 1/7/14/30-day buttons, max 366 days,
     UTC) → Mission type → one `/api/mission/analyze` request → power, heat, communication and
     ground cards, criterion checks, region map, best spots, **Fly here** (the drawer and the
     results stay).
   - **Detailed analysis tab:** Noor's `/v1` forms, plus the detailed Earth contact and Sunlight &
     temperature panels, for the selected site.

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
| `POST /api/mission/analyze`, `GET /api/mission/regions` | `routers/mission.py`, `mission.py`, `data/artemis_iii_regions.json` | Planner hub: power + Earth (v1 SPICE) and heat (regolith model) per cell for a point or polygon, scored by mission type; known Artemis III regions |
| `POST /v1/solar/point`, `/v1/solar/region`, `/v1/power/mission`, `/v1/power/windows` | `routers/energy_v1.py`, `energy_v1/` (Noor, PR #1) | Lunar Energy API v1: SPICE DE440 ephemeris, solar point and region analysis, panel and battery sizing, power windows. UI: **Mission planner** drawer → **Detailed analysis**. Contract: `docs/requirements/lunar-energy-api-v1*.md` |

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

### 3.6 Noor's energy planner (PR #1, merged into main as `1139cdc`)
Added `/v1` Lunar Energy API (offline SPICE ephemeris, its own terrain and horizon cache under
`energy_v1/`), the **Mission planner** modal (`EnergyPlanner.tsx`, `api/energy.ts`), titled mission
pins, and a Vite proxy for `/v1`. Pulled and set up on 2026-11-15: `spiceypy` 8.4.0 and `shapely` 2.2.0
installed, kernels downloaded with verified hashes, 129 backend and 55 frontend tests pass.

**Overlap to resolve with the team:** `/v1/solar/*` (SPICE, Noor) and `/api/sun/*` (Horizons, merged
from `lunar_sun`) both compute sunlight and illumination. Pick one as the source for sunlight, or
document clearly which feature uses which.

### 3.7 Mission planner as the hub (2026-11-15, after PR #1)
User decisions: the planner covers heat, power and communication; spatial input is a **free polygon
drawn on the globe** or a **known region/site**; the known list adds **NASA's 9 Artemis III regions**;
the simple view shows **sunlight only** for power (sizing stays in Advanced); regions **combine both
engines**. Anything complicated goes in an **Advanced** tab.
- Backend `POST /api/mission/analyze`. Cells come from v1 `make_grid` at the finest level with ≤ 200
  cells. Power and Earth per cell come from v1 `solar.series` (same definitions as `/v1/solar/region`,
  vertical-tracking panel energy). Heat runs on the same cell centres with `app.sun` + `thermal`. A single
  site also gets refined `/api/earth-link` windows. Cells are scored with `sun_analysis.judge` using
  `mission.PRESETS` (illustrative thresholds).
- Artemis III regions: NASA gives no coordinates (release text and LPSC 2026 abstract checked). Boxes
  were digitized by colour from the LPSC abstract's map (`derivation` is stored in the JSON). Checks:
  Shackleton and de Gerlache craters land where expected; a published Nobile Rim 2 optimal site is
  about 5 km from the box centre. Accuracy is a few km.
- Frontend: `MissionPlanner.tsx` (Plan/Advanced tabs, cards, SVG cell map, ranking), `api/mission.ts`,
  `Sparkline.tsx` (shared), globe `drawing` mode + `overlay` (outline, corners, ranked spots) in
  `createLunarViewer.ts`, draw bar in `App.tsx`. `EnergyPlanner` gained `embedded` (hides its close
  button). The dialog is now named "Mission planner"; App tests were updated to open the Advanced tab.
- A render loop (new location object every render → overlay callback → re-render) was found by a hanging
  test run and fixed by depending on coordinates only.
- Live: Malapert point in 4.8 s; Haworth (64 cells) and Mons Mouton Plateau (80 cells), 30 days, in about 16 s;
  a 195-cell drawn box in Shackleton in 45 s. It is permanently shadowed in every season and sits at
  about 30 K everywhere, the expected result for permanent shadow without scattered light.

### 3.9 Polar cap renderer: rendering performance (2026-11-15)
The user reported very slow terrain loading and camera movement. Measured cause: Cesium's
`GeographicTilingScheme` makes sliver tiles at the pole. A 20 km disc at level 11 (~10 m)
needs 32,768 tiles, whose polar row is 2 m wide; each costs ~0.9 ms of main-thread JS
(`buildLolaHeightmap`), about 29 s for that disc. Downloads were not the cause (<0.1 s each).
Also `maximumScreenSpaceError = 1.5` and `tileCacheSize = 256` (unchanged for the globe outside the cap).

Fix (user chose the full fix, "option C"):
- `frontend/src/globe/polarCap.ts`: the cap is a south-polar stereographic quadtree of
  square 64×64 tiles (L1 163.84 km … L10 5 m cells). Selection: cells ≤ 2 px apart, parents
  stay drawn until all visible children are ready, building is limited to 10 ms per frame,
  700 tiles are kept with LRU eviction that never evicts ancestors of drawn tiles, and 5 m
  chunks are used from L9 up (`mosaicChunks.prepareXY`). Custom vertex-shaded `Appearance`
  using the relief image's hillshade formula. `sampleCapXY` in `lolaSampling.ts` uses the
  same blend as `sampleLola`.
- `createLunarViewer.ts`: with the polar region active, globe `cartographicLimitRectangle` =
  north of 87° S, globe terrain = global-only provider, no relief imagery layer,
  `scene3DOnly: true`, `globe.depthTestAgainstTerrain = true` (Moon). Pins: cap height via
  `drawnHeightAt` (`CallbackPositionProperty`); all Moon pins use infinite
  `disableDepthTestDistance` plus a Moon-body occluder (sphere R−10 km). Clicks use
  `scene.pickPosition` in the cap; the orbit camera's ground limit uses the cap's heights.
- Problems found and fixed along the way, each by measuring:
  1. Black tile holes: Cesium's horizon occluder is sized from the globe's terrain, so it hid
     tiles of crater floors that lie below it. Fixed with `cull: false` on cap primitives.
  2. Pins and labels sliced: per-pixel depth vs nearby rims. Fixed with the no-depth-test +
     occluder approach (matches how globe-clamped pins behaved).
  3. Dotted black seam at 87° S: coarse globe edge tiles vs the cap. Fixed with a lowered
     two-cell band past 87° S plus a deep wall.
  4. Black screen when zoomed in: Cesium's depth plane at the reference sphere hid cap terrain
     below the sphere. Fixed with `depthTestAgainstTerrain`.
- Verified in headless Chrome on the real GPU (scratch harness, not in repo): the before/after
  numbers are in the README "The lunar globe" section. Also checked: pin placement in the cap
  (coordinates match an independent conversion), drawing a region in the cap, terrain
  off/on, Earth↔Moon, zooming to the ground limit, the Sun & Earth view, and far-side pins
  hidden by the Moon. No page errors. Tests: 70 frontend (8 new) and 139 backend pass; build OK.
- Known, unchanged: the zoom floor is 40 m above the reference sphere (README), so in deep
  craters the closest view is still hundreds of metres above the ground. The N/E/S/W horizon
  labels of the Sun & Earth view always draw on top (as before).

### 3.10 Street-level surface view (2026-11-15)
The user asked for Street View-style controls when zoomed in close, with VR as a stretch goal.
- **Behaviour:** zoom is now measured from the ground (the old floor was 40 m above the
  reference sphere, which in craters stopped hundreds of metres up). Below 800 m it switches to
  surface view: the camera descends to 2 m and tilts to −8°. Drag to look (grab semantics,
  pitch ±85°). WASD/arrows walk at 30 m/s, Shift runs at 240 m/s, following the terrain. A
  click travels there with a hop arc and keeps the view direction (parallel transport). Scroll
  narrows the lens (down to 15°); scrolling out past the normal lens rises to orbit view at
  1,500 m. Esc, the overlay's exit button or any camera preset leaves.
- **Code:** `globe/surfaceView.ts` (pure vector math; walking across the pole stays
  straight), `globe/orbitCamera.ts` (orbit + surface modes, options object), the HUD in
  `components/LunarGlobe.tsx` ("surface-view" events), `GlobeHandle.surface("enter"|"exit")`.
  Cap ground height for the camera is the higher of the true and the drawn surface.
- **Fixed during verification:** clicks were timed when the handler ran, so on a busy page
  a quick click looked like a long press. Now `event.timeStamp` is used. Travel angle uses
  atan2 (acos lost precision for short hops).
- **Verified in Chrome (scratch harness):** lands at 2.00 m; a 200 px drag turns exactly the
  expected 10.0°; W walks 61.6 m in 2 s; Shift+W runs about 250 m in 1 s; click-travel reaches
  the spot with the same heading and ends at 2.00 m; scrolling out rises to exactly 1,500 m; the
  toolbar button, presets and Esc all work; about 34 fps; no page errors. Tests: 78 frontend
  (8 new) pass.
- **Ideas:** near-field ground looks smooth because the finest data is 5 m; a procedural
  regolith texture or LROC NAC imagery could add close-up detail. **VR:** Cesium still has
  `scene.useWebVR` (split-screen stereo for phone headsets like Cardboard) but no WebXR;
  surface view's fixed eye height and separate look/move are designed to map onto it
  (device orientation for looking, a button or gaze for moving).

### 3.11 Sky & time slider (2026-11-15)
In surface view, **Sky & time** loads `GET /api/positions/track` (new: Sun and Earth az/el/range
from one Horizons series per body, 30 days at 30 min, max 3,000 samples) for the standing spot.
`globe/skyTrack.ts` interpolates (azimuth the short way round), and `components/SkyTimePanel.tsx`
provides the slider, play (10 min/s to 1 day/s) and **Keep centred** (Sun/Earth/Off). Following
uses `GlobeHandle.surfaceLook(az, el)` → `surfaceView.facing`. While open, the panel's positions
replace the snapshot on the globe. Orbit-view sight lines and planes now show only when the
camera is more than 10 km from the site.
- Found and fixed: Play caused React "Maximum update depth exceeded", because a passive effect
  pushed state to the parent on every frame. The sky is now updated from the handlers and
  animation frames directly.
- Verified in Chrome: the camera faces the Sun within 1° (103°/1° vs 102.5°/1.43°); 12 h of
  sliding moves the Sun 102.5°→96.4° and the camera follows; Play at 6 h/s advances 11.9 h in 2 s;
  Earth centring works; no page errors on repeated runs. At Site04 the Sun at 1.4° sits on the
  local ridge (half hidden), which is correct. Tests: 83 frontend, 140 backend.

### 3.12 UI/UX reorganisation (2026-11-15)

Two review agents (a UX auditor and an architect) looked at the app with screenshots. Main problems:
two navigation systems (top bar and sidebar) plus a modal that hid the globe; a long sidebar
with no order (body, terrain, sites, coordinates, pins, dates, Horizons, planner); the mission range
twice; the planner closing whenever you flew somewhere (losing the results); "Advanced" mixing three
tools; the "LUNAR ENERGY API · V1" heading inside the planner; Arabic-Indic digits in number and
date inputs under an Arabic system locale; camera buttons buried in the panel; on phones the panel
covered the Moon.

Applied:
- **Layout:** top nav, header and the "MOON" hint removed. Left panel = pick a site; floating camera
  toolbar = look around; right drawer = analyze. See section 2.
- **One "where":** the selected site (named site, pin, typed coordinates or a best spot from Fly
  here) feeds the site card, the planner and the detailed tools. With nothing chosen, the planner's
  "Selected site" is disabled and it starts on the known regions. Opening the app no longer drops a
  pin at the mosaic centre; it flies to the South pole view.
- **Mission planner** (`MissionPlanner.tsx`): `location` may be null; results are keyed by the area,
  so they survive Fly here and hide when the area changes; Fly here no longer closes the planner;
  labels: "Detailed analysis", "Selected site", "Artemis III region or known site", "Draw a region on
  the Moon", "Mission type". The planner is always mounted; **Check this site** remounts it on the
  site. Drawing a region no longer closes or reopens anything.
- **Surface view** tucks the panel and the drawer away and brings the panel back on leaving
  (`LunarGlobe` `onSurfaceChange`). **Stand here** enters at the site (`surface("enter", at)`).
- **Locale-proof inputs:** coordinates, the mission range and every field of the energy forms are
  text inputs (`inputMode` decimal/numeric) instead of number/date pickers. Limits are checked in
  code (`data-min`/`data-max` in `EnergyPlanner`, 2020–2035 for dates) with a plain message.
- **Pin labels:** other pins' names show within 400 km of the camera; the selected one always.
- **Phones (≤ 600 px):** the panel and the drawer are bottom sheets (45% and 70% of the height).
- Files: `App.tsx` (rewritten), `LunarGlobe.tsx` (props `actionsRef`, `onSurfaceChange`,
  `dataDetails`, `initialView`; camera toolbar; Display & data), `MissionPlanner.tsx`,
  `MissionRange.tsx`, `EnergyPlanner.tsx`, `createLunarViewer.ts` (surface at a spot, label
  distance), `index.css` (drawer, toolbar, site card, bottom sheets; old nav/dialog rules removed),
  tests updated (`App.test.tsx` rewritten for the drawer; planner null-location test; energy-form
  limit test).
- **Verified in headless Chrome** (1440×900 and 390×844, `--lang=en` and `--lang=ar`): no nav;
  "Lunar Planner" once; panel 474 px tall with no site; 590 px of globe between panel and drawer;
  one mission start field; Western digits everywhere under Arabic; Check this site selects the
  site; Detailed analysis widens the drawer to 760 px; Stand here enters surface view and hides the
  panel, drawer and toolbar, and leaving restores the panel; phone panel 380 px of 844; no page
  errors. Tests: 85 frontend; tsc clean; lint only the old warning.

### 3.13 Team notes after the reorganisation (2026-11-15)

Six notes from the team, all applied:
1. **Sun and Earth missing or wrong.** Cause: every Sky & time step removed and re-added the Sun
   and Earth entities, and Cesium's reused billboard lost its texture (the label stayed, the disc
   vanished, most visibly at street level). Fix (`createLunarViewer.ts`): the discs live in their
   own `CustomDataSource("sky")`, are created once and only updated (direction, range, label).
   They are drawn on a sky dome around the camera (at least 20,000 km, always beyond the Moon) in
   the true direction from the site, at true angular size, instead of at 1.5e11 m. At the pole
   the Sun really stays within about 1.5° of the horizon and Earth within about 7°, so both look
   close to the ground; that part is correct.
2. **Sky & time in every view.** A **Sky & time** button in the camera toolbar opens it in orbit
   views for the selected site; it stays open across surface/orbit switches. Keep centred in
   orbit turns the camera in place toward the body (`surfaceLook` handles both modes).
3. **Click = quick jump.** Click-to-move fades out, moves and fades in (0.45 s total; the move
   happens at 40%) instead of gliding (`orbitCamera.ts`, a black veil over the canvas).
4. **Detailed analysis sub-tabs:** Power, Heat & sunlight, Earth contact (`DetailedTabs` in
   `App.tsx`). Hidden tabs stay mounted, so results survive switching. The drawer is 760 px only
   on Power.
5. **Orbit up/down inverted** (left-drag only; street view unchanged).
6. **Leaving street view:** scroll out at the normal lens must add up to 1,200 (deltaY, about 12
   notches) without a 0.8 s pause; the overlay shows "Keep scrolling out to leave… N%". The
   button and Esc still leave at once.
- Tests: 87 frontend (new: exit-progress overlay; Sky & time from orbit with keep-centred and
  staying open across views; sub-tabs in the App test). tsc clean; lint only the old warning.
- Verified in headless Chrome at Site01: the Sun disc shows at street level and from orbit with
  keep-centred (the sight line meets it); Earth shows at +4° in both views; a click jump takes
  about 0.5 s; 4 notches do not leave, a pause resets, 18 more leave; no page errors.

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

- The 3.12 layout was checked in headless Chrome only. A hands-on pass is still worth doing for
  polygon drawing with the drawer open, the phone bottom sheets with a real touch screen, and a
  region analysis followed by several Fly here clicks.
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
