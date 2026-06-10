// Static boundary data loaders.
//
// We only ship 자치구 (districts) and 행정동 (dongs) GeoJSON — every other
// visual layer (roads, buildings, parks, river, neighbouring cities) comes
// for free from CARTO's Positron raster tiles.
// Complex points populate the HTML price chip markers.

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { withBase } from "../lib/base";
export type { FeatureCollection };

export type BoundaryType = "district" | "dong";

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
  districts: BoundaryFeature[];
  dongs: BoundaryFeature[];
};

async function loadFeatureCollection(url: string, level: BoundaryType): Promise<BoundaryFeature[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const data = (await response.json()) as FeatureCollection<Polygon | MultiPolygon, BoundaryProperties>;
  return data.features.map((feature) => ({ ...feature, level }));
}

export async function loadBoundaries(): Promise<BoundarySet> {
  const [districts, dongs] = await Promise.all([
    loadFeatureCollection(withBase("boundaries/seoul-sigg.geojson"), "district"),
    loadFeatureCollection(withBase("boundaries/seoul-dong.geojson"), "dong"),
  ]);
  return { districts, dongs };
}

export function centerOf(feature: BoundaryFeature): [number, number] {
  return feature.properties.center;
}

/** Pre-ranked complex points (used to populate price chip markers). */
export async function loadComplexes(): Promise<FeatureCollection> {
  const response = await fetch(withBase("boundaries/seoul-complexes.geojson"));
  if (!response.ok) throw new Error(`Failed to load complexes: ${response.status}`);
  return response.json();
}
