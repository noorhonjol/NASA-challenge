"""Panel optimization and chronological electrical/storage calculations."""

import math
import numpy as np
from .solar import series, flux, integrate


def intervals(times):
    return np.array([(b - a).total_seconds() / 3600 for a, b in zip(times, times[1:])])


def runs(flags, times):
    result = []
    start = None
    for i, flag in enumerate([*flags, False]):
        if flag and start is None:
            start = i
        if not flag and start is not None:
            result.append((start, i, (times[i] - times[start]).total_seconds() / 3600))
            start = None
    return result


def battery_segments(generation, load, times, a):
    # Integrate net power exactly under linear solar interpolation and held interval load.
    eta = math.sqrt(a.battery_efficiency)
    segments = []
    for i, hours in enumerate(intervals(times)):
        left, right = generation[i] - load[i], generation[i + 1] - load[i]
        cuts = [0.0, 1.0]
        if left != right:
            for level in [
                0.0,
                *([a.max_charge_w] if a.max_charge_w is not None else []),
            ]:
                crossing = (level - left) / (right - left)
                if 0 < crossing < 1:
                    cuts.append(crossing)
        cuts = sorted(set(cuts))
        pieces = []
        for low, high in zip(cuts, cuts[1:]):
            power = (left + (right - left) * low + left + (right - left) * high) / 2
            if power >= 0:
                power = (
                    min(power, a.max_charge_w) if a.max_charge_w is not None else power
                )
                pieces.append((power * hours * (high - low) * eta, False))
            else:
                rate_fail = (
                    a.max_discharge_w is not None
                    and -min(left + (right - left) * low, left + (right - left) * high)
                    > a.max_discharge_w
                )
                pieces.append((power * hours * (high - low) / eta, rate_fail))
        segments.append(pieces)
    return segments


def storage_requirement(segments):
    cumulative = peak = required = 0.0
    for pieces in segments:
        for delta, _ in pieces:
            cumulative += delta
            peak = max(peak, cumulative)
            required = max(required, peak - cumulative)
    return required, cumulative


def simulate(generation, load, times, capacity, a):
    usable = capacity * a.battery_dod
    stored = usable
    soc = [100.0 if usable else 0.0]
    supply = []
    for pieces in battery_segments(generation, load, times, a):
        works = True
        for delta, rate_fail in pieces:
            if stored + delta < -1e-7 or rate_fail:
                works = False
            stored = min(usable, max(0.0, stored + delta))
        supply.append(works)
        soc.append(100 * stored / usable if usable else 0.0)
    return np.array(soc), np.array(supply)


def candidate_modes(s, panel):
    if panel.mode != "auto":
        return [(panel.mode, panel.tilt_deg, panel.azimuth_deg)]
    return [
        ("full_tracking", None, None),
        ("vertical_tracking", None, None),
        ("fixed_horizontal", None, None),
    ] + [
        ("fixed_tilt", tilt, az) for tilt in range(0, 91, 5) for az in range(0, 360, 5)
    ]


def choose(comparison, a, criterion):
    minimize = criterion == "min_panel_area"

    def value(c):
        return (
            c[criterion]
            if c[criterion] is not None
            else (math.inf if minimize else -math.inf)
        )

    candidates = comparison
    # prefer_simple excludes full tracking per the explicit contract rule.
    if a.prefer_simple:
        candidates = [c for c in candidates if c["mode"] != "full_tracking"]
    best = (min if minimize else max)(candidates, key=value)
    if a.prefer_simple:
        fixed = [
            c for c in candidates if c["mode"] in ("fixed_tilt", "fixed_horizontal")
        ]
        if fixed:
            simple = (min if minimize else max)(fixed, key=value)
            threshold = (
                value(best) * (1 + a.simplicity_tolerance_pct / 100)
                if minimize
                else value(best) * (1 - a.simplicity_tolerance_pct / 100)
            )
            if value(simple) <= threshold if minimize else value(simple) >= threshold:
                best = simple
    return best


