-- Lunar Planner Phase 1 schema and fictional seed data.
--
-- Lunar coordinates only: every site records the reference frame it uses.
-- No Earth CRS (e.g. EPSG:4326) is ever applied to these tables.
--
-- Flyway owns schema creation; the SQLModel classes in backend/app/models.py
-- only map what is defined here and never call create_all().

CREATE TABLE sites (
    id           bigserial PRIMARY KEY,
    slug         text NOT NULL UNIQUE,
    name         text NOT NULL,
    lat_deg      double precision NOT NULL CHECK (lat_deg BETWEEN -90 AND 90),
    lon_deg      double precision NOT NULL CHECK (lon_deg BETWEEN -180 AND 180),
    elevation_m  double precision,
    frame        text NOT NULL,
    is_fictional boolean NOT NULL DEFAULT true,
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terrain_datasets (
    id           bigserial PRIMARY KEY,
    name         text NOT NULL,
    product      text,
    file_uri     text,
    crs          text,
    resolution_m double precision,
    source       text,
    retrieved_at timestamptz,
    license      text,
    notes        text
);

CREATE TABLE analysis_runs (
    id                 bigserial PRIMARY KEY,
    site_id            bigint NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    terrain_dataset_id bigint REFERENCES terrain_datasets (id),
    label              text,
    status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    config             jsonb NOT NULL DEFAULT '{}'::jsonb,
    provenance         jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at         timestamptz,
    finished_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_analysis_runs_site_id ON analysis_runs (site_id);

CREATE TABLE visibility_windows (
    id              bigserial PRIMARY KEY,
    analysis_run_id bigint NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE,
    kind            text NOT NULL,
    start_utc       timestamptz NOT NULL,
    end_utc         timestamptz NOT NULL,
    confidence      double precision,
    notes           text,
    CHECK (end_utc > start_utc)
);

CREATE INDEX ix_visibility_windows_analysis_run_id ON visibility_windows (analysis_run_id);

-- Fictional placeholder sites. No terrain, ephemeris, or analysis data is
-- seeded: these rows exist only to prove the read path works.
INSERT INTO sites (slug, name, lat_deg, lon_deg, elevation_m, frame, is_fictional, notes)
VALUES
  ('shackleton-rim-fictional', 'Shackleton Rim (fictional)', -89.45, 129.20, 1400.0, 'MOON_ME', true,
   'Fictional placeholder near the lunar south pole rim. Not a surveyed site; no terrain or ephemeris data behind it.'),
  ('malapert-massif-fictional', 'Malapert Massif (fictional)', -86.00, 2.70, 5000.0, 'MOON_ME', true,
   'Fictional placeholder on a high peak near the south pole. Coordinates are illustrative only.'),
  ('de-gerlache-basin-fictional', 'de Gerlache Basin Floor (fictional)', -88.50, -87.10, NULL, 'MOON_ME', true,
   'Fictional permanently shadowed basin placeholder with unknown elevation, used to exercise null handling.');
