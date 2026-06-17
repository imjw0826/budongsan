// LeafletMap — single component owning the Leaflet map instance.
//
// Stack (backrooms.kr-style):
//   • CARTO Positron raster tiles  (light, line-art look, OSM-derived)
//   • Optional district / dong outline layers (clickable)
//   • HTML divIcon price chip markers for apartments
//   • flyTo + viewport/zoom change callbacks
//
// All vector tile / WebGL machinery removed. CARTO renders everything below
// our overlays as PNG tiles; we only draw boundary outlines and chips.

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { BoundaryFeature } from "../../data/boundaries";
import type { MapViewport } from "../viewport";
import type { ApartmentMapItem } from "../types";

const CARTO_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

const SEOUL_CENTER: L.LatLngTuple = [37.5532, 126.99];

function formatPriceValue(value: number) {
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}

/** "13.1~16억" — 최소·최대가 같으면 단일 값, 없으면 평균으로 폴백. */
function formatPriceRange(c: { minPrice: number | null; maxPrice: number | null; avgPrice: number | null }) {
  const { minPrice, maxPrice, avgPrice } = c;
  if (minPrice != null && maxPrice != null && maxPrice > 0) {
    if (formatPriceValue(minPrice) === formatPriceValue(maxPrice)) return `${formatPriceValue(maxPrice)}억`;
    return `${formatPriceValue(minPrice)}~${formatPriceValue(maxPrice)}억`;
  }
  return `${formatPriceValue(avgPrice ?? 0)}억`;
}

export type LeafletMapProps = {
  districts: BoundaryFeature[] | null;
  dongs: BoundaryFeature[];                 // already filtered to focused district
  selectedDistrictId: string | null;
  selectedDongId: string | null;
  apartments: ApartmentMapItem[];
  flyTarget: { center: [number, number]; zoom: number } | null;
  onDistrictClick: (feature: BoundaryFeature) => void;
  onDongClick: (feature: BoundaryFeature) => void;
  onRegionHover: (name: string | null) => void;
  onApartmentSelect: (complex: ApartmentMapItem) => void;
  onViewportChange: (viewport: MapViewport) => void;
  onZoomChange: (zoom: number) => void;
};

