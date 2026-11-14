import { useEffect, useRef, useState } from "react";
import { fetchEnergy, type EnergyTask, type EnergyData } from "../api/energy";

const title: Record<EnergyTask, string> = {
  point: "Point solar conditions",
  region: "Region solar analysis",
  mission: "Mission panel & battery sizing",
  windows: "Equipment operating windows",
};
const label = (key: string) => key.replaceAll("_", " ");
const format = (value: unknown) =>
  typeof value === "number"
    ? value.toLocaleString(undefined, { maximumFractionDigits: 3 })
    : value === null
      ? "Unavailable"
      : String(value);

export function EnergyPlanner({
  lat,
  lon,
  at,
  onClose,
  siteName,
}: {
  lat: number;
  lon: number;
  at: string;
  onClose: () => void;
  siteName?: string;
}) {
  const [task, setTask] = useState<EnergyTask>("point");
  const [mode, setMode] = useState("auto");
  const [area, setArea] = useState("bbox");
  const [profile, setProfile] = useState("constant");
  const [result, setResult] = useState<{
    task: EnergyTask;
    data: EnergyData;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const [initialAt] = useState(() =>
    Number.isFinite(Date.parse(at))
      ? at
      : new Date().toISOString().slice(0, 16),
  );
  useEffect(() => () => controller.current?.abort(), []);
  const numeric = (
    name: string,
    text: string,
    value: number,
    min?: number,
    max?: number,
  ) => (
    <label key={name}>
      {text}
      <input
        name={name}
        type="number"
        required
        defaultValue={value}
        min={min}
        max={max}
        step="any"
      />
    </label>
  );
  const clear = () => {
    controller.current?.abort();
    setBusy(false);
    setError("");
    setResult(null);
  };
  async function submit(form: HTMLFormElement) {
    const f = new FormData(form);
    const num = (key: string) => Number(f.get(key));
    const text = (key: string) => String(f.get(key));
    const rawStart = Date.parse(`${text("start")}Z`);
    if (!Number.isFinite(rawStart)) {
      setError("Choose a valid UTC start date.");
      return;
    }
    const start = new Date(rawStart).toISOString();
    const location = {
      lat: num("lat"),
      lon: num("lon"),
      height_m: num("height"),
    };
    const panel = {
      mode,
      efficiency: num("efficiency") / 100,
      degradation_pct: num("degradation"),
      ...(mode === "fixed_tilt"
        ? { tilt_deg: num("tilt"), azimuth_deg: num("azimuth") }
        : {}),
      ...(task === "windows" ? { area_m2: num("panel_area") } : {}),
    };
    const assumptions = {
      battery_dod: num("dod") / 100,
      battery_efficiency: num("battery_efficiency") / 100,
      margin_pct: num("margin"),
      prefer_simple: f.has("simple"),
      simplicity_tolerance_pct: num("tolerance"),
      ...(text("discharge") !== "null" && text("discharge") !== ""
        ? { max_discharge_w: num("discharge") }
        : {}),
    };
    const rawEnd = Date.parse(`${text("end")}Z`);
    if (
      (task === "region" || task === "windows") &&
      (!Number.isFinite(rawEnd) || rawEnd <= rawStart)
    ) {
      setError("End must follow start.");
      return;
    }
    const period = {
      start,
      end:
        task === "region" || task === "windows"
          ? new Date(rawEnd).toISOString()
          : start,
      step_hours: num("step"),
    };
    let payload: object;
    try {
      if (task === "point")
        payload = {
          ...location,
          time: start,
          ...(f.has("custom_panel")
            ? {
                panel_tilt_deg: num("point_tilt"),
                panel_azimuth_deg: num("point_azimuth"),
              }
            : {}),
        };
      else if (task === "region")
        payload = {
          area:
            area === "bbox"
              ? {
                  type: area,
                  min_lat: num("south"),
                  max_lat: num("north"),
                  min_lon: num("west"),
                  max_lon: num("east"),
                }
              : area === "circle"
                ? { type: area, center: location, radius_m: num("radius") }
                : { type: area, coordinates: JSON.parse(text("polygon")) },
          resolution_m: num("resolution"),
          height_m: location.height_m,
          period,
          panel_mode: text("surface"),
          include_timeseries: f.has("series"),
        };
      else if (task === "mission")
        payload = {
          location,
          start,
          duration_hours: num("duration"),
          step_hours: num("step"),
          panel,
          assumptions,
          load: {
            profile,
            survival_w: num("survival"),
            ...(profile === "constant"
              ? { average_w: num("load"), peak_w: num("peak") }
              : { custom: JSON.parse(text("custom_load")) }),
          },
        };
      else
        payload = {
          location,
          search: period,
          assumptions,
          equipment: {
            name: text("name"),
            panel,
            required_power_w: num("load"),
            survival_w: num("survival"),
            battery_wh: num("battery"),
            min_sun_elevation_deg: num("min_sun"),
            needs_earth_visibility: f.has("earth"),
            ...(text("darkness") !== ""
              ? { max_darkness_hours: num("darkness") }
              : {}),
          },
          criteria: {
            min_window_hours: num("minimum"),
            min_power_margin_pct: num("power_margin"),
            max_results: num("max_results"),
          },
        };
    } catch {
      setError(
        "Enter valid JSON for polygon coordinates or the custom load profile.",
      );
      return;
    }
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await fetchEnergy(task, payload, c.signal);
      if (!c.signal.aborted) setResult({ task, data });
    } catch (err) {
      if (!c.signal.aborted)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="energy-planner" aria-label="Lunar Energy planner">
      <div className="energy-heading">
        <div>
          <p className="eyebrow">LUNAR ENERGY API · V1</p>
          <h1>Solar conditions & mission energy</h1>
          {siteName && <p>Site: {siteName} · {initialAt.replace("T", " ")} UTC</p>}
        </div>
        <button type="button" onClick={onClose}>
          Close planner
        </button>
      </div>
      <div className="energy-content">
        <p>
          Local LOLA terrain horizons · DE440 ephemerides · UTC dates. Solar
          analysis needs no equipment inputs.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(e.currentTarget);
          }}
          onChange={clear}
        >
          <label className="energy-wide">
            Analysis
            <select
              value={task}
              onChange={(e) => setTask(e.target.value as EnergyTask)}
            >
              {Object.entries(title).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Location & observer</legend>
            <div className="energy-fields">
              {numeric("lat", "Lunar latitude (° north)", lat, -90, 90)}
              {numeric(
                "lon",
                "Lunar longitude (° east)",
                lon,
                -180,
                359.999999,
              )}
              {numeric(
                "height",
                "Panel / sensor height above terrain (m)",
                2,
                0,
                50,
              )}
            </div>
            <p>
              Surface elevation, slope and aspect come from the installed LOLA
              data. Sensor height is an offset above the terrain.
            </p>
            {task === "region" && (
              <>
                <label>
                  Area shape
                  <select
                    value={area}
                    onChange={(e) => setArea(e.target.value)}
                  >
                    <option value="bbox">Bounding box</option>
                    <option value="circle">Circle around coordinates</option>
                    <option value="polygon">Polygon coordinates</option>
                  </select>
                </label>
                <div className="energy-fields">
                  {area === "bbox" && (
                    <>
                      {numeric("south", "Minimum latitude", -89.46, -90, 90)}
                      {numeric("north", "Maximum latitude", -89.44, -90, 90)}
                      {numeric(
                        "west",
                        "Minimum longitude",
                        -138,
                        -180,
                        359.999,
                      )}
                      {numeric(
                        "east",
                        "Maximum longitude",
                        -137,
                        -180,
                        359.999,
                      )}
                    </>
                  )}
                  {area === "circle" &&
                    numeric("radius", "Radius (m)", 240, 1, 50000)}
                  {area === "polygon" && (
                    <label className="energy-wide">
                      Vertices JSON · [latitude, longitude]
                      <textarea
                        name="polygon"
                        required
                        defaultValue="[[-89.46,-138],[-89.44,-138],[-89.44,-137]]"
                      />
                    </label>
                  )}
                  {numeric("resolution", "Grid resolution (m)", 240, 5)}
                  <label>
                    Analysis surface
                    <select name="surface">
                      <option value="horizontal">Horizontal</option>
                      <option value="terrain">Terrain surface</option>
                      <option value="vertical_tracking">
                        Vertical tracking
                      </option>
                      <option value="full_tracking">Full tracking</option>
                    </select>
                  </label>
                </div>
                <label className="energy-check">
                  <input type="checkbox" name="series" />
                  Include per-cell time series
                </label>
              </>
            )}
          </fieldset>
          <fieldset>
            <legend>Schedule · UTC</legend>
            <div className="energy-fields">
              <label>
                {task === "point" ? "Time (UTC)" : "Start (UTC)"}
                <input
                  name="start"
                  required
                  type="datetime-local"
                  defaultValue={initialAt}
                  min="2020-01-01T00:00"
                  max="2035-12-31T23:59"
                />
              </label>
              {(task === "region" || task === "windows") && (
                <label>
                  End (UTC)
                  <input
                    name="end"
                    required
                    type="datetime-local"
                    defaultValue={new Date(
                      Date.parse(`${initialAt}Z`) + 86400000,
                    )
                      .toISOString()
                      .slice(0, 16)}
                    min="2020-01-01T00:00"
                    max="2035-12-31T23:59"
                  />
                </label>
              )}
              {task === "mission" &&
                numeric("duration", "Mission duration (h)", 336, 0.25, 8760)}
              {task !== "point" &&
                numeric(
                  "step",
                  "Sampling step (h)",
                  task === "region" ? 6 : 1,
                  0.25,
                  24,
                )}
            </div>
          </fieldset>
          {task === "point" && (
            <fieldset className="energy-wide">
              <legend>Optional panel</legend>
              <label className="energy-check">
                <input name="custom_panel" type="checkbox" />
                Include custom panel irradiance
              </label>
              <div className="energy-fields">
                {numeric("point_tilt", "Panel tilt (°)", 90, 0, 90)}
                {numeric(
                  "point_azimuth",
                  "Panel facing azimuth (°)",
                  180,
                  0,
                  359.999,
                )}
              </div>
            </fieldset>
          )}
          {(task === "mission" || task === "windows") && (
            <>
              <fieldset className="energy-wide">
                <legend>Panel & equipment</legend>
                <div className="energy-fields">
                  <label>
                    Panel mode
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                    >
                      {[
                        "auto",
                        "fixed_horizontal",
                        "fixed_tilt",
                        "vertical_tracking",
                        "full_tracking",
                      ].map((value) => (
                        <option key={value} value={value}>
                          {label(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {mode === "fixed_tilt" && (
                    <>
                      {numeric("tilt", "Tilt (°)", 90, 0, 90)}
                      {numeric(
                        "azimuth",
                        "Facing azimuth (°)",
                        180,
                        0,
                        359.999,
                      )}
                    </>
                  )}
                  {numeric("efficiency", "Panel efficiency (%)", 30, 0.01, 100)}
                  {numeric("degradation", "Panel losses (%)", 0, 0, 50)}
                  {task === "mission" && (
                    <label>
                      Load profile
                      <select
                        value={profile}
                        onChange={(e) => setProfile(e.target.value)}
                      >
                        <option value="constant">
                          Constant operating load
                        </option>
                        <option value="custom">Custom UTC time series</option>
                      </select>
                    </label>
                  )}
                  {(task === "windows" || profile === "constant") &&
                    numeric("load", "Operating power (W)", 150, 0.001)}
                  {task === "mission" &&
                    profile === "constant" &&
                    numeric("peak", "Peak power (W)", 400, 0.001)}
                  {numeric(
                    "survival",
                    "Dark / standby survival power (W)",
                    40,
                    0,
                  )}
                  {task === "mission" && profile === "custom" && (
                    <label className="energy-wide">
                      Load JSON · times and power_w arrays
                      <textarea
                        required
                        name="custom_load"
                        placeholder='{"times":["2026-12-01T00:00:00Z","2026-12-15T00:00:00Z"],"power_w":[150,150]}'
                      />
                    </label>
                  )}
                  {task === "windows" && (
                    <>
                      <label>
                        Equipment name
                        <input name="name" defaultValue="Rover-A" />
                      </label>
                      {numeric(
                        "panel_area",
                        "Installed panel area (m²)",
                        1.2,
                        0.001,
                      )}
                      {numeric("battery", "Installed battery (Wh)", 3000, 0)}
                      {numeric(
                        "min_sun",
                        "Minimum lit Sun elevation (°)",
                        0,
                        -90,
                        90,
                      )}
                      <label>
                        Maximum darkness (h) · optional
                        <input
                          type="number"
                          name="darkness"
                          min="0"
                          step="any"
                          placeholder="Derived from battery and survival load"
                        />
                      </label>
                      {numeric(
                        "minimum",
                        "Minimum operating window (h)",
                        24,
                        0.25,
                      )}
                      {numeric(
                        "power_margin",
                        "Required average power margin (%)",
                        0,
                        0,
                      )}
                      {numeric(
                        "max_results",
                        "Maximum returned windows",
                        10,
                        1,
                        100,
                      )}
                      <label className="energy-check">
                        <input type="checkbox" name="earth" />
                        Require Earth visibility
                      </label>
                    </>
                  )}
                </div>
              </fieldset>
              <fieldset className="energy-wide">
                <legend>Storage & design assumptions</legend>
                <div className="energy-fields">
                  {numeric("dod", "Usable battery depth (%)", 80, 0.01, 100)}
                  {numeric(
                    "battery_efficiency",
                    "Round-trip battery efficiency (%)",
                    95,
                    0.01,
                    100,
                  )}
                  {numeric("margin", "Sizing margin (%)", 20, 0, 200)}
                  {numeric(
                    "tolerance",
                    "Simple-panel tolerance (%)",
                    15,
                    0,
                    100,
                  )}
                  <label>
                    Battery discharge limit (W) · optional
                    <input
                      name="discharge"
                      type="number"
                      min="0.001"
                      step="any"
                      placeholder="Needed for peak rate check"
                    />
                  </label>
                  <label className="energy-check">
                    <input name="simple" type="checkbox" />
                    Prefer simpler panels
                  </label>
                </div>
              </fieldset>
            </>
          )}
          <p className="energy-wide">
            Terrain horizons are sampled approximations. Narrow ridges, partial
            disk incidence and events between epochs have limited resolution. No
            thermal, eclipse or radio link-budget model.
          </p>
          <div className="energy-actions energy-wide">
            <button disabled={busy} type="submit">
              {busy ? "Computing…" : "Run energy analysis"}
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => {
                  controller.current?.abort();
                  setBusy(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        {busy && (
          <p role="status">
            Computing terrain horizons and solar conditions. First-time region
            analysis can take several minutes.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {result && <EnergyResults data={result.data} task={result.task} />}
      </div>
    </section>
  );
}

function Facts({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="energy-facts">
      {Object.entries(data).map(([key, value]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>{format(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
function EnergyResults({ data, task }: { data: EnergyData; task: EnergyTask }) {
  const [metric, setMetric] = useState("");
  const activeMetric =
    metric && data.metrics?.[metric]
      ? metric
      : Object.keys(data.metrics ?? {})[0];
  const timeline = data.timeline;
  const power = timeline?.solar_input_w ?? timeline?.power_w;
  const max = Math.max(1, ...(power ?? []), ...(timeline?.load_w ?? []));
  return (
    <section aria-label="Energy results">
      <h2>{title[task]} · results</h2>
      <button
        type="button"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(data, null, 2)], {
              type: "application/json",
            }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = `lunar-energy-${task}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Download full result JSON
      </button>
      {data.location && (
        <>
          <h3>LOLA location</h3>
          <Facts data={data.location} />
        </>
      )}
      {data.sun && (
        <>
          <h3>Sun</h3>
          <Facts data={data.sun} />
          <h3>Solar irradiance · W/m²</h3>
          <Facts data={data.irradiance ?? {}} />
          <h3>Earth</h3>
          <Facts data={data.earth ?? {}} />
        </>
      )}
      {data.sizing && (
        <>
          <p className={data.feasible ? "energy-good" : "banner"}>
            {data.feasible
              ? "Mission energy sizing is feasible under this model."
              : "No feasible design within the model limits."}
          </p>
          <h3>Panel & battery sizing</h3>
          <Facts data={data.sizing} />
          <h3>Energy budget</h3>
          <Facts data={data.energy ?? {}} />
          <h3>Solar conditions</h3>
          <Facts data={data.solar_conditions ?? {}} />
        </>
      )}
      {data.warnings?.map((w, i) => (
        <p className="banner" key={i}>
          {w.code}: {w.message} {w.time}
        </p>
      ))}
      {data.panel_recommendation && (
        <>
          <h3>
            Recommended panel: {label(data.panel_recommendation.selected_mode)}
          </h3>
          <p>
            Tilt: {format(data.panel_recommendation.selected_tilt_deg)}° ·
            Facing: {format(data.panel_recommendation.selected_azimuth_deg)}°
          </p>
          <details>
            <summary>Compare all panel modes</summary>
            <GenericTable rows={data.panel_recommendation.comparison} />
          </details>
        </>
      )}
      {data.summary && <Facts data={data.summary} />}
      {data.windows && (
        <>
          <h3>Operating windows · UTC</h3>
          {data.windows.length ? (
            <GenericTable rows={data.windows} />
          ) : (
            <p className="banner">
              No operating windows meet the selected criteria.
            </p>
          )}
          <details>
            <summary>Unsuitable periods</summary>
            {data.unsuitable_periods?.map((p, i) => (
              <p key={i}>
                {p.start} → {p.end}: {p.reasons.join(", ")}
              </p>
            ))}
          </details>
        </>
      )}
      {data.grid && data.metrics && (
        <>
          <p>
            {data.grid.rows} rows × {data.grid.cols} columns ·{" "}
            {data.grid.resolution_m} m grid spacing
          </p>
          <label>
            Grid metric
            <select
              value={activeMetric}
              onChange={(e) => setMetric(e.target.value)}
            >
              {Object.keys(data.metrics).map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </select>
          </label>
          <Facts
            data={{
              unit: data.metrics[activeMetric].unit,
              min: data.metrics[activeMetric].min,
              max: data.metrics[activeMetric].max,
              mean: data.metrics[activeMetric].mean,
            }}
          />
          {data.grid.rows * data.grid.cols <= 40000 ? (
            <div
              className="energy-heatmap"
              role="img"
              aria-label={`${label(activeMetric)} heatmap. Ranked values are available in the table below.`}
              style={{
                gridTemplateColumns: `repeat(${data.grid.cols}, minmax(4px,1fr))`,
              }}
            >
              {data.metrics[activeMetric].values.flatMap((row, r) =>
                row.map((value, c) => (
                  <span
                    key={`${r}-${c}`}
                    title={`Row ${r}, column ${c}: ${format(value)} ${data.metrics![activeMetric].unit}`}
                    style={{
                      background:
                        value === null
                          ? "transparent"
                          : `hsl(${210 - (170 * (value - (data.metrics![activeMetric].min ?? 0))) / Math.max(0.0001, (data.metrics![activeMetric].max ?? 1) - (data.metrics![activeMetric].min ?? 0))} 70% 48%)`,
                    }}
                  />
                )),
              )}
            </div>
          ) : (
            <p>
              Large grid: use the ranked cells below or download the full
              result.
            </p>
          )}
          <h3>Top cells by {label(data.ranking?.by ?? "")}</h3>
          <GenericTable rows={data.ranking?.top ?? []} />
          <details>
            <summary>
              Metric grid preview · first 100 rows/columns ·{" "}
              {data.metrics[activeMetric].unit}
            </summary>
            <div className="energy-table">
              <table>
                <tbody>
                  {data.metrics[activeMetric].values
                    .slice(0, 100)
                    .map((row, i) => (
                      <tr key={i}>
                        {row.slice(0, 100).map((v, j) => (
                          <td key={j}>{format(v)}</td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {timeline && power && (
        <>
          <figure className="energy-chart">
            <figcaption>Solar power & load · W</figcaption>
            <svg
              viewBox="0 0 640 180"
              role="img"
              aria-label="Power timeline. Gold: solar input. Blue: load. Values are listed below."
            >
              <polyline
                stroke="#f6ce70"
                fill="none"
                strokeWidth="2"
                points={power
                  .map(
                    (p, i) =>
                      `${30 + (580 * i) / Math.max(1, power.length - 1)},${150 - (120 * p) / max}`,
                  )
                  .join(" ")}
              />
              {timeline.load_w && (
                <polyline
                  stroke="#91dbff"
                  fill="none"
                  strokeDasharray="5 4"
                  points={timeline.load_w
                    .map(
                      (p, i) =>
                        `${30 + (580 * i) / Math.max(1, power.length - 1)},${150 - (120 * p) / max}`,
                    )
                    .join(" ")}
                />
              )}
              <text x="0" y="20">
                {format(max)}
              </text>
              <text x="30" y="175">
                Start
              </text>
              <text x="580" y="175">
                End
              </text>
            </svg>
          </figure>
          <details>
            <summary>Time series · UTC / W / usable SOC %</summary>
            <GenericTable
              rows={timeline.times.map((t, i) => ({
                time: t,
                power_w: power[i],
                ...(timeline.load_w ? { load_w: timeline.load_w[i] } : {}),
                battery_soc_pct: timeline.battery_soc_pct[i],
                ...(timeline.usable
                  ? { usable: String(timeline.usable[i]) }
                  : {}),
              }))}
            />
          </details>
        </>
      )}
      <details>
        <summary>Sources, model & request details</summary>
        <p>
          {data.meta.dem_product} · {data.meta.ephemeris} ·{" "}
          {data.meta.computed_in_ms} ms
        </p>
        <p>{data.meta.horizon_model}</p>
        <ul>
          {data.meta.limitations.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
        <p>Request ID: {data.meta.request_id}</p>
      </details>
    </section>
  );
}
function GenericTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <p>No records.</p>;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="energy-table">
      <table>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{label(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 1000).map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k}>{format(row[k] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
