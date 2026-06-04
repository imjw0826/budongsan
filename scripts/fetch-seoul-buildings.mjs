import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("public/boundaries");
await mkdir(outDir, { recursive: true });

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
          "User-Agent": "budongsan-map-fetch/0.3",
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

// Split Seoul into 4 quadrants so each query stays within Overpass limits.
const TILES = [
  { name: "NW", bbox: "37.55,126.7,37.7,126.97" },
  { name: "NE", bbox: "37.55,126.97,37.7,127.2" },
  { name: "SW", bbox: "37.42,126.7,37.55,126.97" },
  { name: "SE", bbox: "37.42,126.97,37.55,127.2" },
];

const allFeatures = [];
const seen = new Set();

for (const tile of TILES) {
  console.log(`Fetching apartments tile ${tile.name}…`);
  const json = await overpass(
    `[out:json][timeout:180];way["building"~"apartments|residential"](${tile.bbox});out geom;`,
  );
  let added = 0;
  for (const element of json.elements ?? []) {
    if (element.type !== "way" || !Array.isArray(element.geometry)) continue;
    if (seen.has(element.id)) continue;
    seen.add(element.id);
    const ring = element.geometry.map((node) => [node.lon, node.lat]);
    if (ring.length < 4) continue;
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
    }
    allFeatures.push({
      type: "Feature",
      properties: {
        id: element.id,
        building: element.tags?.building ?? null,
        levels: element.tags?.["building:levels"] ?? null,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
    added += 1;
  }
  console.log(`  ${tile.name}: +${added} (total ${allFeatures.length})`);
}

const fc = { type: "FeatureCollection", features: allFeatures };
const outPath = path.join(outDir, "seoul-buildings.geojson");
await writeFile(outPath, JSON.stringify(fc));
console.log(`Wrote ${allFeatures.length} building polygons to ${outPath}`);