export function LeafletMap({
  districts,
  dongs,
  selectedDistrictId,
  selectedDongId,
  apartments,
  flyTarget,
  onDistrictClick,
  onDongClick,
  onRegionHover,
  onApartmentSelect,
  onViewportChange,
  onZoomChange,
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const districtLayerRef = useRef<L.GeoJSON | null>(null);
  const dongLayerRef = useRef<L.GeoJSON | null>(null);
  const districtLabelLayerRef = useRef<L.LayerGroup | null>(null);
  const dongLabelLayerRef = useRef<L.LayerGroup | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);

  // Keep latest callbacks reachable from imperative Leaflet handlers without
  // re-binding listeners every render.
  const cb = useRef({
    onDistrictClick,
    onDongClick,
    onRegionHover,
    onApartmentSelect,
    onViewportChange,
    onZoomChange,
  });
  useEffect(() => {
    cb.current = {
      onDistrictClick,
      onDongClick,
      onRegionHover,
      onApartmentSelect,
      onViewportChange,
      onZoomChange,
    };
  }, [
    onApartmentSelect,
    onDistrictClick,
    onDongClick,
    onRegionHover,
    onViewportChange,
    onZoomChange,
  ]);

  // ---- Init map once ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: SEOUL_CENTER,
      zoom: 11,
      minZoom: 10,
      maxZoom: 18,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    });

    L.tileLayer(CARTO_LIGHT, {
      attribution: CARTO_ATTR,
      subdomains: "abcd",
      maxZoom: 20,
    }).addTo(map);

    const markerLayer = L.layerGroup().addTo(map);
    markerLayerRef.current = markerLayer;

    const emitViewport = () => {
      const b = map.getBounds();
      cb.current.onViewportChange({
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest(),
      });
      cb.current.onZoomChange(map.getZoom());
    };

    map.on("moveend", emitViewport);
    map.on("zoomend", emitViewport);
    emitViewport();

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      districtLayerRef.current = null;
      dongLayerRef.current = null;
      districtLabelLayerRef.current = null;
      dongLabelLayerRef.current = null;
      markerLayerRef.current = null;
    };
  }, []);

  // ---- Districts layer ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !districts) return;
    districtLayerRef.current?.remove();
    const layer = L.geoJSON(
      { type: "FeatureCollection", features: districts } as never,
      {
        style: (feature) => {
          const id = String((feature as BoundaryFeature).properties.id);
          const isSelected = id === selectedDistrictId;
          return {
            color: isSelected ? "#0d6fff" : "#1a1a1a",
            weight: isSelected ? 1.6 : 0.8,
            opacity: 0.85,
            fillColor: "#000",
            fillOpacity: isSelected ? 0.02 : 0.0,
          };
        },
        onEachFeature: (feature, lyr) => {
          const f = feature as BoundaryFeature;
          lyr.on("click", (event) => {
            L.DomEvent.stopPropagation(event);
            cb.current.onDistrictClick(f);
          });
          lyr.on("mouseover", () => {
            cb.current.onRegionHover(f.properties.name);
            if (String(f.properties.id) !== selectedDistrictId) {
              (lyr as L.Path).setStyle({ weight: 1.4, opacity: 1 });
            }
          });
          lyr.on("mouseout", () => {
            cb.current.onRegionHover(null);
            if (String(f.properties.id) !== selectedDistrictId) {
              (lyr as L.Path).setStyle({ weight: 0.8, opacity: 0.85 });
            }
          });
        },
      },
    );
    layer.addTo(map);
    districtLayerRef.current = layer;
    return () => {
      layer.remove();
    };
  }, [districts, selectedDistrictId]);

  // ---- Dongs layer (only when a district is selected) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    dongLayerRef.current?.remove();
    dongLayerRef.current = null;
    if (!selectedDistrictId || dongs.length === 0) return;
    const layer = L.geoJSON(
      { type: "FeatureCollection", features: dongs } as never,
      {
        style: (feature) => {
          const id = String((feature as BoundaryFeature).properties.id);
          const isSelected = id === selectedDongId;
          return {
            color: isSelected ? "#0d6fff" : "#5a5a5a",
            weight: isSelected ? 1.4 : 0.6,
            opacity: 0.7,
            fillColor: "#000",
            fillOpacity: isSelected ? 0.03 : 0.0,
            dashArray: isSelected ? undefined : "3,3",
          };
        },
        onEachFeature: (feature, lyr) => {
          const f = feature as BoundaryFeature;
          lyr.on("click", (event) => {
            L.DomEvent.stopPropagation(event);
            cb.current.onDongClick(f);
          });
          lyr.on("mouseover", () => cb.current.onRegionHover(f.properties.name));
          lyr.on("mouseout", () => cb.current.onRegionHover(null));
        },
      },
    );
    layer.addTo(map);
    dongLayerRef.current = layer;
    return () => {
      layer.remove();
    };
  }, [dongs, selectedDistrictId, selectedDongId]);

  // ---- District name labels (overview only — no district selected) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    districtLabelLayerRef.current?.remove();
    districtLabelLayerRef.current = null;
    if (!districts || selectedDistrictId) return;
    const group = L.layerGroup();
    for (const f of districts) {
      const center = f.properties.center; // [lat, lng]
      if (!center) continue;
      const icon = L.divIcon({
        className: "district-label-shell",
        html: `<span class="district-label">${escapeHtml(f.properties.name)}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const marker = L.marker(center, { icon, keyboard: false });
      marker.on("click", () => cb.current.onDistrictClick(f));
      marker.on("mouseover", () => cb.current.onRegionHover(f.properties.name));
      marker.on("mouseout", () => cb.current.onRegionHover(null));
      marker.addTo(group);
    }
    group.addTo(map);
    districtLabelLayerRef.current = group;
    return () => {
      group.remove();
    };
  }, [districts, selectedDistrictId]);

  // ---- Dong name labels (when a district is selected) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    dongLabelLayerRef.current?.remove();
    dongLabelLayerRef.current = null;
    if (!selectedDistrictId || dongs.length === 0) return;
    const group = L.layerGroup();
    for (const f of dongs) {
      const center = f.properties.center; // [lat, lng]
      if (!center) continue;
      const isSelected = String(f.properties.id) === selectedDongId;
      const icon = L.divIcon({
        className: "dong-label-shell",
        html: `<span class="dong-label${isSelected ? " selected" : ""}">${escapeHtml(f.properties.name)}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const marker = L.marker(center, { icon, keyboard: false });
      marker.on("click", () => cb.current.onDongClick(f));
      marker.on("mouseover", () => cb.current.onRegionHover(f.properties.name));
      marker.on("mouseout", () => cb.current.onRegionHover(null));
      marker.addTo(group);
    }
    group.addTo(map);
    dongLabelLayerRef.current = group;
    return () => {
      group.remove();
    };
  }, [dongs, selectedDistrictId, selectedDongId]);

  // ---- Apartment price chip markers ----
  useEffect(() => {
    const layer = markerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const c of apartments) {
      const html = `
        <button class="price-marker" type="button">
          <span>${escapeHtml(c.name)}</span>
          <strong>${formatPriceRange(c)}</strong>
        </button>
        <span class="price-marker-arrow"></span>
      `;
      // 칩 36px + 화살표 5px = 41px. 화살표 끝점이 박스 하단 중앙 = 앵커.
      const icon = L.divIcon({
        className: "price-marker-shell",
        html,
        iconSize: [98, 41],
        iconAnchor: [49, 41],
      });
      const marker = L.marker([c.lat, c.lng], {
        icon,
        keyboard: false,
        riseOnHover: true,
      });
      marker.on("click", () => cb.current.onApartmentSelect(c));
      marker.addTo(layer);
    }
  }, [apartments]);

  // ---- flyTo ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTarget) return;
    map.flyTo(flyTarget.center, flyTarget.zoom, {
      animate: true,
      duration: 0.6,
      easeLinearity: 0.25,
    });
  }, [flyTarget]);

  return <div ref={containerRef} className="leaflet-stage" />;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default LeafletMap;
