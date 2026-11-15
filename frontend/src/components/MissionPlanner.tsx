import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Site } from "../api/client";
import { fetchKnownRegions, type KnownRegion, type LatLon, type Where } from "../api/mission";
import { MissionSearch } from "./MissionSearch";

export type PlannerSource = { kind: "location"; lat: number; lon: number; name: string };
/** What the planner draws on the Moon: the area, labelled spots and a smooth score surface. */
export type GlobeOverlay = {
  polygon: LatLon[] | null;
  spots: { lat: number; lon: number; label: string; pass: boolean; color?: string }[];
  surface?: { cells: LatLon[]; cellRows: number[]; cellCols: number[]; values: (number | null)[] } | null;
};

type Choice = "location" | "known" | "drawn";

export function MissionPlanner({ location, sites, mission, onMissionChange, drawn, onDraw, onFly, onOverlay, onClose, advanced, probing, onProbe, probe }: {
  /** The site picked on the globe or in the panel; null when nothing is selected. */
  location: PlannerSource | null;
  sites: Site[];
  mission: { start: string; end: string };
  onMissionChange: (start: string, end: string) => void;
  drawn: LatLon[] | null;
  onDraw: () => void;
  onFly: (lat: number, lon: number, elevation: number) => void;
  onOverlay: (overlay: GlobeOverlay) => void;
  onClose: () => void;
  advanced: ReactNode;
  probing: boolean;
  onProbe: (on: boolean) => void;
  probe: { lat: number; lon: number; elevation: number } | null;
}) {
  const [tab, setTab] = useState<"plan" | "advanced">("plan");
  const [choice, setChoice] = useState<Choice>(drawn ? "drawn" : location ? "location" : "known");
  const [known, setKnown] = useState("");
  const [regions, setRegions] = useState<KnownRegion[]>([]);
  const [regionsNote, setRegionsNote] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetchKnownRegions(controller.signal).then(doc => { setRegions((Array.isArray(doc?.regions) ? doc.regions : []).filter(r => r && Array.isArray(r.size_km) && Array.isArray(r.polygon))); setRegionsNote(doc.accuracy); })
      .catch(() => { /* The site list still works without the regions. */ });
    return () => controller.abort();
  }, []);

  // Depend on the coordinates, not the location object, which the parent recreates on every render.
  const locationLat = location?.lat ?? NaN, locationLon = location?.lon ?? NaN;
  // With nothing selected, "Selected site" cannot apply: fall back to the known list.
  const active: Choice = choice === "location" && !location ? "known" : choice;
  const where: Where | null = useMemo(() => {
    if (active === "location") return Number.isFinite(locationLat) && Number.isFinite(locationLon) ? { type: "point", lat: locationLat, lon: locationLon } : null;
    if (active === "drawn") return drawn && drawn.length >= 3 ? { type: "polygon", coordinates: drawn } : null;
    const region = regions.find(r => r.id === known);
    if (region) return { type: "polygon", coordinates: region.polygon };
    const site = sites.find(s => `site:${s.id}` === known);
    return site ? { type: "point", lat: site.lat_deg, lon: site.lon_deg } : null;
  }, [active, locationLat, locationLon, drawn, known, regions, sites]);
  return <section className="energy-planner mission-planner" aria-label="Mission planner">
    <div className="energy-heading">
      <div><h2>Mission planner</h2>
        <p>The best times and places for a mission: power, heat and Earth contact.</p></div>
      <button type="button" onClick={onClose}>Close planner</button>
    </div>
    <div className="mission-tabs" role="tablist" aria-label="Planner mode">
      <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Plan</button>
      <button type="button" role="tab" aria-selected={tab === "advanced"} onClick={() => setTab("advanced")}>Detailed analysis</button>
    </div>
    {tab === "plan" ? <div className="mission-plan" role="tabpanel" aria-label="Plan">
      <fieldset className="mission-step">
        <legend>1 · Where</legend>
        <label className="mission-choice"><input type="radio" name="where" disabled={!location} checked={active === "location"} onChange={() => setChoice("location")} />
          <span>Selected site<small>{location ? `${location.name} · ${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°` : "Pick a site first: choose one in the panel or click a pin"}</small></span></label>
        <label className="mission-choice"><input type="radio" name="where" checked={active === "known"} onChange={() => setChoice("known")} />
          <span>Artemis III region or known site<small>NASA's candidate landing regions and the PGDA 78 south-pole sites</small></span></label>
        {active === "known" && <label className="mission-known">Region or site<select value={known} onChange={e => setKnown(e.target.value)}>
          <option value="">Choose…</option>
          {regions.length > 0 && <optgroup label="NASA Artemis III candidate regions (2024)">
            {regions.map(r => <option key={r.id} value={r.id}>{r.name} · {r.size_km[0].toFixed(0)}×{r.size_km[1].toFixed(0)} km</option>)}
          </optgroup>}
          {sites.length > 0 && <optgroup label="Sites (single points)">
            {sites.map(s => <option key={s.id} value={`site:${s.id}`}>{s.name}</option>)}
          </optgroup>}
        </select></label>}
        {active === "known" && regions.some(r => r.id === known) && <p className="mission-note">{regionsNote}</p>}
        <label className="mission-choice"><input type="radio" name="where" checked={active === "drawn"} onChange={() => setChoice("drawn")} />
          <span>Draw a region on the Moon<small>{drawn && drawn.length >= 3 ? `${drawn.length} corners drawn` : "Click its corners on the globe"}</small></span></label>
        {active === "drawn" && <button type="button" className="sun-secondary" onClick={onDraw}>{drawn?.length ? "Redraw region on the Moon" : "Draw region on the Moon"}</button>}
      </fieldset>
      <MissionSearch where={where} mission={mission} onMissionChange={onMissionChange} onFly={onFly} onOverlay={onOverlay}
        probing={probing} onProbe={onProbe} probe={probe} />
    </div> : <div className="mission-advanced" role="tabpanel" aria-label="Detailed analysis">{advanced}</div>}
  </section>;
}
