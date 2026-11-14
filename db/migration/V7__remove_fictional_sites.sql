-- Remove the original demonstration sites. Guard against accidentally cascading
-- into saved analyses on installations where these placeholders were used.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM analysis_runs a JOIN sites s ON s.id = a.site_id WHERE s.is_fictional) THEN
        RAISE EXCEPTION 'Archive analyses linked to fictional sites before removing those sites';
    END IF;
    DELETE FROM sites WHERE is_fictional;
END $$;
