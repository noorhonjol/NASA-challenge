const W = 314, H = 56;

/** Small line chart of one value over the mission period. */
export function Sparkline({ times, values, min, max, label, unit, className }:
  { times: string[]; values: number[]; min: number; max: number; label: string; unit: string; className: string }) {
  const n = values.length;
  const every = Math.max(1, Math.ceil(n / 400));
  const pts = values.filter((_, i) => i % every === 0 || i === n - 1)
    .map((v, i, all) => `${(i / Math.max(all.length - 1, 1) * W).toFixed(1)},${(H - 2 - (v - min) / (max - min || 1) * (H - 4)).toFixed(1)}`);
  const first = new Date(times[0]), last = new Date(times[n - 1]);
  const day = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return <figure className="sun-spark">
    <figcaption>{label}<span>{min.toFixed(0)}–{max.toFixed(0)} {unit}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} from ${day(first)} to ${day(last)}`}>
      <polyline className={className} points={pts.join(" ")} fill="none" />
    </svg>
    <div className="sun-spark-axis"><span>{day(first)}</span><span>{day(last)}</span></div>
  </figure>;
}
