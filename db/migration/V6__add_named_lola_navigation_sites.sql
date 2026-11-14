-- Named PGDA 78 region centers used as pins over the continuous PGDA 81 terrain.
-- Coordinates are derived from original projected raster bounds, MOON_ME/DE421.
-- No product 78 terrain datasets or raster downloads are reintroduced.
INSERT INTO sites (slug, name, lat_deg, lon_deg, elevation_m, frame, is_fictional, notes)
SELECT item->>'slug', item->>'name', (item->>'lat_deg')::double precision,
       (item->>'lon_deg')::double precision, (item->>'elevation_m')::double precision,
       'MOON_ME', false, item->>'notes'
FROM jsonb_array_elements($landmarks$[
  {
    "slug": "pgda-78-site01",
    "name": "Site01 · Connecting ridge",
    "lat_deg": -89.463162834037,
    "lon_deg": -137.48955292199918,
    "elevation_m": 1944.742,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-site04",
    "name": "Site04 · Shackleton rim",
    "lat_deg": -89.76681145215035,
    "lon_deg": -171.86989764584402,
    "elevation_m": 767.584,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-site06",
    "name": "Site06 · Nobile rim 1",
    "lat_deg": -85.43810048274601,
    "lon_deg": 37.3666694127687,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-site07",
    "name": "Site07 · Peak near Shackleton",
    "lat_deg": -88.81100807350447,
    "lon_deg": 123.69006752597979,
    "elevation_m": 1645.496,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-site11",
    "name": "Site11 · de Gerlache rim",
    "lat_deg": -88.68341815077612,
    "lon_deg": -67.9321004375898,
    "elevation_m": 1793.552,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-site20",
    "name": "Site20 · Leibnitz beta plateau",
    "lat_deg": -85.4265772804432,
    "lon_deg": 31.7427611534189,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-site20v2",
    "name": "Site20v2 · Leibnitz beta plateau, extended boundaries",
    "lat_deg": -85.4265772804432,
    "lon_deg": 31.7427611534189,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-site23",
    "name": "Site23 · Malapert massif",
    "lat_deg": -85.99478468356075,
    "lon_deg": -0.23578376987661054,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-site42",
    "name": "Site42 · de Gerlache-Kocher massif",
    "lat_deg": -85.8295505306016,
    "lon_deg": -116.32201645435761,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-haworth",
    "name": "Haworth · Haworth",
    "lat_deg": -86.76394197293897,
    "lon_deg": -22.77702382372379,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-shoemaker",
    "name": "Shoemaker · Shoemaker",
    "lat_deg": -87.18351447607765,
    "lon_deg": 62.83501494266807,
    "elevation_m": 548.04,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-dm1",
    "name": "DM1 · Amundsen rim",
    "lat_deg": -84.22873931238198,
    "lon_deg": 69.44395478041653,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-dm2",
    "name": "DM2 · Nobile rim 2",
    "lat_deg": -83.95401703076465,
    "lon_deg": 58.822054635731696,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-sl2",
    "name": "SL2 · de Gerlache rim",
    "lat_deg": -88.22997767029239,
    "lon_deg": -64.62843824690405,
    "elevation_m": -87.791,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-sl3",
    "name": "SL3 · Connecting ridge extension",
    "lat_deg": -89.03241562258243,
    "lon_deg": -101.99928693052141,
    "elevation_m": 1178.456,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-npa",
    "name": "NPA · Cabeus exterior wall 1",
    "lat_deg": -86.92432441921488,
    "lon_deg": -71.56505117707799,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-npb",
    "name": "NPB · Amundsen 1",
    "lat_deg": -83.90464573484799,
    "lon_deg": 89.53544980545384,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-npc",
    "name": "NPC · Idel'son L crater 1",
    "lat_deg": -84.53969961286576,
    "lon_deg": 126.90447566187127,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-npd",
    "name": "NPD · Malapert crater 1",
    "lat_deg": -84.80340115829851,
    "lon_deg": 8.38703237865949,
    "elevation_m": null,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Outside PGDA 81 (87–90 S); global LOLA terrain applies, altitude unknown."
  },
  {
    "slug": "pgda-78-lm1",
    "name": "LM1 · Shackleton Rim B",
    "lat_deg": -89.52438889222312,
    "lon_deg": 56.309932474020215,
    "elevation_m": -28.042,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm2",
    "name": "LM2 · Shoemaker Rim A",
    "lat_deg": -88.07923572547925,
    "lon_deg": 11.888658039627975,
    "elevation_m": -619.053,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm3",
    "name": "LM3 · Shoemaker Rim B",
    "lat_deg": -88.38284546433503,
    "lon_deg": 16.587338556927413,
    "elevation_m": -407.804,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm4",
    "name": "LM4 · Shoemaker Rim C",
    "lat_deg": -88.96450155414972,
    "lon_deg": 37.23483398157467,
    "elevation_m": -460.697,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm5",
    "name": "LM5 · Shoemaker Rim D",
    "lat_deg": -88.63197946148976,
    "lon_deg": 74.6237487511738,
    "elevation_m": -446.816,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm6",
    "name": "LM6 · Shoemaker Rim E",
    "lat_deg": -87.94577452092771,
    "lon_deg": 71.27421215472744,
    "elevation_m": -857.205,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm7",
    "name": "LM7 · Faustini Rim A",
    "lat_deg": -87.88965389477899,
    "lon_deg": 90.0,
    "elevation_m": 47.029,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  },
  {
    "slug": "pgda-78-lm8",
    "name": "LM8 · Shoemaker Rim F",
    "lat_deg": -87.34171476201938,
    "lon_deg": 60.25511870305778,
    "elevation_m": 476.85,
    "notes": "Navigation landmark at the center of the PGDA 78 regional DEM bounds, not an official landing coordinate. Names and bounds: https://pgda.gsfc.nasa.gov/products/78. Elevation sampled from the installed PGDA 81 5 m mosaic."
  }
]$landmarks$::jsonb) AS item
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lat_deg = EXCLUDED.lat_deg,
    lon_deg = EXCLUDED.lon_deg, elevation_m = EXCLUDED.elevation_m,
    frame = EXCLUDED.frame, is_fictional = false, notes = EXCLUDED.notes;
