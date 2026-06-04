import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { BoundaryFeature } from "../../data/boundaries";

/**
 * Builds an evenodd polygon that fills everything outside the Seoul city
 * boundary with a flat colour. Returned as a FeatureCollection so it can be
 * fed directly to the SVG renderer.
 */
export function createOutsideSeoulMask(
  city: BoundaryFeature[],
): FeatureCollection<Polygon> | null {
  // Reverse the city ring so it winds opposite to the outer ring. GeoJSON
  // RFC 7946 §3.1.6 requires holes to be clockwise (outer is CCW). MapLibre
  // honours winding to detect holes; without this the mask paints over Seoul.
  const holes: number[][][] = [];
  const pushRing = (ring: number[][]) => holes.push([...ring].reverse());
  for (const feature of city) {
    const geometry = feature.geometry as Polygon | MultiPolygon;
    if (geometry.type === "Polygon") {
      pushRing(geometry.coordinates[0]);
    } else {
      for (const polygon of geometry.coordinates) {
        pushRing(polygon[0]);
      }
    }
  }

  if (holes.length === 0) return null;

  // Outer ring traced CLOCKWISE in geographic coords (south→west→north→east→south)
  // so that after Mercator's Y-flip the SVG path winding is consistent.
  const outer = [
    [150, 25],
    [100, 25],
    [100, 50],
    [150, 50],
    [150, 25],
  ];

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "outside-seoul-mask" },
        geometry: {
          type: "Polygon",
          coordinates: [outer, ...holes],
        },
      },
    ],
  };
}
