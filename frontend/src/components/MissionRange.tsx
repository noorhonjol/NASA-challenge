import { addDays, rangeProblem, spanDays } from "../mission";

const PRESETS = [1, 7, 14, 30];
const PATTERN = "\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}";

// Text, not datetime-local: browsers format date pickers in the system locale (for example
// Arabic-Indic digits and a right-to-left order). The value stays "YYYY-MM-DDTHH:MM" (UTC);
// it is shown with a space instead of the T.
const shown = (value: string) => value.replace("T", " ");
const stored = (text: string) => text.trim().replace(" ", "T");

export function MissionRange({ start, end, onChange, startLabel = "Mission start (UTC)", endLabel = "Mission end (UTC)", presets = PRESETS }: {
  start: string; end: string; onChange: (start: string, end: string) => void; startLabel?: string; endLabel?: string; presets?: number[];
}) {
  const problem = rangeProblem(start, end);
  const days = spanDays(start, end);
  return <div className="link-controls">
    <label>{startLabel}<input type="text" inputMode="numeric" pattern={PATTERN} placeholder="2026-11-15 08:00"
      spellCheck={false} value={shown(start)} onChange={e => onChange(stored(e.target.value), end)} /></label>
    <label>{endLabel}<input type="text" inputMode="numeric" pattern={PATTERN} placeholder="2026-11-22 08:00"
      spellCheck={false} value={shown(end)} onChange={e => onChange(start, stored(e.target.value))} /></label>
    <div className="link-presets" role="group" aria-label="Set the end from the start">
      {presets.map(d => <button key={d} type="button" disabled={!start} aria-pressed={Math.abs(days - d) < 1e-6}
        onClick={() => onChange(start, addDays(start, d))}>{d === 1 ? "1 day" : `${d} days`}</button>)}
    </div>
    {problem && <p className="link-hint">{problem}</p>}
  </div>;
}
