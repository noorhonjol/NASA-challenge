# Judging review (2026-11-15)

A mock panel of two judges per criterion (Judge A assessed, Judge B critiqued and agreed a fix list),
plus two analysts checking the challenge objectives. Scores are their estimates **before** the fixes
below; maximum in brackets.

| Criterion | Judge A | Judge B | Main reasons |
|---|---|---|---|
| Impact (6) | 4.0 | 3.5 | Real planner question with Artemis III regions; but scoring let a hard failure rank as "best" (Earth never in view still scored 66.7), no export, equipment distance ignored |
| Creativity (7) | 4.5 | 4.5 | Joint time-and-place search with separate base / panel / antenna spots, street view with a real sky; but results were numbers, spots not connected in 3D, terrain lighting is fixed |
| Validity (3.5) | 2.5 | 2.5 | DE440 matches Horizons to ~1e-5°, Hayne 2017 constants correct; but panels and antenna sat at 0 m, so the nearest ground blocked the sky (0% Earth vs 16-27% in the Earth-link tool) |
| Relevance (4) | 3.5 | 3.0 | Power and DTE windows strong; but no chart of the Sun and Earth "relative to the horizon", no side-by-side site comparison, challenge never named |
| Presenting (4.5) | 2.5 | 2.5 | Strong visuals; but README was a developer log, results buried under the form, pin labels cluttered, no demo path |

**Challenge:** NASA Space Apps 2026 "Lunar Landing Site Navigator": *"create an intuitive tool or
application that lets mission planners, educators, and the public compare landing sites and dates
quickly, visualizing Sun and Earth positions relative to the horizon to assess power generation
potential and direct-to-Earth communication windows."* (Official page could not be fetched: TLS
error; text from the Sonoma State mirror. Paste the official Objectives / Considerations /
Resources here to re-check.)

## Applied

| Fix | Criteria | Where |
|---|---|---|
| Strict pass/fail per window ("meets every need" or what fails, in numbers); windows that meet every need rank first | Impact, Validity | `mission_search.py` (`window_scores`, `failure_reasons`, `pick_windows`), `MissionSearch.tsx` |
| Panels and antenna at an equipment height (default 2 m); heat stays on the ground | Validity | `mission_search.py` `cell_arrays` |
| Optional cable length: panels and antenna must be within reach of the base; distances shown | Impact, Validity | `separation_km`, `window_scores(reach)` |
| Horizon chart: real terrain skyline with the Sun and Earth tracks over the window | Relevance, Creativity | `GET /api/mission/sky`, `HorizonChart.tsx` |
| Compare sites side by side (PGDA sites, pins, all 9 Artemis III region centres) | Relevance, Impact | `MissionSearch.tsx` "Compare sites side by side" |
| Result first: verdict card in plain language, form folds away, score explained | Presenting, Impact | `MissionSearch.tsx` |
| Dashed lines on the Moon from the base to its panels and antenna, with km | Creativity, Presenting | `createLunarViewer.ts` `groundPath`, overlay `links` |
| Download CSV / JSON of the results | Impact | `MissionSearch.tsx` |
| One-click demo (Artemis III "de Gerlache Rim 2", 14 days in 60) and the challenge name in the panel | Presenting, Relevance | `App.tsx`, `MissionPlanner.tsx` |
| README front page: pitch, objectives table, 30-second demo, how to read results, data sources; stale passages fixed | Presenting, Relevance, Validity | `README.md` |
| Fewer pin labels at the pole view (names within 150 km), toolbar on one row | Presenting | `createLunarViewer.ts`, `index.css` |
| Globe drag: grab and spin the Moon on both axes, 1:1 with the pointer | Presenting | `orbitCamera.ts`, `orbitCameraMath.ts` `grabScale` |

## Not done yet (ranked)

1. Validate against published polar results (Mazarico et al. 2011 or PGDA illumination maps;
   Diviner temperatures) at 2 m and 10 m, and add the table to the README. Validity.
2. "Day in the life" playback of the best window in Sky & time (battery, temperature, Earth). Creativity.
3. Time-dependent shading: recolour the score surface by "sunlit now" as Sky & time plays (do not fake
   cast shadows with slope shading). Creativity.
4. One skyline engine everywhere (planner vs Earth-link/Sun tools differ by ~2-3 points at 2 m). Validity.
5. Shareable link that re-runs a search from the URL. Impact.
6. A hosted demo; a 30-second video following the README script; team names in the README. Presenting.
