import type { Site } from "../api/client";

export function SiteList({ sites }: { sites: Site[] }) {
  if (sites.length === 0) {
    return <p>No sites yet.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Slug</th>
          <th>Latitude</th>
          <th>Longitude</th>
          <th>Elevation (m)</th>
          <th>Frame</th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => (
          <tr key={site.id}>
            <td>{site.name}</td>
            <td>{site.slug}</td>
            <td>{site.lat_deg.toFixed(2)}</td>
            <td>{site.lon_deg.toFixed(2)}</td>
            <td>{site.elevation_m ?? "—"}</td>
            <td>{site.frame}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
