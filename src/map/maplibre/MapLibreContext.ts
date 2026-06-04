// Map instance is shared with child layer components via React context.
// Children read `map` in useEffect to add/remove sources+layers.
// DOM markers are positioned by `maplibregl.Marker` natively (no React
// re-render on pan/zoom), so we don't need a frame-version counter.

import { createContext, useContext } from "react";
import type { Map as MlMap } from "maplibre-gl";

export type MapLibreContextValue = {
  /** Live MapLibre map instance once mounted. Null during first render. */
  map: MlMap | null;
  /** Once true, all layer mount effects are safe to call addSource/addLayer. */
  ready: boolean;
};

export const MapLibreContext = createContext<MapLibreContextValue>({
  map: null,
  ready: false,
});

export function useMapLibre() {
  return useContext(MapLibreContext);
}
