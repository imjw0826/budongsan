// Single component that registers ALL static + dynamic vector layers with
// MapLibre. The data source is now a **vector tile pyramid** generated
// offline by `scripts/build-vector-tiles.mjs` and served as static .pbf
// files from `/tiles/{z}/{x}/{y}.pbf`.
//
// MapLibre handles per-tile fetching, LOD selection, and rendering. We just
// declare layers that point at the source-layer name produced by the
// build script (`city`, `districts`, `dongs`, `neighbors`, `hanRiver`,
// `parks`, `roadsMinor`, `buildings`, `complexes`).

import { useEffect, useMemo } from "react";
import type {
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  Map as MlMap,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { getZoomLayerVisibility } from "../constants";
import { useMapLibre } from "./MapLibreContext";

// Source id is shared by every layer below.
const VECTOR_SOURCE = "seoul-vectors";

/** zoom range matches scripts/build-vector-tiles.mjs */
const SOURCE_MIN_ZOOM = 6;
const SOURCE_MAX_ZOOM = 14;
const SEOUL_TILE_BOUNDS: [number, number, number, number] = [126.7, 37.4, 127.25, 37.72];

export type MapLibreLayerStackProps = {
  layerVisibility: ReturnType<typeof getZoomLayerVisibility>;
  /** Pre-computed evenodd polygon that fills everything outside Seoul. */
  outsideSeoulMask: FeatureCollection | null;
  selectedDistrictId: string | null;
  selectedDongId: string | null;
  hoveredDistrictId: string | null;
  /** District name used to filter dong rendering to the active district only. */
  selectedDistrictName: string | null;
  onDistrictClick: (id: string) => void;
  onDistrictHover: (id: string | null) => void;
  onDongClick: (id: string) => void;
};

function ensureVectorSource(map: MlMap) {
  if (map.getSource(VECTOR_SOURCE)) return;
  map.addSource(VECTOR_SOURCE, {
    type: "vector",
    tiles: [`${window.location.origin}/tiles/{z}/{x}/{y}.pbf`],
    minzoom: SOURCE_MIN_ZOOM,
    maxzoom: SOURCE_MAX_ZOOM,
    bounds: SEOUL_TILE_BOUNDS,
    promoteId: "id",
  });
}

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

function ensureOutsideMaskSource(map: MlMap, data: FeatureCollection | null) {
  // Always create the source so the mask layer can attach even before
  // boundaries finish loading. Real geometry is pushed by setData() later.
  const existing = map.getSource("outside-mask");
  if (existing) {
    (existing as maplibregl.GeoJSONSource).setData(data ?? EMPTY_FC);
    return;
  }
  map.addSource("outside-mask", {
    type: "geojson",
    data: data ?? EMPTY_FC,
  });
}

type LayerInit = {
  id: string;
  type: "fill" | "line";
  sourceLayer?: string;
  source?: string;
  paint: FillLayerSpecification["paint"] | LineLayerSpecification["paint"];
  layout?: FillLayerSpecification["layout"] | LineLayerSpecification["layout"];
  filter?: ExpressionSpecification;
  minzoom?: number;
};

/**
 * z-order is the array order — layers added later paint on top.
 * IDs are stable so we can update paint props without re-adding.
 */
function buildLayerSpecs(
  hoveredDistrictId: string | null,
  selectedDistrictId: string | null,
  selectedDongId: string | null,
  selectedDistrictName: string | null,
): LayerInit[] {
  const districtMatch = (id: string | null) =>
    id == null ? ["==", 1, 0] : ["==", ["get", "id"], id];
  const districtHighlight = (a: string | null, b: string | null): ExpressionSpecification =>
    a == null && b == null
      ? (["==", 1, 0] as unknown as ExpressionSpecification)
      : ([
          "any",
          ...(a ? [["==", ["get", "id"], a]] : []),
          ...(b ? [["==", ["get", "id"], b]] : []),
        ] as unknown as ExpressionSpecification);

  return [
    // Han river — fill + outline
    {
      id: "han-river-fill",
      type: "fill",
      sourceLayer: "hanRiver",
      paint: { "fill-color": "#7cc4ec", "fill-opacity": 1 },
    },
    {
      id: "han-river-line",
      type: "line",
      sourceLayer: "hanRiver",
      paint: { "line-color": "#5fb1e3", "line-width": 1.5 },
    },
    // Parks — same min-zoom as buildings/roads so detail layers fade in together.
    {
      id: "parks-fill",
      type: "fill",
      sourceLayer: "parks",
      minzoom: 13,
      paint: { "fill-color": "#cae5b1", "fill-opacity": 0.85 },
    },
    {
      id: "parks-line",
      type: "line",
      sourceLayer: "parks",
      minzoom: 13,
      paint: { "line-color": "#5a8a4a", "line-width": 0.6 },
    },
    // Buildings
    {
      id: "buildings-fill",
      type: "fill",
      sourceLayer: "buildings",
      minzoom: 13,
      paint: {
        "fill-color": [
          "case",
          ["!=", ["get", "complexId"], null],
          "#f4f5eb",
          "#eef1e7",
        ] as never,
        "fill-opacity": 0.94,
      },
    },
    {
      id: "buildings-line",
      type: "line",
      sourceLayer: "buildings",
      minzoom: 13,
      paint: {
        "line-color": [
          "case",
          ["!=", ["get", "complexId"], null],
          "#111d1b",
          "#2d3936",
        ] as never,
        "line-width": [
          "case",
          ["!=", ["get", "complexId"], null],
          1.5,
          1.2,
        ] as never,
      },
    },
    // Minor roads — same zoom gate as parks/buildings.
    {
      id: "roads-minor-line",
      type: "line",
      sourceLayer: "roadsMinor",
      minzoom: 13,
      paint: { "line-color": "#3f4b4e", "line-opacity": 0.88, "line-width": 1.35 },
      layout: { "line-join": "round", "line-cap": "round" } as LineLayerSpecification["layout"],
    },
    // Outside-Seoul mask — comes from a GeoJSON source (computed client-side)
    {
      id: "outside-mask-fill",
      type: "fill",
      source: "outside-mask",
      paint: { "fill-color": "#f7f7f4", "fill-opacity": 1, "fill-antialias": true },
    },
    // Neighbor districts
    {
      id: "neighbors-line",
      type: "line",
      sourceLayer: "neighbors",
      paint: { "line-color": "#8a9092", "line-width": 1 },
    },
    // Districts — fill highlights hover, line emphasises hover/selected
    {
      id: "districts-fill",
      type: "fill",
      sourceLayer: "districts",
      paint: {
        "fill-color": [
          "case",
          districtMatch(hoveredDistrictId),
          "#e5f1c9",
          "#ffffff",
        ] as never,
        "fill-opacity": [
          "case",
          districtMatch(hoveredDistrictId),
          0.52,
          0,
        ] as never,
      },
    },
    {
      id: "districts-line",
      type: "line",
      sourceLayer: "districts",
      paint: {
        "line-color": [
          "case",
          districtHighlight(hoveredDistrictId, selectedDistrictId) as never,
          "#111111",
          "#3a4042",
        ] as never,
        "line-width": [
          "case",
          districtHighlight(hoveredDistrictId, selectedDistrictId) as never,
          3.2,
          1.6,
        ] as never,
      },
      layout: { "line-join": "round" } as LineLayerSpecification["layout"],
    },
    // Dongs — restricted to the selected district (avoid painting all 425)
    {
      id: "dongs-fill",
      type: "fill",
      sourceLayer: "dongs",
      filter: [
        "==",
        ["get", "district"],
        selectedDistrictName ?? "__no_district_selected__",
      ] as ExpressionSpecification,
      paint: {
        "fill-color": "#dcebc8",
        "fill-opacity": [
          "case",
          districtMatch(selectedDongId),
          0.14,
          0,
        ] as never,
      },
    },
    {
      id: "dongs-line",
      type: "line",
      sourceLayer: "dongs",
      filter: [
        "==",
        ["get", "district"],
        selectedDistrictName ?? "__no_district_selected__",
      ] as ExpressionSpecification,
      paint: {
        "line-color": [
          "case",
          districtMatch(selectedDongId),
          "#1a1a1a",
          "#6a7173",
        ] as never,
        "line-width": [
          "case",
          districtMatch(selectedDongId),
          2.2,
          1,
        ] as never,
      },
      layout: { "line-join": "round" } as LineLayerSpecification["layout"],
    },
  ];
}

export function MapLibreLayerStack({
  layerVisibility,
  outsideSeoulMask,
  selectedDistrictId,
  selectedDongId,
  hoveredDistrictId,
  selectedDistrictName,
  onDistrictClick,
  onDistrictHover,
  onDongClick,
}: MapLibreLayerStackProps) {
  const { map, ready } = useMapLibre();

  const layerSpecs = useMemo(
    () =>
      buildLayerSpecs(
        hoveredDistrictId,
        selectedDistrictId,
        selectedDongId,
        selectedDistrictName,
      ),
    [hoveredDistrictId, selectedDistrictId, selectedDongId, selectedDistrictName],
  );

  // Add sources + initial layers once.
  useEffect(() => {
    if (!map || !ready) return;
    ensureVectorSource(map);
    ensureOutsideMaskSource(map, outsideSeoulMask);

    for (const spec of layerSpecs) {
      if (map.getLayer(spec.id)) continue;
      const sourceId = spec.source ?? VECTOR_SOURCE;
      map.addLayer({
        id: spec.id,
        type: spec.type,
        source: sourceId,
        ...(spec.sourceLayer ? { "source-layer": spec.sourceLayer } : {}),
        ...(spec.minzoom ? { minzoom: spec.minzoom } : {}),
        ...(spec.filter ? { filter: spec.filter } : {}),
        paint: spec.paint as never,
        ...(spec.layout ? { layout: spec.layout as never } : {}),
      } as never);
    }
    return () => {
      const style = map.getStyle();
      if (!style) return;
      for (const spec of layerSpecs) {
        if (map.getLayer(spec.id)) map.removeLayer(spec.id);
      }
      if (map.getSource("outside-mask")) map.removeSource("outside-mask");
      if (map.getSource(VECTOR_SOURCE)) map.removeSource(VECTOR_SOURCE);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready]);

  // Push outside-mask updates when it changes.
  useEffect(() => {
    if (!map || !ready || !outsideSeoulMask) return;
    const src = map.getSource("outside-mask");
    if (src) (src as maplibregl.GeoJSONSource).setData(outsideSeoulMask);
  }, [map, ready, outsideSeoulMask]);

  // Push paint/filter updates when expressions change.
  useEffect(() => {
    if (!map || !ready) return;
    for (const spec of layerSpecs) {
      if (!map.getLayer(spec.id)) continue;
      if (spec.paint) {
        for (const [key, value] of Object.entries(spec.paint)) {
          map.setPaintProperty(spec.id, key as never, value as never);
        }
      }
      if (spec.filter !== undefined) {
        map.setFilter(spec.id, spec.filter as never);
      }
    }
  }, [map, ready, layerSpecs]);

  // Hide entire layer groups when zoom-tier visibility says so.
  useEffect(() => {
    if (!map || !ready) return;
    const setVisible = (id: string, visible: boolean) => {
      if (!map.getLayer(id)) return;
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    };
    setVisible("han-river-fill", layerVisibility.showHanRiver);
    setVisible("han-river-line", layerVisibility.showHanRiver);
    setVisible("parks-fill", layerVisibility.showParks);
    setVisible("parks-line", layerVisibility.showParks);
    setVisible("buildings-fill", layerVisibility.showBuildingFootprints);
    setVisible("buildings-line", layerVisibility.showBuildingFootprints);
    setVisible("roads-minor-line", layerVisibility.showMinorRoads);
    setVisible("dongs-fill", layerVisibility.showDongBoundaries);
    setVisible("dongs-line", layerVisibility.showDongBoundaries);
  }, [map, ready, layerVisibility]);

  // Click + hover bindings for districts and dongs.
  useEffect(() => {
    if (!map || !ready) return;
    const onClickDistrict = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const id = f?.properties?.id;
      if (id != null) onDistrictClick(String(id));
    };
    const onHoverDistrict = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const id = f?.properties?.id;
      onDistrictHover(id != null ? String(id) : null);
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeaveDistrict = () => {
      onDistrictHover(null);
      map.getCanvas().style.cursor = "";
    };
    const onClickDong = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const id = f?.properties?.id;
      if (id != null) onDongClick(String(id));
    };

    map.on("click", "districts-fill", onClickDistrict);
    map.on("mousemove", "districts-fill", onHoverDistrict);
    map.on("mouseleave", "districts-fill", onLeaveDistrict);
    map.on("click", "dongs-fill", onClickDong);
    return () => {
      map.off("click", "districts-fill", onClickDistrict);
      map.off("mousemove", "districts-fill", onHoverDistrict);
      map.off("mouseleave", "districts-fill", onLeaveDistrict);
      map.off("click", "dongs-fill", onClickDong);
    };
  }, [map, ready, onDistrictClick, onDistrictHover, onDongClick]);

  return null;
}
