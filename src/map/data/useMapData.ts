// React-side adapter for the map data repository.
//
// Boundaries + complex point list are all loaded once on mount.
// Background geometry (roads, parks, buildings, river) comes from CARTO
// raster tiles served directly by the LeafletMap tile layer.

import { useEffect, useState } from "react";
import type { FeatureCollection } from "geojson";
import {
  getBoundaries,
  getComplexes,
  type BoundarySet,
} from "./mapRepository";

export type MapDataSnapshot = {
  boundaries: BoundarySet | null;
  complexes: FeatureCollection | null;
  boundaryError: string | null;
};

export function useMapData(): MapDataSnapshot {
  const [boundaries, setBoundaries] = useState<BoundarySet | null>(null);
  const [complexes, setComplexes] = useState<FeatureCollection | null>(null);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBoundaries()
      .then((data) => {
        if (!cancelled) setBoundaries(data);
      })
      .catch((error) => {
        if (!cancelled) setBoundaryError(error?.message ?? String(error));
      });
    getComplexes()
      .then((data) => {
        if (!cancelled) setComplexes(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return { boundaries, complexes, boundaryError };
}
