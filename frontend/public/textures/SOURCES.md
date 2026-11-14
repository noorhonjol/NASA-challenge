# Imagery sources

- `lroc_color_2k.jpg`: NASA SVS CGI Moon Kit, LRO LROC WAC global mosaic.
- `earth-blue-marble.jpg`: NASA Blue Marble land/ocean image, distributed by the
  WebGL Earth sample at https://github.com/turban/webgl-earth/blob/master/images/2_no_clouds_4k.jpg.
  Used as an offline globe fallback and illustrative Earth disc. This static image
  does not encode the observed Earth rotation, cloud cover or phase for a chosen date.

Moon rendering uses these bundled images plus the locally prepared PGDA 81 south
pole mosaic and derived relief PNG, with no runtime NASA tile requests. The mosaic
has a 50 m display overview and cached native 5 m detail chunks. Data preparation
is documented in the root README. Source: https://pgda.gsfc.nasa.gov/products/81;
credit Barker et al. (2021), doi:10.1016/j.pss.2020.105119. The global elevation
backdrop is NASA PDS LRO LOLA LDEM_16, downsampled to 8 pixels/degree for display.
Derived relief images use fixed illumination and are not photographs or a
simulation of shadows at the selected date. Original GeoTIFF files remain local.

Earth mode streams Esri World Imagery and falls back to bundled NASA Blue Marble.

Navigation and sky-view behavior were informed by
https://github.com/yousef-najeh/Nasa, specifically `src/main.js`, `src/navigation.js`
and `src/bodies.js`; implemented here for the existing React/Cesium/Horizons app.
