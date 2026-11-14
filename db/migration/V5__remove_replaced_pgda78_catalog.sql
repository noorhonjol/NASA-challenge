-- Retire product 78 after installing product 81. Preserve any historical run's
-- original terrain metadata before detaching its FK; do not delete analysis runs.
UPDATE analysis_runs AS run
SET provenance = run.provenance || jsonb_build_object('retired_terrain_dataset', to_jsonb(dataset)),
    terrain_dataset_id = NULL
FROM terrain_datasets AS dataset
WHERE run.terrain_dataset_id = dataset.id AND dataset.catalog_key LIKE 'pgda-78:%';

DELETE FROM terrain_datasets WHERE catalog_key LIKE 'pgda-78:%';
