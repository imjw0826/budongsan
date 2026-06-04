// React-side adapter for the map data repository.
//
// Boundaries + Han river + complex point list are all loaded once on mount.
// Boundaries are needed for click handlers / mask geometry / dong filter;
// complexes feed the HTML price chip markers. Visible polygon geometry now
// comes from the vector tile source — see MapLibreLayerStack.

import { useEffect, useState } from "react";
import type { FeatureCollection } from "geojson";
import {
  getBoundaries,
  getComplexes,
  getHanRiver,
  type BoundarySet,
} from "./mapRepository";

export type MapDataSnapshot = {
  boundaries: BoundarySet | null;
  hanRiver: FeatureCollection | null;
  complexes: FeatureCollection | null;
  boundaryError: string | null;
};

export function useMapData(): MapDataSnapshot {
  const [boundaries, setBoundaries] = useState<BoundarySet | null>(null);
  const [hanRiver, setHanRiver] = useState<FeatureCollection | null>(null);
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
    getHanRiver()
      .then((data) => {
        if (!cancelled) setHanRiver(data);
      })
      .catch(() => undefined);
    getComplexes()
      .then((data) => {
        if (!cancelled) setComplexes(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return { boundaries, hanRiver, complexes, boundaryError };
}
