import type { Feature, FeatureCollection } from "geojson";
import type { ApartmentLocationSource, ApartmentMapItem } from "./types";

export type DistrictCenterMap = ReadonlyMap<string, [number, number]>; // [lat, lng]

type ComplexFeatureProperties = {
  id?: string;
  name?: string;
  district?: string;
  neighborhood?: string;
  avgPrice?: number | null;
  households?: number | null;
  buildingCount?: number | null;
  rank?: number | null;
  polygonId?: string | number | null;
  locationSource?: ApartmentLocationSource | null;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pointCoordinates(feature: Feature): [number, number] | null {
  if (feature.geometry.type !== "Point") return null;
  const [lng, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function inferLocationSource(
  props: ComplexFeatureProperties,
  hasPoint: boolean,
  usedFallback: boolean,
): ApartmentLocationSource {
  if (props.locationSource) return props.locationSource;
  if (usedFallback) return "district-centroid";
  if ((props.buildingCount ?? 0) > 0 || props.polygonId != null) return "complex-footprint";
  if (hasPoint) return "geocoded-address";
  return "district-centroid";
}

export function mapComplexFeatureToApartment(
  feature: Feature,
  districtCenters: DistrictCenterMap,
): ApartmentMapItem | null {
  const props = (feature.properties ?? {}) as ComplexFeatureProperties;
  if (!props.id || !props.name || !props.district || !props.neighborhood) return null;

  const point = pointCoordinates(feature);
  const fallback = districtCenters.get(props.district);
  const usedFallback = !point && !!fallback;
  const lng = point?.[0] ?? fallback?.[1];
  const lat = point?.[1] ?? fallback?.[0];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const locationSource = inferLocationSource(props, !!point, usedFallback);
  const polygonId =
    props.polygonId != null
      ? String(props.polygonId)
      : locationSource === "complex-footprint"
        ? props.id
        : undefined;

  return {
    id: props.id,
    name: props.name,
    district: props.district,
    neighborhood: props.neighborhood,
    lat: lat as number,
    lng: lng as number,
    avgPrice: finiteNumber(props.avgPrice),
    households: finiteNumber(props.households) ?? 0,
    buildingCount: finiteNumber(props.buildingCount) ?? 0,
    rank: finiteNumber(props.rank) ?? Number.MAX_SAFE_INTEGER,
    locationSource,
    polygonId,
    centroid: locationSource === "complex-footprint" ? [lng as number, lat as number] : undefined,
  };
}

export function mapComplexCollectionToApartments(
  complexes: FeatureCollection | null | undefined,
  districtCenters: DistrictCenterMap,
): ApartmentMapItem[] {
  if (!complexes) return [];
  return complexes.features
    .map((feature) => mapComplexFeatureToApartment(feature, districtCenters))
    .filter((item): item is ApartmentMapItem => item != null)
    .sort((a, b) => a.rank - b.rank);
}
