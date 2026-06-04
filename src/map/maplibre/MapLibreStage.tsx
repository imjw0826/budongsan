// MapLibre-GL backed map stage. Drop-in replacement for the d3-zoom based
// MapStage:
//   - Mounts a maplibre `Map` on a div container.
//   - No basemap tiles — we render our own GeoJSON sources (han river, parks,
//     buildings, etc.) inside child layer components.
//   - Bridges maplibre lifecycle events (move, zoom, idle) into the same
//     callback surface the rest of the app already speaks:
//       onViewportChange / onZoomChange / onPanZoomPhase
//   - Exposes the map instance via context so child layers can register
//     sources/layers. DOM markers are positioned by `maplibregl.Marker`
//     natively — no React re-render on pan/zoom.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import maplibregl, { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapViewport } from "../viewport";
import type { PanZoomPhase } from "../types";
import { MAP_MAX_ZOOM, MAP_MIN_ZOOM } from "../constants";
import { MapLibreContext } from "./MapLibreContext";

/** [lng, lat] — maplibre's coordinate order. */
const SEOUL_CENTER_LNGLAT: [number, number] = [126.99, 37.5532];
/** Empty style — all visible features come from sources we add in children. */
const EMPTY_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#f7f7f4" },
    },
  ],
};

/** Phase debounce: how long after idle stops we emit our `idle` phase. */
const IDLE_DEBOUNCE_MS = 200;

export type FlyTarget = {
  center: [number, number]; // [lat, lng] — matches existing call sites
  zoom: number; // 10..18 leaflet-equivalent
};

export type MapLibreStageProps = {
  zoomLevel: number;
  flyTarget: FlyTarget | null;
  onZoomChange: (zoom: number) => void;
  onViewportChange: (viewport: MapViewport) => void;
  onPanZoomPhase?: (phase: PanZoomPhase) => void;
  children?: ReactNode;
};

function readViewport(map: MlMap): MapViewport {
  const b = map.getBounds();
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
}

export function MapLibreStage({
  zoomLevel,
  flyTarget,
  onZoomChange,
  onViewportChange,
  onPanZoomPhase,
  children,
}: MapLibreStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Map instance lives in state — refs can't be read during render, and
  // children need a stable handle in the context value below.
  const [map, setMap] = useState<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  // Latest callbacks via refs so the mount effect can stay one-shot.
  const onZoomRef = useRef(onZoomChange);
  const onViewportRef = useRef(onViewportChange);
  const onPhaseRef = useRef(onPanZoomPhase);
  useEffect(() => {
    onZoomRef.current = onZoomChange;
    onViewportRef.current = onViewportChange;
    onPhaseRef.current = onPanZoomPhase;
  });

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: EMPTY_STYLE,
      center: SEOUL_CENTER_LNGLAT,
      zoom: zoomLevel - 1, // maplibre zoom 0..22 ≈ leaflet zoom 1..23 — visually close enough at our scale
      minZoom: MAP_MIN_ZOOM - 1,
      maxZoom: MAP_MAX_ZOOM - 1,
      attributionControl: false,
      // Disable map rotation — keeps our DOM marker math simple.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: false,
      renderWorldCopies: false,
    });
    setMap(map);

    // Lock to north-up (touchZoomRotate above disables rotation gesture; this
    // is belt-and-braces in case any plugin tries to set bearing).
    map.touchZoomRotate.disableRotation();

    let idleTimer: number | null = null;
    let gestureKind: "pan" | "zoom" | null = null;
    const scheduleIdle = () => {
      if (idleTimer != null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        onPhaseRef.current?.("idle");
        idleTimer = null;
      }, IDLE_DEBOUNCE_MS);
    };

    map.on("load", () => {
      onZoomRef.current(map.getZoom() + 1);
      onViewportRef.current(readViewport(map));
      setReady(true);
    });

    map.on("movestart", (event) => {
      // Distinguish pinch/scroll-zoom from drag pan.
      gestureKind = (event as { originalEvent?: WheelEvent }).originalEvent?.type === "wheel"
        ? "zoom"
        : "pan";
      onPhaseRef.current?.(gestureKind === "zoom" ? "zoomStart" : "panStart");
    });
    map.on("zoomstart", () => {
      if (gestureKind !== "zoom") {
        gestureKind = "zoom";
        onPhaseRef.current?.("zoomStart");
      }
    });

    map.on("move", () => {
      onPhaseRef.current?.(gestureKind === "zoom" ? "zoomMove" : "panMove");
    });

    map.on("moveend", () => {
      onZoomRef.current(map.getZoom() + 1);
      onViewportRef.current(readViewport(map));
      onPhaseRef.current?.(gestureKind === "zoom" ? "zoomEnd" : "panEnd");
      gestureKind = null;
      scheduleIdle();
    });

    return () => {
      if (idleTimer != null) window.clearTimeout(idleTimer);
      map.remove();
      setMap(null);
      setReady(false);
    };
    // Intentionally exhaustive-deps-disabled: this effect mounts once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // flyTo bridge — translates the [lat, lng] / zoom convention used in App.tsx.
  useEffect(() => {
    if (!flyTarget || !map) return;
    map.flyTo({
      center: [flyTarget.center[1], flyTarget.center[0]],
      zoom: flyTarget.zoom - 1,
      duration: 600,
      essential: true,
    });
  }, [flyTarget, map]);

  const ctxValue = useMemo(() => ({ map, ready }), [map, ready]);

  return (
    <MapLibreContext.Provider value={ctxValue}>
      <div ref={containerRef} className="map-libre-stage" />
      {ready && children}
    </MapLibreContext.Provider>
  );
}
