# Lunar power planning — requirements and preliminary analysis

Status: feature requirements and preliminary analysis. Automatic local LOLA elevation confirmed by user on 2026-11-15.
Date: 2026-11-15.

This document describes the intended feature. It does not establish that existing
code satisfies the requirements. Earlier planning code remains on the current
branch; implementation should be evaluated against these requirements.

## 1. Problem and intended outcome

Users need to compare lunar locations and dates without manually interpreting
separate Sun/Earth position queries. They should be able to estimate solar power,
compare mission energy demand against generation and storage, and identify
potential operating periods for specified equipment.

The product supports preliminary surface-operation screening for planners,
educators and the public. It does not determine launch dates, trajectories,
propulsion energy, or certify that a mission can survive or communicate.

## 2. Proposed first-release scope

1. Analyze one lunar point from a selected start time over a mission duration.
2. Compare multiple points or a rectangular coordinate grid over a start/end range.
3. Search a date range for solar-powered operating intervals matching equipment
   specifications and optional Earth visibility constraints.
4. Display results in a large modal opened from the persistent navigation bar.

Existing globe exploration and single-point Sun/Earth queries must remain usable.
The first release uses the existing ephemeris service. Terrain-aware visibility is
separate work and must not be implied by the presence of a terrain globe.

## 3. User flows

### A. Estimate power for a mission

- Select a lunar point on the globe or enter coordinates in the planner.
- Enter the arrival/start date, mission duration, sampling interval and equipment.
- Run the analysis and inspect generation, energy demand and storage estimates.
- Inspect dates with insufficient generation and the model limitations.

A point and an instant can determine incident radiation and instantaneous power,
but cannot determine trip energy or battery requirements. Duration and load are
required for those outputs. The UI must make this distinction explicit.

### B. Compare locations and dates

- Choose explicit locations or define a rectangular grid.
- Enter a start/end range and use the same equipment configuration for comparison.
- View a summary per sampled point, then select a point for its detailed timeline.
- Change location, equipment or dates and run another analysis.

### C. Find when equipment can operate

- Enter a lunar point, search interval, equipment and minimum operating duration.
- Optionally require direct Earth visibility above a minimum elevation.
- Return qualifying intervals, or explain that none satisfy the selected criteria.
- Show that these are surface operating intervals, not recommended launch dates.

## 4. Functional requirements

### Inputs

| Area | Required information |
|---|---|
| Location | Latitude and east-positive longitude; surface elevation automatically resolved from local LOLA |
| Multiple sites | Explicit points; optionally include existing named locations |
| Grid | South/north/west/east bounds and row/column counts |
| Schedule | Explicit UTC start and duration, or start/end dates; sampling interval |
| Demand | Continuous electrical load in watts, including user-supplied thermal and communication loads |
| Solar array | Area, conversion efficiency, system efficiency and horizontal or ideal Sun-tracking orientation |
| Storage | Nameplate capacity and usable fraction |
| Communication screening | Whether Earth visibility is required and its minimum elevation threshold |
| Window search | Minimum qualifying interval duration |

Resolve elevation automatically for every point from the installed local LOLA data.
Use the original product 81 native raster within its coverage and global LOLA
elsewhere. Do not provide a manual planner elevation field. Grid points must each
receive their own sampled height. Do not substitute blended or quantized display
terrain. Report sampled height, source, resolution and reference datum in results;
missing or invalid local terrain must produce an explicit error, never zero height.

### Outputs

- Sun and Earth azimuth/elevation at every sampled point and time.
- Direct normal and panel-plane irradiance in W/m².
- Generated electrical power, demand and net power in watts.
- Required panel area at each epoch; use an explicit unavailable/no-sunlight state
  when no finite area could meet the load.
- Integrated generated energy, consumed energy and energy balance in Wh.
- Minimum initial usable energy, minimum usable storage and equivalent nameplate
  capacity under the documented storage model.
