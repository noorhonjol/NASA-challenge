# Lunar Energy API — Specification v1

Status: v1 contract supplied by the user on 2026-11-15.
The previous screening code was removed; the replacement is documented in
[implementation decisions](lunar-energy-api-v1-decisions.md).
This file records its normative requirements; illustrative response values are not
numerical acceptance fixtures. Open definitions and contradictions are tracked in
[lunar-energy-api-v1-analysis.md](lunar-energy-api-v1-analysis.md), without silently
changing the requested contract. This supersedes the earlier screening scope in
[lunar-power-planning.md](lunar-power-planning.md) where they differ.

## Purpose and endpoints

Energy component of the Lunar Landing Site Navigator. Shared core:
Sun vector (JPL Horizons/SPICE) + LOLA terrain and horizon masks → irradiance time
series. Mission sizing and operating windows use this same core for one cell.

| Method and path | Purpose |
|---|---|
| GET /v1/solar/point | Solar conditions for one point and instant |
| POST /v1/solar/region | Area/time-range solar metrics as a grid |
| POST /v1/power/mission | Required panel and battery sizes at a point |
| POST /v1/power/windows | Equipment operating windows at a point |

Sources: Horizons/SPICE DE440 Sun position; LOLA polar/global DEM elevation, slope
and aspect; precomputed LOLA horizons for shadowing and partial solar visibility.
No reflected secondary illumination or thermal model. User supplies survival load.
DEM resolution limits accuracy, especially at solar elevation below about 1°.

## Conventions

- JSON, base path `/v1`; every successful response includes `meta`.
- Latitude: selenographic, [-90, 90]. Longitude: east-positive [-180, 180];
  also accept [0, 360), normalized to the canonical range.
- Coordinate frame: Moon ME, aligned with the installed LOLA product.
- ISO 8601 UTC times; angles in degrees; distances/resolution in meters;
  irradiance W/m²; energy Wh or Wh/m²; power W; duration hours.
- Percentages: 0–100; fractions and scores: 0–1.
- `meta`: `request_id`, `api_version` = `1.0`, `dem_product`, `ephemeris`,
  `computed_in_ms`. Actual source identity must be reported, not example labels.

Error envelope: `{"error":{"code":"INVALID_PARAMETER","message":"...","field":"location.lat"}}`.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | INVALID_PARAMETER | Missing, wrong type, out of range |
| 400 | INVALID_TIME_RANGE | Reversed, excessive or unsupported dates |
| 404 | OUT_OF_COVERAGE | Outside loaded DEM coverage |
| 413 | REQUEST_TOO_LARGE | Cell/sample work exceeds limit; suggest coarser resolution/step |
| 422 | INFEASIBLE_INPUT | Valid but contradictory inputs |
| 500 | INTERNAL_ERROR | Unexpected failure |
| 503 | DATA_UNAVAILABLE | Ephemeris/DEM unavailable |

## Shared objects

### Location

`lat`, `lon` required. `height_m` defaults to 0, range [0, 50]: panel/sensor height
above the local surface, not a replacement for DEM elevation. API enriches the
location with `elevation_m`, `slope_deg`, `aspect_deg`.

### TimeRange

`start`, `end` required; end after start. `step_hours` defaults to 1 for point
analysis, 6 for region, range [0.25, 24]. Maximum span 2 years; supported epochs
2020-01-01 through 2035-12-31. Exact boundary and interval-count conventions need
resolution in the analysis document.

### PanelConfig

- `mode`: `auto` (default), `fixed_horizontal`, `fixed_tilt`,
  `vertical_tracking`, `full_tracking`.
- `tilt_deg` and `azimuth_deg` required for `fixed_tilt`; tilt 0 = flat,
  90 = vertical, azimuth 0 = north clockwise.
- `area_m2`: positive, required for equipment windows; ignored for mission sizing.
- `efficiency`: default .30, (0, 1]. `degradation_pct`: default 0, [0, 50].
- Horizontal is flat; fixed tilt has a constant normal; vertical tracking rotates
  a vertical panel in azimuth; full tracking faces the Sun in both axes.

### Assumptions

| Field | Default | Range/meaning |
|---|---|---|
| battery_dod | .8 | (0, 1], usable depth of discharge |
| battery_efficiency | .95 | (0, 1], round-trip efficiency |
| margin_pct | 20 | [0, 200], sizing margin |
| prefer_simple | false | Prefer fixed modes within tolerance in auto mode |
| simplicity_tolerance_pct | 15 | [0, 100] |

