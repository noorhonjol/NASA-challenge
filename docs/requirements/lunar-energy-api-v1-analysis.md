# Lunar Energy API v1 — preliminary implementation analysis

Date: 2026-11-15. Status: review, not an implementation or a compliance claim.
Contract: [lunar-energy-api-v1.md](lunar-energy-api-v1.md).

## Assessment

This is a substantial new version, not a route rename. The existing API provides
terrain elevation and tangent-horizon screening. The requested version adds terrain
shadowing, partial solar-disk visibility, physical area grids, multiple panel modes,
auto optimization, richer battery simulation and a different public contract.
Do not expose approximations as terrain-aware v1 outputs.

## Verified repository baseline

| Area | Current state | Gap to v1 |
|---|---|---|
| Routing | /api/planning/{resources,analysis,power,windows}, /api/positions | Add four /v1 endpoints and versioned schemas; keep legacy routes until migration |
| Ephemerides | Live Horizons observer requests per point/time, Sun and Earth serialized | Batch/common vectors, verified provenance and frame transforms; no local SPICE adapter |
| DEM | Native product 81 5 m, 87–90°S; global 16 pixels/degree fallback | Gradients/normal, analysis grid pyramid, coverage rules and provenance per source |
| Observer | Automatic native/global LOLA elevation | Separate height above terrain from elevation; use both consistently |
| Horizon | Flat tangent horizon, body centers | Terrain ray tracing, curvature, reusable masks, height-aware lookup and disk fraction |
| Solar | Horizontal flux, ideal tracking, no obstruction | Terrain/custom/vertical projection and partial visibility |
| Region | Lists or lat/lon grid; 128 cell/epoch cap | Metric-resolution bbox/polygon/circle grids, masks, ranking and 2M work limit |
| Panel modes | Horizontal or ideal tracking | Fixed tilt and vertical tracking; 1,368 tilt/azimuth combinations at 5° steps |
| Loads/storage | Constant demand, ideal usable storage | Lit/survival/custom profiles, storage losses, chronological SOC, design margins |
| Windows | Solar-only windows, optional Earth elevation | Battery-supported continuous windows, failure reasons, margin and score |
| Errors/meta | FastAPI validation 422, upstream 502, terrain 503 | v1 error envelope/status mapping; request IDs, source identity and timing |
| UI | Navbar opens responsive modal; resource and equipment modes | Adopt new schemas and expose new terrain/panel/battery results |

The installed DEM is product 81, not the example `LDEM_80S_20M`. Current preparation
metadata records MOON_ME/DE421. The Horizons adapter discards solution metadata and
does not pin DE440. Never set `meta.ephemeris="DE440"` just to match an example.

## Definitions to resolve before implementation

The resolutions below are proposals, not changes accepted by the user.

### 1. Auto panel selection has conflicting rules

One rule prefers fixed modes only within tolerance; another forbids full tracking
whenever prefer_simple=true. What happens when no fixed panel is within tolerance?
Also, the example selects vertical tracking despite full tracking having a lower
required area. Under the specified energy-only objective, full tracking cannot
receive less irradiance than another ideal orientation on identical visibility.

Proposal: select the objective winner by default; optionally choose a fixed panel
within tolerance. If full tracking must always be forbidden with prefer_simple,
make that a separate explicit constraint and rank the remaining candidates. Define
tie-breaking and whether window ranking uses total retained duration before or
after max_results. Endpoint 4 comparison entries need a window-duration field,
rather than mission-only min_panel_area. Endpoints 1/2 do not request auto selection.

### 2. Battery power cannot be inferred from battery energy

Wh describes capacity. PEAK_EXCEEDS_SUPPLY and discharge-rate checks require maximum
battery discharge W or a C-rate, neither of which is supplied. peak_w alone also
lacks a peak duration for energy simulation.

Proposal: add optional max_charge_w/max_discharge_w and define peak duration or
restrict peak checks to an explicitly stated instantaneous envelope. Until then,
report that peak-rate feasibility is unavailable; do not invent a discharge limit.

### 3. Round-trip efficiency and SOC convention

Round-trip efficiency alone does not say how charge and discharge losses split.
SOC 100% start, DoD=.8, and depletion at 0% are ambiguous: physical battery SOC at
its usable floor would be 20%, while usable-energy SOC reaches zero.

