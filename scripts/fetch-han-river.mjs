import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as turf from "@turf/turf";

const outDir = path.resolve("public/boundaries");
const outFile = path.join(outDir, "han-river.geojson");
const SEOUL_BBOX = "37.43,126.72,37.64,127.22";
const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const query = `
[out:json][timeout:180];
(
  relation["natural"="water"]["name"~"한강|Hangang|Han River",i](${SEOUL_BBOX});
  relation["waterway"="riverbank"]["name"~"한강|Hangang|Han River",i](${SEOUL_BBOX});
  way["natural"="water"]["name"~"한강|Hangang|Han River",i](${SEOUL_BBOX});
  way["waterway"="riverbank"]["name"~"한강|Hangang|Han River",i](${SEOUL_BBOX});
);
out geom;
`;

function ptKey([lon, lat]) {
  return `${lon.toFixed(7)},${lat.toFixed(7)}`;
}

function ringIsClosed(ring) {
  if (ring.length < 4) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function closeRing(ring) {
  if (ringIsClosed(ring)) return ring;
  return [...ring, ring[0]];
}

function stitchWays(ways) {
  const remaining = ways.map((coords) => coords.slice());
  const rings = [];
  while (remaining.length > 0) {
    let current = remaining.shift();
    if (!current) break;
    let progress = true;
    while (progress && !ringIsClosed(current)) {
      progress = false;
      const tail = current[current.length - 1];
      const head = current[0];
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        const cHead = candidate[0];
        const cTail = candidate[candidate.length - 1];
        if (ptKey(cHead) === ptKey(tail)) {
          current = current.concat(candidate.slice(1));
        } else if (ptKey(cTail) === ptKey(tail)) {
          current = current.concat(candidate.slice(0, -1).reverse());
        } else if (ptKey(cTail) === ptKey(head)) {
          current = candidate.slice(0, -1).concat(current);
        } else if (ptKey(cHead) === ptKey(head)) {
          current = candidate.slice(1).reverse().concat(current);
        } else {
          continue;
        }
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (current.length >= 4) rings.push(closeRing(current));
  }
  return rings;
}

function wayCoords(way) {
  if (!Array.isArray(way.geometry)) return null;
  const coords = way.geometry.map((node) => [node.lon, node.lat]);
  return coords.length >= 4 ? closeRing(coords) : null;
}

function relationPolygons(relation) {
  const outerWays = [];
  const innerWays = [];
  for (const member of relation.members ?? []) {
    if (member.type !== "way" || !Array.isArray(member.geometry)) continue;
    const coords = member.geometry.map((node) => [node.lon, node.lat]);
    if (coords.length < 2) continue;
    if (member.role === "inner") innerWays.push(coords);
    else outerWays.push(coords);
  }
  const outerRings = stitchWays(outerWays);
  const innerRings = stitchWays(innerWays);
  return outerRings.map((outer) => {
    const outerPoly = turf.polygon([outer]);
    const holes = innerRings.filter((inner) => turf.booleanPointInPolygon(turf.point(inner[0]), outerPoly));
    return [outer, ...holes];
  });
}

async function overpass() {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "budongsan-map-fetch/0.1",
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      console.warn(`${endpoint} failed: ${error.message}`);
    }
  }
  throw lastError ?? new Error("All Overpass endpoints failed");
}

function isUsefulHanRiverPolygon(feature) {
  const [west, south, east, north] = turf.bbox(feature);
  const area = turf.area(feature);
  const center = turf.centerOfMass(feature).geometry.coordinates;
  const looksLikeMainRiver =
    east - west > 0.03 &&
    north - south > 0.003 &&
    center[1] > 37.46 &&
    center[1] < 37.61;
  return area > 180_000 && looksLikeMainRiver;
}

await mkdir(outDir, { recursive: true });
console.log("Fetching Han River polygons from Overpass...");
const json = await overpass();
const polygons = [];

for (const element of json.elements ?? []) {
  if (element.type === "relation") {
    polygons.push(...relationPolygons(element));
    continue;
  }
  if (element.type === "way") {
    const coords = wayCoords(element);
    if (coords) polygons.push([coords]);
  }
}

const features = polygons
  .map((coordinates, index) => ({
    type: "Feature",
    properties: { id: `han-river-${index}`, name: "한강" },
    geometry: { type: "Polygon", coordinates },
  }))
  .filter(isUsefulHanRiverPolygon);

if (features.length === 0) {
  throw new Error("No Han River polygons survived filtering");
}

const fc = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "han-river", name: "한강", source: "openstreetmap-overpass" },
      geometry:
        features.length === 1
          ? features[0].geometry
          : { type: "MultiPolygon", coordinates: features.map((feature) => feature.geometry.coordinates) },
    },
  ],
};

await writeFile(outFile, JSON.stringify(fc));
const bbox = turf.bbox(fc);
console.log(`Wrote ${outFile}`);
console.log(`Han River polygons: ${features.length}, bbox: ${bbox.map((value) => value.toFixed(5)).join(", ")}`);