### PanelRecommendation

For `auto`, return `selected_mode`, `selected_tilt_deg`,
`selected_azimuth_deg`, `criterion`, and `comparison`.
Each comparison entry contains `mode`, applicable `tilt_deg`/`azimuth_deg`,
`energy_per_m2_wh`, and the endpoint ranking quantity.

Evaluate all modes over the requested period. Optimize fixed tilt by searching
0–90° tilt and 0–<360° azimuth at 5° increments. Rank mission modes by
`min_panel_area`; window modes by `max_window_hours`. With `prefer_simple`, choose
the best fixed mode within tolerance of the overall best. The supplied spec also
states full tracking is selected only when `prefer_simple=false`; the no-fixed-mode-
within-tolerance case remains an open decision.

### Timeseries

Parallel arrays sharing one index, with ISO UTC `times` and named numeric series.

## GET /v1/solar/point

Query: required `lat`, `lon`, `time`; optional `height_m` = 0,
`panel_tilt_deg`, `panel_azimuth_deg`. Azimuth is required with custom panel tilt.

Response:

- Enriched `location`, `time`.
- `sun`: `elevation_deg`, `azimuth_deg`, `distance_au`,
  `horizon_elevation_deg`, `visible_fraction`, `is_illuminated`,
  `incidence_angle_deg` (Sun to terrain normal).
- `irradiance`: `toa_w_m2`, `horizontal_w_m2`, `terrain_w_m2`,
  `vertical_tracking_w_m2`, `full_tracking_w_m2`, `custom_panel_w_m2`
  (null without a custom panel).
- `earth`: `elevation_deg`, `is_visible`.
- `meta`.

Definitions: Sun elevation is relative to the ideal tangent horizon. Terrain
horizon is sampled at Sun azimuth. Visible fraction is the portion of the 0.53°
solar disk above that horizon; illuminated iff fraction > 0.

Let `I = 1361 / distance_au²`, `f = visible_fraction`, `e` = solar elevation,
`i` = incidence angle. Convert degrees to radians in trig functions.

| Surface | Irradiance |
|---|---|
| TOA beam | I |
| horizontal | I × f × sin(e) |
| terrain | I × f × max(0, cos(i)) |
| vertical tracking | I × f × cos(e) |
| full tracking | I × f |
| custom | Project onto supplied panel normal; otherwise null |

Negative horizontal projection with partial Sun and the treatment of the solar disk
in incidence calculations are explicitly open in the analysis.

## POST /v1/solar/region

Input:

- `area.type`: required `bbox`, `polygon`, or `circle`.
- Bbox: `min_lat`, `max_lat`, `min_lon`, `max_lon`.
- Polygon: `coordinates` in **[lat, lon]** order, >=3 vertices, auto-closed;
  reject self-intersection.
- Circle: `center` Location and positive `radius_m`, <=50,000.
- `resolution_m` default 240, snapped to nearest available DEM resolution >= request.
- `height_m` default 0 applied to all cells.
- `period`: TimeRange, required.
- `panel_mode`: `horizontal` default, `terrain`, `vertical_tracking`, `full_tracking`.
- `metrics`: optional list, default all; `include_timeseries` default false.
- Cells × samples <=2,000,000; otherwise 413 with suggested resolution/step.

| Metric | Unit | Definition |
|---|---|---|
| illumination_pct | % | Share of samples with f > 0 |
| mean_visible_fraction | fraction | Mean f |
| mean_irradiance | W/m² | Mean irradiance on chosen surface |
| peak_irradiance | W/m² | Maximum irradiance |
| total_energy | Wh/m² | Integrated irradiance |
| max_darkness_hours | h | Longest continuous run with f = 0 |
| mean_sun_elevation | deg | Mean elevation while lit |
| earth_visibility_pct | % | Share of samples with Earth above horizon |
| mean_slope | deg | Static DEM slope |

Response: `grid` contains `rows`, `cols`, snapped `resolution_m`, `projection`
(example `polar_stereographic_south`), and 2D cell-center `lat`, `lon`, `mask`.
Outside-area cells have mask false and null in coordinate/metric arrays.
`period` includes start, end, step_hours and samples. Each requested metric has
`unit`, `min`, `max`, `mean`, 2D `values`. `ranking.by` is the first requested
metric; `ranking.top` contains up to 10 `{row,col,lat,lon,value}` records. Darkness
is ranked ascending. Optional `timeseries` contains `times`, `irradiance[t][row][col]`
and `visible_fraction[t][row][col]`; otherwise null. Include `meta`.