def recommend(best, comparison, criterion):
    fixed = [c for c in comparison if c["mode"] == "fixed_tilt"]
    if fixed:
        key = lambda c: (
            c[criterion]
            if c[criterion] is not None
            else (math.inf if criterion == "min_panel_area" else -math.inf)
        )
        winner = (min if criterion == "min_panel_area" else max)(fixed, key=key)
        comparison = [c for c in comparison if c["mode"] != "fixed_tilt"] + [winner]
    comparison = [
        {k: v for k, v in c.items() if k != "min_panel_area"} for c in comparison
    ]
    return {
        "selected_mode": best["mode"],
        "selected_tilt_deg": best.get("tilt_deg"),
        "selected_azimuth_deg": best.get("azimuth_deg"),
        "criterion": criterion,
        "comparison": comparison,
    }


def mode_entry(mode, tilt, az):
    return {
        "mode": mode,
        **({"tilt_deg": tilt, "azimuth_deg": az} if mode == "fixed_tilt" else {}),
    }


def mission(request):
    times = request.period().times()
    if request.load.custom:
        times = sorted(
            set(
                times
                + [t for t in request.load.custom.times if times[0] < t < times[-1]]
            )
        )
    s = series(request.location, times)
    lit = s["visible_fraction"] > 0
    load = np.full(len(times), request.load.average_w or 0.0)
    if request.load.custom:
        indices = (
            np.searchsorted(
                np.array([t.timestamp() for t in request.load.custom.times]),
                [t.timestamp() for t in times],
                side="right",
            )
            - 1
        )
        load = np.array(request.load.custom.power_w)[indices]
    load = np.where(lit, load, request.load.survival_w)
    a = request.assumptions
    conversion = request.panel.efficiency * (1 - request.panel.degradation_pct / 100)
    comparison = []
    budgets = []
    for mode, tilt, az in candidate_modes(s, request.panel):
        raw = flux(s, mode, tilt, az)
        electrical = raw * conversion

        def balance(area):
            if a.max_charge_w is not None:
                return storage_requirement(
                    battery_segments(electrical * area, load, times, a)
                )[1]
            left = electrical[:-1] * area - load[:-1]
            right = electrical[1:] * area - load[:-1]
            dt = intervals(times)
            positive = (left >= 0) & (right >= 0)
            negative = (left <= 0) & (right <= 0)
            cross = ~(positive | negative)
            charge = np.where(positive, (left + right) * dt / 2, 0.0)
            discharge = np.where(negative, -(left + right) * dt / 2, 0.0)
            denom = np.where(cross, np.abs(right - left), 1.0)
            charge += np.where(
                cross, np.maximum(left, right) ** 2 * dt / (2 * denom), 0.0
            )
            discharge += np.where(
                cross, np.minimum(left, right) ** 2 * dt / (2 * denom), 0.0
            )
            return float(
                charge.sum() * math.sqrt(a.battery_efficiency)
                - discharge.sum() / math.sqrt(a.battery_efficiency)
            )

        if integrate(raw, times) <= 0 or balance(100) < -1e-7:
            area = None
        else:
            low, high = 0.0, 100.0
            for _ in range(48):
                mid = (low + high) / 2
                if balance(mid) >= 0:
                    high = mid
                else:
                    low = mid
            area = high
        comparison.append(
            {
                **mode_entry(mode, tilt, az),
                "energy_per_m2_wh": integrate(raw, times),
                "min_panel_area_m2": area,
                "min_panel_area": area,
            }
        )
        budgets.append((raw, electrical, area))
    best = choose(comparison, a, "min_panel_area")
    index = comparison.index(best)
    raw, electrical, area = budgets[index]
    feasible = area is not None and lit.any()
    panel_area = area if area is not None else 100.0
    required, _ = storage_requirement(
        battery_segments(electrical * panel_area, load, times, a)
    )
    battery = required / a.battery_dod
    factor = 1 + a.margin_pct / 100
    recommended_area = panel_area * factor
    recommended_battery = battery * factor
    generation = electrical * recommended_area
    soc, supply = simulate(generation, load, times, recommended_battery, a)
    dark = runs(~lit[:-1], times)
    longest = max(dark, key=lambda r: r[2], default=None)
    warnings = []
    for start, end, hours in dark:
        if hours > 48:
            warnings.append(
                {
                    "code": "LONG_DARKNESS",
                    "message": f"{hours:g} h darkness",
                    "time": times[start].isoformat(),
                }
            )
    if not lit.any():
        warnings.append(
            {"code": "NEVER_ILLUMINATED", "message": "No visible solar disk in mission"}
        )
    if lit.any() and s["sun_elevation"][lit].mean() < 2:
        warnings.append(
            {
                "code": "LOW_SUN",
                "message": "Mean illuminated Sun elevation below 2 degrees",
            }
        )
    if request.load.profile == "custom" and not supply.all():
        warnings.append(
            {
                "code": "BATTERY_DEPLETED",
                "message": "Recommended sizes cannot maintain the custom load",
            }
        )
    if (
        a.max_discharge_w is not None
        and request.load.peak_w > generation.max() + a.max_discharge_w
    ):
        warnings.append(
            {
                "code": "PEAK_EXCEEDS_SUPPLY",
                "message": "Peak load exceeds array and specified battery discharge limit",
            }
        )
    if a.max_discharge_w is None:
        warnings.append(
            {
                "code": "PEAK_RATE_UNCHECKED",
                "message": "Battery Wh does not specify discharge W; supply max_discharge_w for a peak-rate check",
            }
        )
    if a.max_discharge_w is not None and (
        not supply.all() or any(w["code"] == "PEAK_EXCEEDS_SUPPLY" for w in warnings)
    ):
        feasible = False
    result = {
        "location": s["location"],
        "period": {
            "start": times[0].isoformat(),
            "end": times[-1].isoformat(),
            "duration_hours": request.duration_hours,
        },
        "solar_conditions": {
            "illumination_pct": float(lit.mean() * 100),
            "longest_darkness_hours": longest[2] if longest else 0.0,
            "longest_darkness_start": (
                times[longest[0]].isoformat() if longest else None
            ),
            "mean_irradiance_w_m2": integrate(raw, times) / request.duration_hours,
        },
        "energy": {
            "load_total_wh": float(np.dot(load[:-1], intervals(times))),
            "load_in_darkness_wh": float(
                np.dot(np.where(lit[:-1], 0, load[:-1]), intervals(times))
            ),
            "solar_available_per_m2_wh": integrate(raw, times),
        },
        "sizing": {
            "min_panel_area_m2": area,
            "min_battery_wh": battery if feasible else None,
            "recommended_panel_area_m2": recommended_area if feasible else None,
            "recommended_battery_wh": recommended_battery if feasible else None,
            "limiting_factor": (
                "peak_power"
                if any(w["code"] == "PEAK_EXCEEDS_SUPPLY" for w in warnings)
                else "darkness_survival" if required > 0 else "total_energy"
            ),
        },
        "feasible": bool(feasible),
        "warnings": warnings,
        "timeline": {
            "times": [t.isoformat() for t in times],
            "solar_input_w": generation.tolist() if feasible else [0.0] * len(times),
            "load_w": load.tolist(),
            "battery_soc_pct": soc.tolist() if feasible else [0.0] * len(times),
        },
        "_products": [s["product"]],
    }
    if request.panel.mode == "auto":
        result["panel_recommendation"] = recommend(best, comparison, "min_panel_area")
    return result


