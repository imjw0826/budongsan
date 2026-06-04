import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("public/boundaries");
await mkdir(outDir, { recursive: true });

const SEOUL_BBOX = "37.42,126.7,37.7,127.2";

const ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function overpass(query) {
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "budongsan-map-fetch/0.2",
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) {
        lastError = new Error(`${endpoint} HTTP ${response.status}`);
        console.warn(lastError.message);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`${endpoint} failed: ${error.message}`);
    }
  }
  throw lastError ?? new Error("All Overpass endpoints failed");
}

function waysToLineFeatures(json, propertyFn) {
  const features = [];
  for (const element of json.elements ?? []) {
    if (element.type !== "way" || !Array.isArray(element.geometry)) continue;
    const coords = element.geometry.map((node) => [node.lon, node.lat]);
    if (coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: propertyFn(element),
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return features;
}

function waysToPolygonFeatures(json, propertyFn) {
  const features = [];
  for (const element of json.elements ?? []) {
    if (element.type !== "way" || !Array.isArray(element.geometry)) continue;
    const coords = element.geometry.map((node) => [node.lon, node.lat]);
    if (coords.length < 3) continue;
    if (
      coords[0][0] !== coords[coords.length - 1][0] ||
      coords[0][1] !== coords[coords.length - 1][1]
    ) {
      coords.push(coords[0]);
    }
    features.push({
      type: "Feature",
      properties: propertyFn(element),
      geometry: { type: "Polygon", coordinates: [coords] },
    });
  }
  return features;
}

console.log("Fetching local roads…");
const roadsJson = await overpass(
  `[out:json][timeout:120];way["highway"~"secondary|tertiary"](${SEOUL_BBOX});out geom;`,
);
const minorRoadFeatures = waysToLineFeatures(roadsJson, (way) => ({
  id: way.id,
  highway: way.tags?.highway ?? null,
  name: way.tags?.name ?? null,
}));
await writeFile(
  path.join(outDir, "seoul-roads-minor.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: minorRoadFeatures }),
);
console.log(`Local roads: ${minorRoadFeatures.length}`);

console.log("Fetching parks…");
const parksJson = await overpass(
  `[out:json][timeout:120];(way["leisure"="park"](${SEOUL_BBOX});way["leisure"="garden"](${SEOUL_BBOX}););out geom;`,
);
const allParkFeatures = waysToPolygonFeatures(parksJson, (way) => ({
  id: way.id,
  name: way.tags?.name ?? null,
  leisure: way.tags?.leisure ?? null,
}));
function polygonBboxArea(feature) {
  const ring = feature.geometry.coordinates[0];
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return (maxLng - minLng) * (maxLat - minLat);
}
const parkFeatures = allParkFeatures.filter((f) => polygonBboxArea(f) > 0.0000004);
const parksFc = { type: "FeatureCollection", features: parkFeatures };
await writeFile(path.join(outDir, "seoul-parks.geojson"), JSON.stringify(parksFc));
console.log(`Parks: ${parkFeatures.length} (filtered from ${allParkFeatures.length})`);

console.log(`Wrote outline data to ${outDir}`);