Proposal: define eta_charge=eta_discharge=sqrt(round_trip_efficiency), track actual
stored Wh, and report usable SOC with 0% at the DoD floor. Explicitly specify the
basis of min_battery_wh (nameplate) and the loss accounting in panel sizing.
Starting full permits a one-off mission with net energy deficit, while the stated
minimum panel criterion requires net balance: retain net balance as the sizing
criterion and separately simulate start/end SOC and overflow.

### 4. Operating demand versus survival during windows

The usable-step definition requires operating power even in darkness, while survival_w
is described as the dark load. Charging a battery against survival demand and then
claiming it can power full operation would overstate usable windows.

Proposal: distinguish operating windows (required_power_w delivered throughout,
including darkness) from survival-only periods (survival_w, not usable operation).
Define whether failed-window intervals draw survival power, whether Earth/elevation
failures suspend operation, and whether battery recovers during those intervals.
Simulate the entire search chronologically; do not reset SOC to full for each window.

### 5. Zero-load/zero-storage and score edge cases

Derived max_darkness divides by survival_w; both survival and battery default to zero.
Score also divides by max_darkness, and negative margin can make a score negative.

Proposal: survival_w=0 means no survival-energy darkness limit, not 0/0. No-storage
operating windows still require contemporaneous power. Define scores using clamped
terms in [0,1], and continuity=1 when there is no darkness or no finite darkness cap.
Reject nonpositive required operating power to keep margin ratios well-defined.
Clarify where min_power_margin_pct filters windows; it is not in the usable-step list.

### 6. Custom load profiles

Define ascending unique timestamps, nonnegative finite samples, coverage, timezone,
interpolation (step-held or linear) and how survival overrides dark custom values.
The survival<=average validation is undefined when no average_w exists. peak_w's
default also references absent average_w for custom profiles.

Proposal: step-held loads with exact breakpoint integration; dark survival override
as specified. Derive peak from custom operating values when omitted. Define a custom
survival consistency rule explicitly instead of validating against a missing field.

### 7. Sampling and temporal boundaries

Define inclusion of exact end, whether samples describe instants or intervals,
short final intervals, illumination percentages, energy integration and transition
interpolation. The region example's 31 days at six-hour spacing is 124 intervals
but 125 endpoint-inclusive samples, not 124 samples.

Proposal: include start and exact end; use actual interval lengths for integration,
never count a sample as an extra full time interval. Preserve the specified sample-
share metrics but document the endpoint weighting distinction. Refine transitions
or report sampling uncertainty. Define two years (calendar years versus fixed days)
and the last supported instant: use 2036-01-01T00:00Z as an exclusive epoch bound.

### 8. Coverage, projection and resolution

Global LOLA exists alongside the polar DEM. Decide whether global fallback is allowed
for terrain horizons or whether insufficient analysis fidelity means OUT_OF_COVERAGE.
A horizon needs terrain beyond the requested point: missing neighboring coverage
cannot be treated as unobstructed. Region projection is only exemplified for south
polar terrain, though the coordinate domain includes the whole Moon.

Proposal: explicit analysis coverage and DEM resolution policy, distinct from globe
rendering coverage. Define south/north/global grid projections, cell anchoring,
antimeridian/pole handling, polygon interior rules and edge cells. Geometry uses
[lat,lon], not GeoJSON's standard order. Publish available analysis resolutions;
240 m is not currently a prepared native level. An aggregation pyramid is required
before resolution snapping can be meaningful and reproducible.

### 9. Horizon accuracy and sensor height

Horizon masks need curvature, ray range, terrain sampling, azimuth interpolation
and a convergence/error policy. A 1° azimuth cache alone does not specify how
sub-bin terrain affects a 0.53° disk. Height adjustments cannot generally be a single
angle subtraction: different ridges can become the horizon maximum at new heights.

Proposal: retain distance/elevation candidates per ray or recompute the envelope
for supported heights. Include DEM identity/version, location, height, ray geometry
and algorithm version in cache keys. State that disk fraction is an approximation
for a locally straight terrain horizon, unless integrating across the disk.
Earth visibility needs its own azimuth horizon lookup; specify body-center versus
partial Earth-disc visibility.

### 10. Irradiance and terrain normal definitions

The horizontal formula can be negative if a partly visible solar disk has a center
below the tangent plane. Slope/aspect sign and fixed panel references are unspecified.
"Flat on the ground" can mean tangent-horizontal or terrain-following; v1 exposes
both horizontal and terrain surfaces, so these must remain distinct.