def evaluate_windows(s, request, raw):
    eq, a = request.equipment, request.assumptions
    times = s["times"]
    dt = intervals(times)
    lit = s["visible_fraction"] > 0
    generation = (
        raw
        * eq.panel.area_m2
        * eq.panel.efficiency
        * (1 - eq.panel.degradation_pct / 100)
    )
    # Operating windows require the operating load even in darkness. Outside an
    # eligible period only survival is drawn; SOC never resets at window boundaries.
    cap = eq.battery_wh * a.battery_dod
    stored = cap
    soc = [100.0 if cap else 0.0]
    flags = []
    reasons = []
    dark = 0.0
    darkness_limit = eq.max_darkness_hours
    if darkness_limit is None:
        darkness_limit = cap / eq.survival_w if eq.survival_w else math.inf
    for i, hours in enumerate(dt):
        dark = dark + hours if not lit[i] else 0.0
        why = []
        if dark > darkness_limit:
            why.append("darkness_exceeds_limit")
        if lit[i] and s["sun_elevation"][i] < eq.min_sun_elevation_deg:
            why.append("sun_below_min_elevation")
        if eq.needs_earth_visibility and not (
            s["earth_visible"][i] and s["earth_visible"][i + 1]
        ):
            why.append("no_earth_visibility")
        operating = not why

        # Atomic interval: test deliverability first, then fall back to survival if unavailable.
        def advance(load):
            energy = stored
            works = True
            seg = battery_segments(
                generation[i : i + 2], np.array([load, load]), times[i : i + 2], a
            )[0]
            for delta, rate_fail in seg:
                if energy + delta < -1e-7 or rate_fail:
                    works = False
                energy = min(cap, max(0.0, energy + delta))
            return energy, works

        after, works = advance(eq.required_power_w)
        if not works:
            why.append("insufficient_power")
            operating = False
        stored = after if operating else advance(eq.survival_w)[0]
        flags.append(operating)
        reasons.append(why)
        soc.append(100 * stored / cap if cap else 0.0)
    candidates = []
    for start, end, hours in runs(flags, times):
        mean = integrate(generation[start : end + 1], times[start : end + 1]) / hours
        margin = (mean / eq.required_power_w - 1) * 100
        if hours < request.criteria.min_window_hours or (
            request.criteria.min_power_margin_pct > 0
            and margin < request.criteria.min_power_margin_pct
        ):
            code = (
                "window_too_short"
                if hours < request.criteria.min_window_hours
                else "insufficient_power"
            )
            for i in range(start, end):
                flags[i] = False
                reasons[i].append(code)
            continue
        dark_runs = runs(~lit[start:end], times[start : end + 1])
        longest = max([r[2] for r in dark_runs], default=0.0)
        continuity = (
            1.0
            if math.isinf(darkness_limit) or longest == 0
            else max(0.0, 1 - longest / darkness_limit) if darkness_limit else 0.0
        )
        score = (
            0.4 * np.clip(margin / 100, 0, 1)
            + 0.3 * continuity
            + 0.3 * min(hours / 168, 1)
        )
        candidates.append(
            {
                "start": times[start].isoformat(),
                "end": times[end].isoformat(),
                "duration_hours": hours,
                "score": float(score),
                "mean_power_w": mean,
                "min_power_w": float(generation[start : end + 1].min()),
                "power_margin_pct": margin,
                "illumination_pct": float(lit[start:end].mean() * 100),
                "longest_darkness_hours": longest,
                "min_battery_soc_pct": min(soc[start : end + 1]),
            }
        )
    unsuitable = []
    for start, end, hours in runs([not f for f in flags], times):
        unsuitable.append(
            {
                "start": times[start].isoformat(),
                "end": times[end].isoformat(),
                "reasons": sorted(
                    set(code for why in reasons[start:end] for code in why)
                ),
            }
        )
    return candidates, unsuitable, generation, soc, flags


