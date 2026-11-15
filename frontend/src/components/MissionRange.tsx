import { addDays, rangeProblem, spanDays } from "../mission";

const PRESETS = [1, 7, 14, 30];

export function MissionRange({ start, end, onChange }: { start: string; end: string; onChange: (start: string, end: string) => void }) {
  const problem = rangeProblem(start, end);
  const days = spanDays(start, end);
  return <div className="link-controls">
    <label>Mission start (UTC)<input type="datetime-local" min="1550-01-01T00:00" max="2649-12-31T23:59" value={start}
      onChange={e => onChange(e.target.value, end)} /></label>
    <label>Mission end (UTC)<input type="datetime-local" min="1550-01-01T00:00" max="2649-12-31T23:59" value={end}
      onChange={e => onChange(start, e.target.value)} /></label>
    <div className="link-presets" role="group" aria-label="Set the end from the start">
      {PRESETS.map(d => <button key={d} type="button" disabled={!start} aria-pressed={Math.abs(days - d) < 1e-6}
        onClick={() => onChange(start, addDays(start, d))}>{d === 1 ? "1 day" : `${d} days`}</button>)}
    </div>
    {problem && <p className="link-hint">{problem}</p>}
  </div>;
}
