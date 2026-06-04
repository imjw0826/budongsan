// Drop-in equivalent of src/map/layers/MarkerOverlayLayers.tsx but using
// maplibregl.Marker for positioning (no manual transform math).
//
// Click an apartment chip → navigate directly to /complex/:id (no popup card).

import { type BoundaryFeature, centerOf } from "../../data/boundaries";
import {
  MAX_VISIBLE_DISTRICT_LABELS,
  type getZoomLayerVisibility,
} from "../constants";
import type { ApartmentMapItem } from "../types";
import { MapLibreMarker } from "./MapLibreMarker";

function formatPrice(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}억`;
}

export type MapLibreMarkerOverlayProps = {
  layerVisibility: ReturnType<typeof getZoomLayerVisibility>;
  districts: BoundaryFeature[] | null;
  selectedDistrict: BoundaryFeature | null;
  selectedDong: BoundaryFeature | null;
  visibleDongLabels: BoundaryFeature[];
  apartmentRegion: BoundaryFeature | null;
  apartments: ApartmentMapItem[];
  onDistrictClick: (feature: BoundaryFeature) => void;
  onDongClick: (feature: BoundaryFeature) => void;
  onApartmentSelect: (complex: ApartmentMapItem) => void;
};

export function MapLibreMarkerOverlay({
  layerVisibility,
  districts,
  selectedDistrict,
  selectedDong,
  visibleDongLabels,
  apartmentRegion,
  apartments,
  onDistrictClick,
  onDongClick,
  onApartmentSelect,
}: MapLibreMarkerOverlayProps) {
  return (
    <>
      {districts &&
        !selectedDistrict &&
        layerVisibility.showDistrictLabels &&
        districts.slice(0, MAX_VISIBLE_DISTRICT_LABELS).map((feature) => {
          const [lat, lng] = centerOf(feature);
          const width = Math.max(80, feature.properties.name.length * 13);
          return (
            <MapLibreMarker
              key={feature.properties.id}
              lng={lng}
              lat={lat}
              anchor={[width / 2, 12]}
              className="district-label-shell"
              onClick={() => onDistrictClick(feature)}
            >
              <button
                className="district-label"
                type="button"
                draggable={false}
                style={{ minWidth: width }}
                onPointerDown={(event) => event.preventDefault()}
              >
                {feature.properties.name}
              </button>
            </MapLibreMarker>
          );
        })}

      {selectedDistrict &&
        !selectedDong &&
        layerVisibility.showDongLabels &&
        visibleDongLabels.map((feature) => {
          const [lat, lng] = centerOf(feature);
          return (
            <MapLibreMarker
              key={feature.properties.id}
              lng={lng}
              lat={lat}
              anchor={[36, 10]}
              className="dong-label-shell"
              onClick={() => onDongClick(feature)}
            >
              <button className="dong-label" type="button">
                {feature.properties.name}
              </button>
            </MapLibreMarker>
          );
        })}

      {apartmentRegion &&
        layerVisibility.showApartmentLabels &&
        apartments.map((complex) => (
          <MapLibreMarker
            key={complex.id}
            lng={complex.lng}
            lat={complex.lat}
            anchor={[48, 40]}
            className="price-marker-shell"
            onClick={() => onApartmentSelect(complex)}
          >
            <button className="price-marker" type="button">
              <span>{complex.name}</span>
              <strong>{formatPrice(complex.avgPrice ?? 0)}</strong>
            </button>
            <span className="price-marker-arrow" />
          </MapLibreMarker>
        ))}
    </>
  );
}
