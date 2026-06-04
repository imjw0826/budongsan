// Single DOM marker positioned by maplibre. Wraps `new maplibregl.Marker`
// with a React tree mounted into its element via createPortal.
//
// Anchor offset is given as pixels [x, y] from the marker's lat/lng to the
// element's top-left corner. This matches the existing anchor convention so
// chip / popup arrows still point to the same pixel.

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import { useMapLibre } from "./MapLibreContext";

export type MapLibreMarkerProps = {
  lng: number;
  lat: number;
  /** Pixel offset from the lng/lat anchor to the element's top-left. */
  anchor: [number, number];
  className?: string;
  zIndex?: number;
  children: ReactNode;
  onClick?: () => void;
};

export function MapLibreMarker({
  lng,
  lat,
  anchor,
  className,
  zIndex,
  children,
  onClick,
}: MapLibreMarkerProps) {
  const { map, ready } = useMapLibre();
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);

  const element = useMemo(() => {
    const el = document.createElement("div");
    el.className = `map-libre-marker${className ? ` ${className}` : ""}`;
    el.style.position = "absolute";
    el.style.willChange = "transform";
    if (zIndex != null) el.style.zIndex = String(zIndex);
    return el;
  }, [className, zIndex]);

  useEffect(() => {
    elRef.current = element;
  }, [element]);

  // Mount + position. The maplibregl.Marker class handles all the projection
  // math + repositioning on pan/zoom internally.
  useEffect(() => {
    if (!map || !ready) return;
    const marker = new maplibregl.Marker({
      element,
      // We center the element on the lng/lat; the `offset` applies in CSS
      // pixels with the same sign convention as our existing anchor.
      offset: [
        element.clientWidth / 2 - anchor[0],
        element.clientHeight / 2 - anchor[1],
      ],
    })
      .setLngLat([lng, lat])
      .addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, element]);

  // Update lng/lat on prop changes.
  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lng, lat]);

  // Recompute offset when anchor or element size shifts.
  useEffect(() => {
    if (!markerRef.current) return;
    markerRef.current.setOffset([
      element.clientWidth / 2 - anchor[0],
      element.clientHeight / 2 - anchor[1],
    ]);
  }, [anchor, element, children]);

  // Click handler — bound at the element level rather than via maplibre.
  useEffect(() => {
    if (!onClick) return;
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      onClick();
    };
    element.addEventListener("click", handler);
    return () => element.removeEventListener("click", handler);
  }, [element, onClick]);

  return createPortal(<>{children}</>, element);
}
