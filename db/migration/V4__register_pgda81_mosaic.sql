-- Product 81 replaces the regional product 78 renderer after local preparation.
-- Existing product 78 records remain until the new mosaic is verified.
INSERT INTO terrain_datasets (catalog_key,name,product,file_uri,crs,resolution_m,source,license,notes,provenance)
VALUES (
 'pgda-81:87S', 'South Pole LOLA DEM Mosaic (87-90 S)', 'NASA PGDA product 81 - ldem_87s_5mpp',
 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif',
 '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +a=1737400 +b=1737400 +units=m +no_defs',
 5, 'https://pgda.gsfc.nasa.gov/products/81',
 'NASA PGDA policy: cite Barker et al. (2021), doi:10.1016/j.pss.2020.105119.',
 'Continuous south-pole elevation mosaic; 5 m native sampling. Browser preparation uses an overview plus cached local 5 m detail chunks.',
 '{"product_id":81,"region_id":"Mosaic81","region_name":"South Pole mosaic, 87-90 S","frame":"MOON_ME","ephemeris":"DE421","reference_radius_m":1737400,"coverage_latitude_deg":[-90,-87],"storage_status":"remote","terrain_ready":false,"browser_ready":false,"citation_doi":"10.1016/j.pss.2020.105119","source_archive":"https://imbrium.mit.edu/"}'::jsonb
);
