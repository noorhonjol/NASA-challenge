export type Site = {
  id: number;
  slug: string;
  name: string;
  lat_deg: number;
  lon_deg: number;
  elevation_m: number | null;
  frame: string;
  is_fictional: boolean;
  notes: string | null;
};

export async function fetchSites(): Promise<Site[]> {
  const res = await fetch("/api/sites");
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res.json();
}
