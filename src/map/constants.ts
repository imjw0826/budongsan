// Foundational map constants.
//
// Zoom values follow the Leaflet-equivalent scale [10..18]. MapLibre's own
// zoom is offset by -1 (we pass `zoom - 1` to maplibre on init / flyTo, and
// add 1 when reading back). All thresholds below are in the Leaflet scale
// so existing zoom-based business logic continues to work unchanged.

/** Minimum/maximum zoom we expose to the user (Leaflet scale). */
export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 18;

// ---------------------------------------------------------------------------
// Zoom thresholds — visibility tiers for layers + labels.
// ---------------------------------------------------------------------------

/** Whole-city overview: 시 경계 + 구 라벨만. */
export const ZOOM_CITY = 10;

/** Auto-select a 자치구 at and above this zoom (matches current DISTRICT_AUTO_ZOOM). */
export const ZOOM_DISTRICT = 12;

/** Auto-select a 행정동. */
export const ZOOM_DONG = 14;

/** Apartment price chips + detail layers (matches `complexRankBudget` curve). */
export const ZOOM_DETAIL = 16;

/** Per-apartment label density allowed (used to gate MAX_VISIBLE_APARTMENT_LABELS clamp). */
export const ZOOM_APARTMENT_DETAIL = 17;

// ---------------------------------------------------------------------------
// Historical tile/cache constants.
// ---------------------------------------------------------------------------

/**
 * Kept for architecture docs and potential API-backed dynamic layers.
 * Static map geometry now uses MapLibre vector tiles, so visible tile
 * preloading/caching is handled internally by MapLibre GL JS.
 */
export const TILE_SPARE = 1;

/**
 * Per-zoom override. Low zoom needs more spare tiles (city panning sweeps a
 * larger geographic area per pixel), while high zoom is tighter because each
 * tile already carries dense building/road geometry.
 *
 * Sizing rationale per tile (chunk zoom 10/13/15):
 *   - low  (z10, ~3 layers): ~120 KB/tile · 2 spare ⇒ ~25 tiles ⇒ <3 MB
 *   - med  (z13, +complexes/roads): ~350 KB/tile · 1 spare ⇒ ~9 tiles ⇒ <3.2 MB
 *   - high (z15, +buildings): ~900 KB/tile · 1 spare ⇒ ~9 tiles ⇒ <8 MB
 * All three stay well under TILE_CACHE_MAX_BYTES (28 MB).
 */
export const TILE_SPARE_BY_ZOOM: Readonly<Record<"low" | "medium" | "high", number>> = {
  low: 2,    // ZOOM_CITY ~ ZOOM_DISTRICT  — fewer blank frames on long pans
  medium: 1, // ZOOM_DISTRICT ~ ZOOM_DETAIL
  high: 1,   // ZOOM_DETAIL ~ ZOOM_APARTMENT_DETAIL — was 0, raised to hide pan-tear
};

/** Soft cap for the in-memory tile cache (bytes). LRU eviction beyond this. */
export const TILE_CACHE_MAX_BYTES = 28 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Overlay density caps — prevent label flooding.
// ---------------------------------------------------------------------------

export const MAX_VISIBLE_APARTMENT_LABELS = 200;
export const MAX_VISIBLE_DONG_LABELS = 60;
export const MAX_VISIBLE_DISTRICT_LABELS = 30;

export type ZoomLayerVisibility = {
  loadDetailLayers: boolean;
  showDistrictBoundaries: boolean;
  showDistrictLabels: boolean;
  showDongBoundaries: boolean;
  showDongLabels: boolean;
  /** Han river is shown at every zoom — it is the city's primary landmark. */
  showHanRiver: boolean;
  /**
   * Parks (녹지) are tied to the same threshold as buildings + minor roads
   * so the detail layers fade in together. Previously parks appeared earlier
   * which produced an awkward "green dots over white" view at z12–13.
   */
  showParks: boolean;
  showMinorRoads: boolean;
  showBuildingFootprints: boolean;
  /** 가격 칩 노출. Level 2부터 적은 수로 시작한다. */
  showApartmentLabels: boolean;
};

export function getZoomLayerVisibility(zoom: number): ZoomLayerVisibility {
  const isDistrictZoom = zoom >= ZOOM_DISTRICT;
  const isDongZoom = zoom >= ZOOM_DONG;
  const isApartmentDetailZoom = zoom >= ZOOM_APARTMENT_DETAIL;

  return {
    loadDetailLayers: true,
    showDistrictBoundaries: true,
    showDistrictLabels: zoom < ZOOM_DONG,
    showDongBoundaries: isDongZoom,
    showDongLabels: isDongZoom && !isApartmentDetailZoom,
    showHanRiver: true,
    showParks: isDongZoom,
    showMinorRoads: isDongZoom,
    showBuildingFootprints: isDongZoom,
    showApartmentLabels: isDistrictZoom,
  };
}

// ---------------------------------------------------------------------------
// Chunking strategy — until we have real MVT/PMTiles, we group by 자치구.
// ---------------------------------------------------------------------------

export type ChunkGranularity = "district" | "vtile";
export const TILE_GRANULARITY: ChunkGranularity = "district";