Proposal: nonnegative projected irradiance; define normals in local east/north/up,
aspect as downslope azimuth clockwise from north and a convention for flat ground.
Fixed-horizontal uses local up; terrain uses the DEM normal; custom tilt uses the
local horizontal reference. Define that a solar-disk visibility fraction times a
center-vector projection is an approximation near the horizon. No negative power.

### 11. Metadata and error scope

Mixed-source grids cannot accurately report a single unqualified DEM name. Decide
whether meta also appears in errors and whether exact timing belongs only to success.

Proposal: retain the required meta fields, add a product list for mixed grids and
frame/horizon provenance. Apply v1 validation/error handlers only to /v1 routes,
so existing /api clients keep their current contract. Internal failures get a safe
message and request ID; server logs retain diagnostics.

## Ephemeris/frame feasibility

The current adapter requests observer coordinates; cache reuse requires a new vector
adapter. A Moon-centered body vector can be shared across cells, but observer-relative
vectors and local elevations cannot. Subtract each observer position before deriving
local angles; apply the same care to Earth, not just the Sun.

JPL documents DE440/441 use and lunar observer frame conventions in its
[Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html). NAIF documents the
DE440-specific ME frame and its DE421 alignment in the
[lunar frames tutorial](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/Tutorials/pdf/individual_docs/23_lunar-earth_pck-fk.pdf).
Implementation implication: select and verify compatible orientation/frame kernels
and DEM conventions; metadata must reflect the actual solution. If DE440 is strict,
a pinned local SPICE kernel set is a proposed option, pending setup and validation.

## Proposed implementation structure

- `energy_v1/schemas`: strict location/area/load/panel/time and response models.
- `energy_v1/ephemeris`: batched Moon-centered Sun/Earth vectors and verified frames.
- `energy_v1/terrain`: native LOLA sampling, normals, coverage, metric grid generation.
- `energy_v1/horizon`: offline preparation, height-aware caches, visibility fractions.
- `energy_v1/irradiance`: shared vector/normal projection and solar-disk model.
- `energy_v1/aggregate`: grid metrics, units, masks, statistics, stable ranking.
- `energy_v1/battery`: chronological load, charge/discharge, losses and SOC.
- `energy_v1/panels`: vectorized fixed-tilt optimization and auto policy.
- `energy_v1/mission` and `windows`: sizing, feasibility, warnings and reasons.
- Versioned routers with timing/provenance and v1-specific exception translation.

This is proposed organization, not a requirement to scatter simple functions across
many files. Reuse existing elevation access without reusing the display blending.

## Scale and delivery dependencies

Two million cell/time combinations cannot use the current two serialized upstream
calls per combination. A single two-year point search at 15-minute spacing also
exceeds the existing 128 cap. Batch ephemerides and prepare horizon caches before
raising the limit. Cell/time count alone is not a memory or compute budget: horizon
rays, fixed-tilt candidates and requested time-series JSON add independent costs.
Use tiled processing, bounded caches and benchmark request/response memory and proxy
timeouts. The supplied v1 is synchronous; if jobs are required, that is a contract
extension to agree on, not a silent replacement of the response.

## Delivery sequence and acceptance gates

1. Settle the definitions above; freeze schemas, errors, interval semantics and
   physical reference conventions. Keep existing endpoints operational.
2. Validate installed DEM datum/frame and source coverage. Prepare terrain normals
   and horizon caches; validate known synthetic ridges and observation heights.
3. Build a batched, provenance-aware ephemeris adapter; cross-check angles/ranges
   against independently requested observer results at representative locations.
4. Implement /v1/solar/point and validate incidence, full/partial/zero visibility,
   longitude normalization, height, custom panel and all error envelopes.
5. Implement bbox/polygon/circle grids and region metrics, masks, ranking and exact
   work limits. Measure small/medium/maximum workloads before exposing 2M support.
6. Implement battery/load simulation, mission sizing and panel optimization with
   conservation, DoD, efficiency, rate-limit and no-sun tests.
7. Implement battery-supported windows, chronological SOC, darkness/elevation/Earth
   gates, margin filters, scores, truncation and unsuitable-period reasons.
8. Connect the existing navbar-triggered modal to v1; preserve resource-only point/
   region analysis and separate equipment-driven mission/window inputs.
9. Run schema/physics/performance/accessibility regressions; publish actual data
   provenance and residual numerical limitations. Do not claim accuracy from tests
   that only repeat implementation formulas.

No runtime code changed as part of this preliminary review.
