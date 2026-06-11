// Foundational map domain types — only what's still referenced after the
// MapLibre migration. Older types (ViewState, MapLayerType, TileData,
// RenderTile, Apartment, LayerLoadState) were removed in the post-migration
// cleanup.

// ---------------------------------------------------------------------------
// Tile coordinates (Slippy-map XYZ scheme).
// ---------------------------------------------------------------------------

export type TileCoord = {
  z: number;
  x: number;
  y: number;
};

/** Stable string key for cache lookups, e.g. "13/6987/3185". */
export type TileId = `${number}/${number}/${number}`;

// ---------------------------------------------------------------------------
// Apartment overlay shape — backend-agnostic.
// ---------------------------------------------------------------------------

export type ApartmentLocationSource =
  | "geocoded-address"
  | "complex-footprint"
  | "district-centroid";

export type ApartmentMapItem = {
  id: string;
  name: string;
  district: string;
  neighborhood: string;
  lat: number;
  lng: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  households: number;
  buildingCount: number;
  rank: number;
  locationSource: ApartmentLocationSource;
  polygonId?: string;
  centroid?: [number, number];             // [lng, lat]
};

// ---------------------------------------------------------------------------
// Pan / zoom phases — emitted by MapLibreStage.
// ---------------------------------------------------------------------------

export type PanZoomPhase =
  | "panStart"
  | "panMove"
  | "panEnd"
  | "zoomStart"
  | "zoomMove"
  | "zoomEnd"
  | "idle";
