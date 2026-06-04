# MapLibre GL JS / WebGL Migration Notes

MapLibre migration is now implemented as the production renderer. This document remains as the design record: what moved to vector tiles, how layers map to MapLibre, how apartment price data stays connected, what remains in HTML, and what risks remain.

## Why This Migration Was Done

The previous renderer was `d3-geo` + `d3-zoom` + SVG/Canvas. It was useful for validating the visual language and data model, but the remaining performance ceiling was structural:

- canvas underlay still needs repaint after viewport/tile changes
- HTML labels are capped manually instead of using tile-aware collision
- the previous `/api/map/chunks` path sent GeoJSON and filtered by bbox at request time
- map state, styling, hit-testing, and source loading are custom code

MapLibre GL JS moves the heavy background map to WebGL and a style/source/layer model. Raw MVT tiles now remove the need to ship full GeoJSON chunks from the API for static map layers. PMTiles remains an optional packaging step.

Primary references:

- [MapLibre GL JS documentation](https://maplibre.org/maplibre-gl-js/docs/)
- [MapLibre Style Spec: sources](https://maplibre.org/maplibre-style-spec/sources/)
- [MapLibre Style Spec: layers](https://maplibre.org/maplibre-style-spec/layers/)
- [PMTiles Protocol for MapLibre](https://pmtiles.io/typedoc/classes/Protocol.html)
- [Tippecanoe](https://github.com/mapbox/tippecanoe)

## Data Converted To Vector Tiles

Static or slowly updated geometry is now built into vector tiles. We currently serve raw `.pbf` files from `public/tiles/{z}/{x}/{y}.pbf`; a single PMTiles archive can be added later without changing the layer model.

| Current file / source | Tile layer | Geometry | MVT min zoom | MVT max zoom | Notes |
|---|---:|---|---:|---:|---|
| `seoul-city.geojson` | `city` | polygon | 6 | 14 | Seoul outer boundary and mask support |
| `capital-sigg.geojson` | `neighbors` | polygon | 6 | 14 | Seoul outside context |
| `seoul-sigg.geojson` | `districts` | polygon | 6 | 14 | clickable district boundaries and district labels |
| `seoul-dong.geojson` | `dongs` | polygon | 11 | 14 | dong boundaries and labels |
| `han-river.geojson` | `hanRiver` | polygon | 8 | 14 | separate visual fill for river |
| `seoul-parks.geojson` | `parks` | polygon | 10 | 14 | green/open spaces |
| `seoul-roads-minor.geojson` | `roadsMinor` | line | 12 | 14 | local/service roads, aggressive simplification |
| `seoul-buildings.geojson` | `buildings` | polygon | 13 | 14 | building footprints, high zoom only |
| `seoul-complexes.geojson` | `complexes` | point | 11 | 14 | apartment price-chip anchor layer with rank, price summary, source metadata |

Attributes to preserve in vector tiles:

- `id`
- `name`
- `district`
- `neighborhood`
- `rank`
- `avgPrice`
- `households`
- `buildingCount`
- `locationSource`
- `polygonId`
- road `highway`
- building `complexId`

Attributes to avoid in vector tiles:

- per-unit price rows
- addresses if not needed for map display
- crawled raw fields
- large text payloads

Per-unit prices and detailed apartment records should remain in SQLite/API and load only when the user opens detail.

## Tile Build Pipeline

Current build target:

```text
public/tiles/{z}/{x}/{y}.pbf
```

Current pipeline:

1. Normalize all GeoJSON to EPSG:4326 and stable properties.
2. Generate `seoul-complexes.geojson` from DB with `scripts/build-complex-shapes.mjs`.
3. Run `scripts/build-vector-tiles.mjs`.
4. `geojson-vt` slices/simplifies each layer by zoom.
5. `vt-pbf` writes raw MVT `.pbf` files under `public/tiles`.
6. MapLibre loads the static tile pyramid with a `vector` source.

Optional PMTiles packaging command shape, not currently used:

```bash
tippecanoe \
  --output=public/tiles/seoul.pmtiles \
  --force \
  --minimum-zoom=8 \
  --maximum-zoom=18 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --named-layer=districts:tmp/districts.geojson \
  --named-layer=dongs:tmp/dongs.geojson \
  --named-layer=roads_minor:tmp/roads-minor.geojson \
  --named-layer=parks:tmp/parks.geojson \
  --named-layer=water:tmp/han-river.geojson \
  --named-layer=buildings:tmp/buildings.geojson \
  --named-layer=complexes:tmp/complexes.geojson
```

This Tippecanoe command remains useful only if we decide to package the current raw tile pyramid into PMTiles/MBTiles later. The production app currently serves raw `.pbf` tiles directly.

## MapLibre Source / Layer Mapping

Current single source:

```ts
map.addSource("seoul", {
  type: "vector",
  tiles: [`${window.location.origin}/tiles/{z}/{x}/{y}.pbf`],
  minzoom: 6,
  maxzoom: 14,
});
```

Recommended style layer order:

1. `background`
2. `neighbor_sigg_fill`
3. `seoul_mask_or_city_fill`
4. `water_fill`
5. `parks_fill`
6. `roads_minor_line`
7. `buildings_fill`
8. `district_boundary_line`
9. `dong_boundary_line`
10. `apartment_price_labels_symbol` or HTML overlay, depending collision quality
11. `district_labels_symbol`
12. `dong_labels_symbol`

Layer style equivalents:

| Current visual layer | MapLibre layer type | Source layer | Interaction |
|---|---|---|---|
| outside Seoul context | `fill` / `line` | `neighbors`, `city` | none |
| district boundaries | `line` | `districts` | click/queryRenderedFeatures |
| dong boundaries | `line` | `dongs` | click/queryRenderedFeatures |
| parks | `fill` | `parks` | none |
| Han River | `fill` | `hanRiver` | none |
| local roads | `line` | `roadsMinor` | none |
| buildings | `fill` | `buildings` | optional highlight by `complexId` |
| apartment price anchors | `circle` | `complexes` | hidden anchor layer; React HTML price chips handle visible interaction |

Use MapLibre expressions for zoom-based styling:

- district labels: visible below dong zoom
- dong labels: visible from district/dong zoom, hidden at apartment label zoom
- apartment labels: filter by `rank` and zoom
- price band color: derived from `avgPrice`

Example layer filter idea:

```ts
filter: ["<=", ["get", "rank"], ["interpolate", ["linear"], ["zoom"], 12, 40, 16, 160, 18, 320]]
```

This replaces the current manual `complexRankBudget` and `MAX_VISIBLE_APARTMENT_POINTS` logic for the WebGL path.

## Apartment Price Data Connection

Use two levels of apartment data:

1. Map-level summary in vector tiles:
   - `id`
   - `name`
   - `district`
   - `neighborhood`
   - `avgPrice`
   - `rank`
   - `locationSource`
   - `polygonId`
2. Detail-level data from API:
   - `/api/apartments/:id`
   - per building/floor/unit rows
   - official price history

Click behavior:

1. User clicks `apartment_price_labels_symbol`.
2. Client calls `map.queryRenderedFeatures(event.point, { layers: [...] })`.
3. Use feature `properties.id` to set selected apartment summary.
4. Show a compact MapLibre popup or existing React HTML popup.
5. “상세 보기” opens `/complex/:id`.
6. Detail page fetches SQLite-backed API as it does today.

Do not geocode in the frontend. The frontend should only consume `lng/lat`, `locationSource`, and `polygonId` generated offline.

## What Can Remain As HTML Overlay

Keep these as React/HTML at first:

- top search bar
- price range filter
- breadcrumb
- update badge
- contact/license controls
- apartment detail popup, if MapLibre popup styling feels too constrained
- detail page `/complex/:id`

Move these into MapLibre if performance or collision quality requires:

- district labels
- dong labels
- apartment price labels

Best first split:

- WebGL: all geographic background, boundaries, local roads, buildings, apartment price label anchors
- HTML: product UI, selected apartment popup, detail page

## Migration Steps

### Phase 1: Tile Production Only

- Add `scripts/build-vector-tiles.mjs`.
- Export current GeoJSON inputs to `tmp/vector-layers`.
- Build `public/tiles/seoul.pmtiles`.
- Add metadata check script that verifies required source layers and key properties.
- No app renderer changes.

Success criteria:

- `public/tiles/seoul.pmtiles` exists.
- All expected source layers are present.
- File size and build time are recorded.

### Phase 2: Hidden MapLibre Prototype Route

- Add `maplibre-gl` and `pmtiles`.
- Create `/debug/maplibre` route or dev-only component.
- Render only PMTiles source and basic style.
- Match initial Seoul viewport and zoom thresholds.

Success criteria:

- WebGL map loads from static PMTiles without API chunk calls.
- District/dong/water/park/road/building layers render in correct order.

### Phase 3: Interaction Parity

- Implement district/dong click using `queryRenderedFeatures`.
- Port breadcrumb state.
- Implement mouse-position based region selection if still needed.
- Implement fly-to with `map.flyTo`.
- Keep React popup/detail flow.

Success criteria:

- Current `중구 → 황학동 → apartment popup → detail` flow works.
- No frontend geocoding.

### Phase 4: Apartment Label Strategy

- Try MapLibre `symbol` layer for apartment labels with collision.
- Filter by `rank`, `avgPrice`, selected region, and zoom.
- If price chips need richer UI, keep only selected/current labels as HTML.

Success criteria:

- Labels do not overlap heavily.
- Zoom/pan remains smooth at high zoom.

### Phase 5: Replace Current MapStage

- Put renderer behind a feature flag:
  - `VITE_MAP_RENDERER=d3`
  - `VITE_MAP_RENDERER=maplibre`
- Keep d3/canvas renderer until MapLibre passes parity checks.
- `/api/map/chunks` has already been removed from the client render path; keep the server endpoint only as a legacy/debug fallback unless it is explicitly deleted later.

Success criteria:

- `npm run build` passes.
- local smoke check passes.
- visual parity acceptable at city/district/dong/apartment zooms.

## Risks

### Styling Risk

MapLibre style expressions are powerful but less flexible than arbitrary React/HTML for chip-like price labels. The mitigation is to use MapLibre for collision-managed price labels first, while keeping selected apartment popup in React.

### Data Build Risk

Tippecanoe may drop or simplify important small geometries at low zoom. Buildings and minor roads should be high-zoom only, and required layers need build validation scripts.

### Korean Labels / Font Risk

MapLibre symbol rendering needs correct glyph/font handling. If local glyph hosting is not set up, Korean labels can fail or look inconsistent. The first prototype should verify Korean district/dong labels before committing to symbol layers.

### Bundle Risk

MapLibre adds bundle weight. Lazy-load the MapLibre route/renderer and avoid shipping both renderers in the final production path.

### Interaction Risk

Current hover/selection logic is mouse-location based. MapLibre click/hit-test behavior is feature-based. The migration should prefer feature clicks, not replicate every pointermove region lookup.

### Tile Update Risk

Public price data may update more frequently than base geometry. Keep detailed prices in SQLite/API and put only summary price fields in PMTiles. If summaries update often, generate a separate `complexes.pmtiles` or use a small GeoJSON source for complexes.

### Operational Risk

PMTiles is easy to serve statically, but large files need cache headers and atomic replacement during deploy. Use versioned filenames such as `seoul-2026-05.pmtiles` to avoid stale browser caches.

## Recommended Decision Gate

Do not migrate immediately just because MapLibre exists. Switch when at least one condition is true:

- current d3/canvas renderer cannot keep panning above 45 FPS at target zoom
- API chunk filtering becomes a measurable bottleneck
- label collision and density rules become too complex to maintain manually
- building/road detail grows beyond current GeoJSON chunk capacity

Until then, keep the current renderer but align new data work with this plan: stable layer names, stable feature ids, offline geocoding, and vector-tile-friendly properties.
