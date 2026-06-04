// Map data repository — module-level memoization for boundary/han-river/
// complex datasets that the client still loads as GeoJSON (used for click
// handlers, evenodd mask, and price chip markers). Polygon rendering data
// is served via vector tiles, not through this repository.

import type { FeatureCollection } from "geojson";
import {
  loadBoundaries,
  loadComplexes,
  loadHanRiver,
  type BoundarySet,
} from "../../data/boundaries";

let boundariesPromise: Promise<BoundarySet> | null = null;
let hanRiverPromise: Promise<FeatureCollection> | null = null;
let complexesPromise: Promise<FeatureCollection> | null = null;

export function getBoundaries(): Promise<BoundarySet> {
  if (!boundariesPromise) boundariesPromise = loadBoundaries();
  return boundariesPromise;
}

export function getHanRiver(): Promise<FeatureCollection> {
  if (!hanRiverPromise) hanRiverPromise = loadHanRiver();
  return hanRiverPromise;
}

export function getComplexes(): Promise<FeatureCollection> {
  if (!complexesPromise) complexesPromise = loadComplexes();
  return complexesPromise;
}

/** Test / HMR helper — drop the cached promises so the next call refetches. */
export function resetMapDataCache(): void {
  boundariesPromise = null;
  hanRiverPromise = null;
  complexesPromise = null;
}

export type { BoundarySet } from "../../data/boundaries";
