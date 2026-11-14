-- Positions are now requested directly from JPL Horizons, never persisted.
-- IF EXISTS also supports Phase 1 databases which never had this table.
DROP TABLE IF EXISTS ephemeris_samples;