- Whether supplied storage meets the modeled demand when initially full.
- Qualifying solar-powered operating intervals and their durations.
- Per-point comparison summaries and a selectable detailed time series.
- Ephemeris provenance, equipment inputs, model assumptions and sampling resolution.
- Sampled LOLA height and dataset provenance for every point.

Do not treat Earth visibility alone as proof of a working radio link. Do not treat
a positive total energy balance as proof that a battery can bridge every deficit.

### Validation and request handling

- Require finite inputs and physically valid coordinate/efficiency ranges.
- Reject missing timezones, reversed ranges and unsupported ephemeris dates.
- Include the exact end time, even when the last sampling interval is shorter.
- Validate grid ordering; explain how to split antimeridian-crossing areas.
- Bound point count, epoch count and total upstream work before starting requests.
- Proposed initial limit: 128 point/time combinations per request, ranges up to
  366 days, and sampling intervals from 0.25 to 168 hours. Revisit after latency tests.
- Report upstream failures without presenting missing samples as successful results.
- Support cancellation in the UI. Document that cancelling the browser request may
  not immediately stop server-side or upstream processing.
- Clear or explicitly mark results as outdated after inputs change.

## 5. Interface requirements

- Keep a persistent navigation bar with Globe explorer and Mission planner actions.
- Mission planner opens a large modal over the existing globe.
- Preserve the globe camera and selected location while opening and closing it.
- Close using a visible close button, Escape, or a backdrop click.
- Keep keyboard focus inside the modal while open and return it to the trigger
  after closing; provide an accessible dialog name.
- Preserve planner inputs and results when closing/reopening during the session.
- Make the modal responsive and internally scrollable on small screens.
- Use labeled fields, explicit UTC dates, visible units and readable validation.
- Present a comparison table, generation-versus-load chart, operating-window list
  and detailed sample table. Tables must provide equivalent access to chart values.
- Provide loading, cancellation, error, empty-result and unavailable-data states.
- Keep custom-coordinate planning available when saved-site loading fails.
- Keep calculations usable when WebGL is unavailable.

## 6. Preliminary calculation design

### Radiation and array power

Proposed screening model:

- Reference irradiance: 1361 W/m² at 1 AU, scaled by inverse-square Sun distance
  returned by the ephemeris service.
- Block direct solar generation when the Sun's center is at or below the modeled
  horizon. Use the airless local tangent plane in the first release.
- Horizontal array incidence factor: sine of solar elevation when above horizon.
- Ideal tracking array incidence factor: one when above horizon.
- Electrical power = panel-plane irradiance × area × panel efficiency × system
  efficiency. Define system efficiency as excluding panel conversion efficiency.

Reference already used by the project:
https://data.giss.nasa.gov/modelforce/solar.irradiance/.

This model excludes terrain shadows, eclipses, partial solar-disc visibility,
panel temperature/degradation, reflected light and detailed surface orientation.
These exclusions are particularly material near the lunar south pole.

### Energy and storage

Propose linear interpolation of generation between samples, integrated over actual
interval lengths. Demand is constant in the first release. Include interpolated
net-power zero crossings when finding extrema of cumulative energy.

Track cumulative generated energy minus consumed energy. The deepest cumulative
deficit determines minimum initial usable energy when capacity is sufficient to
retain later surpluses. The maximum drop from an earlier cumulative maximum
determines minimum usable storage for an initially full battery. Convert usable
storage to nameplate capacity using the specified usable fraction.

Explicitly exclude battery charge/discharge losses and rate limits from this
initial ideal-storage model. Total generated energy alone is insufficient to size
storage because surplus can occur after a critical deficit or overflow capacity.

### Operating intervals

Propose a first release that searches for solar-powered operation without battery
support: generation must meet load and, when enabled, Earth elevation must exceed
the selected threshold. Require both endpoints of an included sampling interval to
qualify, merge adjacent intervals and filter by minimum duration.

This is a sampled approximation, not a guarantee between samples. Short events can
be missed, and boundaries have not been refined. Display sampling resolution beside
windows. Battery-supported operating windows require a separate chronological state
of charge simulation and are outside this first-release definition.

