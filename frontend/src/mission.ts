/** Mission time range helpers. datetime-local values are read as UTC everywhere in the app. */
export const DAY_MS = 86400000;
export const MAX_DAYS = 366;            // backend limit

export const toUtc = (local: string) => new Date(`${local}:00Z`);
export const toLocal = (date: Date) => Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
export const addDays = (local: string, days: number) => toLocal(new Date(toUtc(local).getTime() + days * DAY_MS));
export const spanDays = (start: string, end: string) => (toUtc(end).getTime() - toUtc(start).getTime()) / DAY_MS;

export function rangeProblem(start: string, end: string): string | null {
  const days = spanDays(start, end);
  if (!start || !end || Number.isNaN(days)) return "Enter a start and an end.";
  if (days <= 0) return "The end must be after the start.";
  if (days > MAX_DAYS) return `The range can be at most ${MAX_DAYS} days.`;
  return null;
}

export const hours = (h: number) => h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
export const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
