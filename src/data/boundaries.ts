// Static boundary data loaders.
//
// Boundaries, Han river and pre-ranked complex points are loaded once on
// startup (used for click handlers, mask geometry, and HTML price chip
// markers). Every other visual layer (parks / roads-minor / buildings /
// dongs etc.) is served as vector tiles from `/tiles/{z}/{x}/{y}.pbf` —
// see scripts/build-vector-tiles.mjs.

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
export type { FeatureCollection };

export type BoundaryType = "city" | "district" | "dong";

export type BoundaryProperties = {
  id: string;
  name: string;
  center: [number, number];
  sido?: string;
  district?: string;
};

export type BoundaryFeature = Feature<Polygon | MultiPolygon, BoundaryProperties> & {
  type: "Feature";
  level: BoundaryType;
};

export type BoundarySelection = {
  id: string;
  name: string;
  type: BoundaryType;
};

export type BoundarySet = {
  city: BoundaryFeature[];
  districts: BoundaryFeature[];
  dongs: BoundaryFeature[];
  neighbors: BoundaryFeature[];
};

async function loadFeatureCollection(url: string, level: BoundaryType): Promise<BoundaryFeature[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const data = (await response.json()) as FeatureCollection<Polygon | MultiPolygon, BoundaryProperties>;
  return data.features.map((feature) => ({ ...feature, level }));
}

export async function loadBoundaries(): Promise<BoundarySet> {
  const [city, districts, dongs, neighbors] = await Promise.all([
    loadFeatureCollection("/boundaries/seoul-city.geojson", "city"),
    loadFeatureCollection("/boundaries/seoul-sigg.geojson", "district"),
    loadFeatureCollection("/boundaries/seoul-dong.geojson", "dong"),
    loadFeatureCollection("/boundaries/capital-sigg.geojson", "district"),
  ]);
  return { city, districts, dongs, neighbors };
}

export function centerOf(feature: BoundaryFeature): [number, number] {
  return feature.properties.center;
}

export async function loadHanRiver(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const response = await fetch("/boundaries/han-river.geojson");
  if (!response.ok) throw new Error(`Failed to load Han river: ${response.status}`);
  return response.json();
}

/** Pre-ranked complex points (used to populate price chip markers). */
export async function loadComplexes(): Promise<FeatureCollection> {
  const response = await fetch("/boundaries/seoul-complexes.geojson");
  if (!response.ok) throw new Error(`Failed to load complexes: ${response.status}`);
  return response.json();
}
