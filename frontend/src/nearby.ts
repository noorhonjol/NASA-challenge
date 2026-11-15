/** Candidate points on a square grid of local east/north offsets around a site, on the 1,737.4 km sphere. */
const R_KM = 1737.4;
const rad = (d: number) => d * Math.PI / 180, deg = (r: number) => r * 180 / Math.PI;

export function offsetPoint(lat: number, lon: number, eastKm: number, northKm: number): [number, number] {
  const phi = rad(lat), lam = rad(lon);
  const p = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
  const north = [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)];
  const east = [-Math.sin(lam), Math.cos(lam), 0];
  const dist = Math.hypot(eastKm, northKm) / R_KM;
  if (dist === 0) return [lat, lon];
  const u = east.map((e, i) => (e * eastKm + north[i] * northKm) / (dist * R_KM));
  const q = p.map((v, i) => Math.cos(dist) * v + Math.sin(dist) * u[i]);
  return [deg(Math.asin(Math.max(-1, Math.min(1, q[2])))), deg(Math.atan2(q[1], q[0]))];
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearbyGrid(lat: number, lon: number, halfKm: number, perSide: number): [number, number][] {
  const offsets = Array.from({ length: perSide }, (_, i) => -halfKm + 2 * halfKm * i / (perSide - 1));
  return offsets.flatMap(n => offsets.map(e => offsetPoint(lat, lon, e, n)))
    .map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5] as [number, number]);
}
