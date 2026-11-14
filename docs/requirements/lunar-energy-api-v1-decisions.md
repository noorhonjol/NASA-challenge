# Lunar Energy v1 — implementation decisions

The previous screening implementation has been removed and rebuilt under `/v1`.
The [user specification](lunar-energy-api-v1.md) is the contract; this file records
explicit conventions for the ambiguities identified in the preliminary review.

1. **Time:** UTC conversion required, epochs [2020-01-01, 2036-01-01), two-year
   ranges at most 731 days, endpoint-inclusive samples and an exact short last interval.
2. **Panel preference:** optimize every fixed tilt/azimuth pair by the endpoint
   criterion. With `prefer_simple`, full tracking is excluded. A fixed mode wins
   within tolerance of the remaining best; otherwise vertical tracking can win.
3. **Storage losses:** charge/discharge efficiencies both sqrt(round-trip efficiency).
   Use chronological stored energy with overflow and charge-rate clipping. SOC means
   usable SOC; 0 is the DoD floor. Nameplate Wh is usable capacity divided by DoD.
4. **Peak limits:** additional optional `assumptions.max_charge_w/max_discharge_w`.
   Missing discharge power emits PEAK_RATE_UNCHECKED. No fabricated rate or peak
   energy duration can be inferred from battery Wh.
5. **Custom loads:** UTC, increasing unique timestamps, nonnegative finite power,
   full mission coverage; step-held changes inserted into the analysis epochs.
   Survival overrides the custom operating value in darkness. Omitted peak is the
   maximum custom operating power; survival cannot exceed that maximum.
6. **Windows:** operation requires full required power during darkness as well as
   sunlight. Ineligible intervals use survival power. SOC never resets. No survival
   demand implies no derived survival-darkness cap; no-storage operation still needs
   immediate generation. The zero power-margin criterion is neutral; positive values
   filter by average solar-power margin. Scores are clamped. Summaries precede top-N.
7. **Terrain:** source product 81, not the example 20 m DEM. Native gradients and
   near-field horizons, 50 m polar far-field, global outside coverage. Horizon
   preprocessing is lazy and persisted; its version includes observer height.
   Rays use curvature and extend 500 km; missing terrain or insufficient extent
   returns OUT_OF_COVERAGE. Partial disk visibility assumes a locally straight
   horizon; incidence uses the solar center. All projected irradiances are >=0.
8. **Resolution:** advertised levels are analysis sampling spacings, snapped upward;
   source resolution remains distinct. Global minimum spacing is 1920 m. Projected
   grids have stable meter-based origin anchoring. Circle radius is geodesic; polygon
   vertices follow the specified [lat,lon] order. Outside-shape cells are null.
9. **Errors/provenance:** v1 route-scoped handling preserves older explorer APIs.
   Success and error responses include request ID metadata and X-Request-ID; only
   successful results claim a DEM/ephemeris calculation. Kernels are pinned and
   SHA-256 checked. DE440 ME421-aligned orientation is explicitly identified.
10. **Performance:** two million cell/epoch samples is a preflight work cap, not an
    interactive latency guarantee. Use prepared horizon caches for large searches.
    Maximum-sized workloads have not been validated for production response time.

Remaining model limitations: sampled ridges and transition times, straight-horizon
partial disk approximation, fixed solar angular diameter, no eclipse/secondary light,
no thermal or link-budget simulation. These limitations are returned with each result.