## POST /v1/power/mission

Input: required `location`, `start`, `duration_hours` in (0,8760];
`step_hours` default 1; optional panel and assumptions use defaults above.
`panel.area_m2` is ignored: sizing area is the output.

`load`:

- `profile`: constant default, or custom.
- `average_w` required for constant; operating power while illuminated.
- `peak_w` default average_w, used for discharge-rate checks.
- `survival_w` required, <=average_w, used in darkness.
- `custom`: required for custom profile, `{times,power_w}` covering the mission.

Operating rule: use average/custom load while illuminated; survival load while dark.
`P_solar = irradiance(mode) × area × efficiency × (1 − degradation_pct/100)`.

Response:

- Enriched `location`; `period` start, end, duration_hours.
- `solar_conditions`: illumination_pct, longest_darkness_hours,
  longest_darkness_start, mean_irradiance_w_m2.
- `energy`: load_total_wh, load_in_darkness_wh, solar_available_per_m2_wh.
- `sizing`: min_panel_area_m2, min_battery_wh, recommended_panel_area_m2,
  recommended_battery_wh, limiting_factor.
- `panel_recommendation` only for auto; `feasible`; `warnings`.
- `timeline`: times, solar_input_w, load_w, battery_soc_pct. Include meta.

Minimum panel area meets total energy demand including storage losses. Battery is
largest cumulative energy deficit divided by DoD. Recommended sizes multiply minima
by (1 + margin_pct/100). Limiting factor: total_energy, darkness_survival or peak_power.
Feasible is false if never lit or no panel <=100 m² works. Simulate recommended
sizes starting at 100% SOC.

Warnings: LONG_DARKNESS (>48 h, include start time), NEVER_ILLUMINATED (infeasible),
LOW_SUN (mean lit elevation <2°), BATTERY_DEPLETED (SOC reaches zero with recommended
sizes, custom profiles only per supplied spec), PEAK_EXCEEDS_SUPPLY (peak demand
exceeds panel output plus battery discharge). Warnings have code/message and
applicable time.

## POST /v1/power/windows

Input: required `location`, `search` TimeRange, `equipment`; optional criteria and
assumptions use defaults.

Equipment:

- Optional `name`, echoed back.
- Required `panel` with positive `area_m2`, and `required_power_w`.
- `survival_w` default 0; `battery_wh` default 0 (no storage).
- Optional `max_darkness_hours`, derived as battery_wh × DoD / survival_w if omitted.
- `min_sun_elevation_deg` default 0; applies while illuminated.
- `needs_earth_visibility` default false.

Criteria: `min_window_hours` default 24; `min_power_margin_pct` default 0;
`max_results` default 10, range 1–100.

Usable steps require all: solar output meets operating demand or battery covers the
shortfall; darkness stretch <=limit; elevation >=minimum while lit; Earth visible
if requested. Windows are maximal consecutive usable runs meeting min duration.
Average power margin is also requested, with exact application needing clarification.

Response:

- `equipment`: name and panel_mode_used; enriched location; search.
- `summary`: usable_pct, window_count, total_window_hours.
- Ranked `windows`: rank, start, end, duration_hours, score, mean_power_w,
  min_power_w, power_margin_pct, illumination_pct, longest_darkness_hours,
  min_battery_soc_pct.
- `unsuitable_periods`: start, end, reasons.
- `panel_recommendation` for auto; `timeline`: times, power_w, battery_soc_pct,
  usable. Include meta.

Score = .4 × min(margin_pct/100,1)
+ .3 × (1 − longest_darkness/max_darkness_hours)
+ .3 × min(duration_hours/168,1). Must lie in [0,1]; sort descending.
Reasons: insufficient_power, darkness_exceeds_limit, sun_below_min_elevation,
no_earth_visibility, window_too_short.

## Shared core and caching

1. Obtain Moon-centered Sun vector, transform to Moon ME and then local angles/range.
2. Look up LOLA horizon mask (1° azimuth bins), adjusted for sensor height.
3. Calculate solar-disk visible fraction.
4. Project irradiance onto requested surfaces.
5. Aggregate grid metrics or simulate load/storage.

Cache Moon-centered vectors per epoch and horizon masks per cell. Distinguish common
Moon-centered vectors from site-dependent local angles and topocentric vectors.
Horizon preprocessing, cache validity, projection boundaries and battery semantics
must be settled before claiming the v1 contract is implemented.