## 7. Architecture and feasibility analysis

Proposed API responsibilities:

| Endpoint | Purpose |
|---|---|
| POST /api/planning/power | Point, start date, mission duration and equipment → mission power screening |
| POST /api/planning/analysis | Points/grid, date range and equipment → comparable per-point results |
| POST /api/planning/windows | Point, range, equipment and duration threshold → qualifying intervals |

Keep the existing positions endpoint compatible. Share validation and calculation
logic across all planning routes. Separate ephemeris retrieval from deterministic
power/energy calculations so the latter can be tested without network access.

The current position service makes separate Sun and Earth requests per point/time.
Expanding to a grid multiplies latency and upstream load; 128 combinations could
mean 256 requests. Before selecting production limits, measure representative
requests and investigate a multi-epoch ephemeris adapter, caching and background
jobs. Respect upstream concurrency/rate guidance. A browser loading indicator does
not resolve a server or proxy timeout.

The first release need not persist analyses or add database migrations. Saved runs,
export and collaborative comparisons are future scope unless requested separately.

## 8. Risks and unresolved decisions

| Question or risk | Proposed first-release position |
|---|---|
| What does “power needed for travel” mean? | Surface electrical operations from arrival onward; propulsion/trajectory energy requires a separate model |
| How is demand known? | User supplies continuous total load; tool does not infer equipment consumption from location |
| Are tool specifications one total load or an equipment list? | Total load first; itemized load schedules can follow |
| Does “when good” include battery-supported operation? | Solar-powered windows first; battery adequacy reported independently |
| Is terrain obstruction required now? | Excluded and clearly disclosed; assess as a separate milestone |
| Are safe communication windows required? | Geometric Earth visibility only; radio/link budget excluded |
| How precise must event times be? | Sampled intervals first; no exact sunset/Earthset countdown until crossing refinement exists |
| Will large searches finish in an interactive request? | Measure upstream latency and deployment timeouts before finalizing limits |
| What happens to earlier implementation? | Leave untouched during requirements review; audit against the agreed scope before adapting it |

## 9. Acceptance criteria

1. A user opens the planner from the navbar as a modal, enters coordinates, date,
   duration and equipment, and receives unit-labeled power and energy results. The
   backend samples local LOLA elevation automatically; no manual height is required.
2. The same configuration can compare at least two sites or a 2×2 grid over an
   increasing date range, with a distinct summary and timeline for each point.
3. Window search applies the selected power, Earth visibility and duration criteria,
   and handles no qualifying intervals clearly.
4. Darkness yields zero direct solar generation and an explicit unavailable required
   panel area; it does not produce invalid numeric values.
5. Storage estimates correctly handle continuous darkness, continuous surplus,
   surplus followed by deficit and interpolated power/load crossings.
6. Invalid coordinates, dates, efficiencies and oversized requests are rejected
   before upstream queries; upstream failures are visible and retryable.
7. Closing/reopening preserves inputs/results and globe state; keyboard dismissal
   and focus restoration work.
8. Mobile layouts and keyboard-only use provide access to all inputs and results;
   charts have equivalent tabular data.
9. Results disclose terrain, eclipse, thermal, storage and link-budget limitations;
   no UI copy presents a screening result as mission certification.
10. Existing globe and positions behavior remains compatible.

## 10. Proposed delivery sequence after requirements review

1. Resolve scope questions and audit the earlier implementation against this document.
2. Confirm data availability, latency budget and calculation conventions.
3. Implement or adjust shared input models and deterministic calculation services.
4. Verify physics, storage and sampling edge cases using controlled ephemerides.
5. Implement or adjust bounded API integration and failure handling.
6. Implement or adjust the navbar-triggered modal and result visualizations.
7. Verify end-to-end representative scenarios, accessibility and responsive layouts.
8. Update the PR with agreed requirements, measured limitations and validation.

The original requirements-only draft preceded further implementation. The later
user request confirms automatic local LOLA sampling as the planner elevation policy.
