import type { Positions } from "../api/client";

export function HorizonView({ data }: { data: Positions }) {
  const x = (az: number) => 65 + az / 360 * 830;
  const y = (el: number) => 210 - el / 90 * 160;
  return <section className="horizon-panel">
    <h2>Sun & Earth · local horizon</h2>
    <p>Observed at {new Date(data.at_utc).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</p>
    <svg viewBox="0 0 960 440" role="img" aria-label={`Sun elevation ${data.sun.elevation_deg.toFixed(2)} degrees; Earth elevation ${data.earth.elevation_deg.toFixed(2)} degrees`}>
      <rect x="65" y="50" width="830" height="160" fill="#122a43" />
      <rect x="65" y="210" width="830" height="160" fill="#292d37" />
      {[-90, -45, 0, 45, 90].map(el => <g key={el}>
        <line x1="65" x2="895" y1={y(el)} y2={y(el)} stroke={el === 0 ? "#fff" : "#465466"} strokeDasharray={el === 0 ? undefined : "4 5"} />
        <text x="52" y={y(el) + 5} textAnchor="end">{el}°</text>
      </g>)}
      {["N · 0°", "E · 90°", "S · 180°", "W · 270°", "N · 360°"].map((label, i) => <text key={label} x={x(i * 90)} y="397" textAnchor="middle">{label}</text>)}
      <text x="480" y="432" textAnchor="middle">Azimuth clockwise from north</text>
      {(["sun", "earth"] as const).map((key, i) => {
        const body = data[key];
        return <g key={key}>
          <circle cx={x(body.azimuth_deg)} cy={y(body.elevation_deg)} r="9" fill={key === "sun" ? "#ffd166" : "#69ceff"} stroke="#fff" />
          <text x={x(body.azimuth_deg)} y={y(body.elevation_deg) + (i ? 28 : -18)} textAnchor={body.azimuth_deg > 320 ? "end" : body.azimuth_deg < 40 ? "start" : "middle"}>{key === "sun" ? "Sun" : "Earth"} {body.elevation_deg.toFixed(2)}°</text>
        </g>;
      })}
    </svg>
    <div className="metrics">{(["sun", "earth"] as const).map(key => <article key={key}>
      <h3>{key === "sun" ? "Sun · lighting" : "Earth · direct communication"}</h3>
      <strong>{data[key].elevation_deg.toFixed(2)}° elevation</strong>
      <p>{data[key].azimuth_deg.toFixed(2)}° azimuth · {data[key].above_horizon ? "Above horizon" : "At or below horizon"}</p>
    </article>)}</div>
    <p className="attribution">Live data: <a href="https://ssd.jpl.nasa.gov/horizons/">{data.source}</a>. {data.horizon_model} Visibility indicates body-center geometry, not guaranteed solar power or a communication link.</p>
  </section>;
}
