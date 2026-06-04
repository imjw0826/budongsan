# Prebuilt Tiles / PMTiles Roadmap

This is the long-term replacement plan for runtime GeoJSON chunk filtering in `/api/map/chunks`.

## Goal

Move static or slowly changing map geometry out of the API request path:

- administrative boundaries
- river and parks
- local roads
- building footprints
- apartment complex point geometry

The API should keep serving dynamic data such as selected-region apartment lists and detail prices.

## Current State

- Static geometry no longer uses `/api/map/chunks`.
- `scripts/build-vector-tiles.mjs` builds raw Mapbox Vector Tile `.pbf` files under `public/tiles/{z}/{x}/{y}.pbf`.
- MapLibre GL JS loads those static vector tiles directly through a single `vector` source.
- The API remains responsible for dynamic data such as apartment detail pages and price rows.
- PMTiles packaging is still optional future work. The current raw `.pbf` pyramid already provides viewport-based tile loading, LOD, MapLibre tile cache, and smooth WebGL rendering; it only lacks the operational convenience of a single archive file.

## Target Architecture

- Generate vector tiles from `public/boundaries/*.geojson`.
- Package the existing raw MVT pyramid into one versioned PMTiles archive, for example `public/tiles/seoul-map-2026-05.pmtiles`.
- Use MapLibre GL JS plus the `pmtiles` protocol on the client when the archive step is added.
- Keep apartment detail and price tables in SQLite/API.
- Optionally publish apartment summary points as a separate PMTiles archive if geometry updates on a different cadence.

## Migration Steps

- [x] Normalize source layer names: `city`, `districts`, `dongs`, `neighbors`, `hanRiver`, `parks`, `roadsMinor`, `buildings`, `complexes`.
- [x] Add a tile build script: `scripts/build-vector-tiles.mjs`.
- [x] Run an equivalent vector tile builder: `geojson-vt` + `vt-pbf`, outputting raw `.pbf` MVT files.
- [ ] Optional: package raw tiles into a single versioned PMTiles archive.
- [x] Add MapLibre renderer as the production map path.
- [x] Match the current monochrome outline style in MapLibre layers.
- [x] Move hover/click hit testing to MapLibre feature queries.
- [x] Keep `/api/apartments` and `/api/apartments/:id` unchanged.
- [x] Compare performance qualitatively on city, district, and dong views with browser QA.
- [x] Remove `/api/map/chunks` from the client render path.

## Acceptance Criteria

- [x] Initial city map renders without calling `/api/map/chunks`.
- [x] Pan and wheel zoom stay smooth while local roads/buildings are visible. Browser QA on 2026-06-04 captured immediate post-scroll and post-drag frames without blank/white flash.
- [x] District and dong click behavior matches the current app.
- [x] Apartment markers remain region-correct.
- [x] Build and smoke commands pass:
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:search-filter`

## Related Document

See `docs/maplibre-webgl-migration-plan.md` for the fuller MapLibre design notes.
