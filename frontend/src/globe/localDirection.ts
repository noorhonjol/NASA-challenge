/** Horizons azimuth is clockwise from north; elevation is above the ENU plane. */
export function localDirection(azimuthDeg: number, elevationDeg: number, distance: number) {
  const az = azimuthDeg * Math.PI / 180;
  const el = elevationDeg * Math.PI / 180;
  return {
    east: distance * Math.cos(el) * Math.sin(az),
    north: distance * Math.cos(el) * Math.cos(az),
    up: distance * Math.sin(el),
  };
}
