import type { Site } from "../api/client";

export type SiteMarker = {
  id: number;
  slug: string;
  name: string;
  longitudeDeg: number;
  latitudeDeg: number;
  heightM: number;
  frame: string;
  description: string;
};

/**
 * Turn API sites into globe markers. A missing elevation becomes 0 m: the
 * surface position matters, the unknown height does not, and a null must never
 * drop the pin. Coordinates stay in the lunar frame the site declares; no Earth
 * projection is applied.
 */
export function toSiteMarkers(sites: Site[]): SiteMarker[] {
  return sites.map((site) => ({
    id: site.id,
    slug: site.slug,
    name: site.name,
    longitudeDeg: site.lon_deg,
    latitudeDeg: site.lat_deg,
    heightM: site.elevation_m ?? 0,
    frame: site.frame,
    description:
      `${site.name} — ${site.slug}. Frame ${site.frame}` +
      (site.is_fictional ? ". Fictional placeholder site." : "."),
  }));
}
