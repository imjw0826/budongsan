// Map data repository — module-level memoization for boundary + complex
// datasets. Boundaries feed click handlers + drill-down; complexes feed
// the HTML price chip markers. Everything else is a CARTO raster tile.

import type { FeatureCollection } from "geojson";
import {
  loadBoundaries,
  loadComplexes,
  type BoundarySet,
} from "../../data/boundaries";

let boundariesPromise: Promise<BoundarySet> | null = null;
let complexesPromise: Promise<FeatureCollection> | null = null;

export function getBoundaries(): Promise<BoundarySet> {
  if (!boundariesPromise) boundariesPromise = loadBoundaries();
  return boundariesPromise;
}

export function getComplexes(): Promise<FeatureCollection> {
  if (!complexesPromise) complexesPromise = loadComplexes();
  return complexesPromise;
}

/** Test / HMR helper — drop the cached promises so the next call refetches. */
export function resetMapDataCache(): void {
  boundariesPromise = null;
  complexesPromise = null;
}

export type { BoundarySet } from "../../data/boundaries";