def windows(request):
    times = request.search.times()
    s = series(request.location, times)
    comparison = []
    evaluations = []
    for mode, tilt, az in candidate_modes(s, request.equipment.panel):
        raw = flux(s, mode, tilt, az)
        evaluation = evaluate_windows(s, request, raw)
        evaluations.append(evaluation)
        comparison.append(
            {
                **mode_entry(mode, tilt, az),
                "energy_per_m2_wh": integrate(raw, times),
                "max_window_hours": sum(w["duration_hours"] for w in evaluation[0]),
            }
        )
    best = choose(comparison, request.assumptions, "max_window_hours")
    candidates, unsuitable, generation, soc, flags = evaluations[comparison.index(best)]
    total = sum(w["duration_hours"] for w in candidates)
    candidates.sort(key=lambda w: (-w["score"], w["start"]))
    top = [
        {"rank": i + 1, **w}
        for i, w in enumerate(candidates[: request.criteria.max_results])
    ]
    result = {
        "equipment": {"name": request.equipment.name, "panel_mode_used": best["mode"]},
        "location": s["location"],
        "search": request.search.model_dump(mode="json"),
        "summary": {
            "usable_pct": float(
                np.dot(flags, intervals(times)) / sum(intervals(times)) * 100
            ),
            "window_count": len(candidates),
            "total_window_hours": total,
        },
        "windows": top,
        "unsuitable_periods": unsuitable,
        "timeline": {
            "times": [t.isoformat() for t in times],
            "power_w": generation.tolist(),
            "battery_soc_pct": soc,
            "usable": [*flags, flags[-1] if flags else False],
        },
        "_products": [s["product"]],
    }
    if request.equipment.panel.mode == "auto":
        result["panel_recommendation"] = recommend(best, comparison, "max_window_hours")
    return result
