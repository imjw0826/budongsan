import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as turf from "@turf/turf";

const DONG_URL =
  "https://raw.githubusercontent.com/raqoon886/Local_HangJeongDong/master/hangjeongdong_%EC%84%9C%EC%9A%B8%ED%8A%B9%EB%B3%84%EC%8B%9C.geojson";

const outDir = path.resolve("public/boundaries");
await mkdir(outDir, { recursive: true });

console.log("Downloading Seoul 행정동 GeoJSON…");
const response = await fetch(DONG_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch dong GeoJSON: HTTP ${response.status}`);
}
const raw = await response.json();

const dongFeatures = raw.features
  .filter((feature) => feature.properties?.sidonm === "서울특별시")
  .map((feature) => {
    const { adm_nm, adm_cd2, sgg, sggnm } = feature.properties;
    const dongName = adm_nm.split(" ").slice(-1)[0];
    const center = turf.centerOfMass(feature).geometry.coordinates;
    return {
      type: "Feature",
      properties: {
        id: adm_cd2,
        name: dongName,
        fullName: adm_nm,
        district: sggnm,
        districtCode: sgg,
        center: [center[1], center[0]],
      },
      geometry: feature.geometry,
    };
  });

console.log(`Loaded ${dongFeatures.length} dong features.`);

const groupedByDistrict = new Map();
for (const feature of dongFeatures) {
  const code = feature.properties.districtCode;
  if (!groupedByDistrict.has(code)) {
    groupedByDistrict.set(code, {
      name: feature.properties.district,
      code,
      features: [],
    });
  }
  groupedByDistrict.get(code).features.push(feature);
}

const districtFeatures = [];
for (const { name, code, features } of groupedByDistrict.values()) {
  const polygons = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") {
      polygons.push(turf.polygon(feature.geometry.coordinates));
    } else if (feature.geometry.type === "MultiPolygon") {
      for (const coords of feature.geometry.coordinates) {
        polygons.push(turf.polygon(coords));
      }
    }
  }
  let merged = polygons[0];
  for (let i = 1; i < polygons.length; i += 1) {
    try {
      const union = turf.union(turf.featureCollection([merged, polygons[i]]));
      if (union) merged = union;
    } catch (error) {
      console.warn(`Union failed for ${name}: ${error.message}`);
    }
  }
  const center = turf.centerOfMass(merged).geometry.coordinates;
  districtFeatures.push({
    type: "Feature",
    properties: { id: code, name, code, center: [center[1], center[0]] },
    geometry: merged.geometry,
  });
  console.log(`Merged ${name} (${features.length} dong) → ${merged.geometry.type}`);
}

const cityFeatureCollection = turf.featureCollection(
  districtFeatures.map((f) =>
    f.geometry.type === "Polygon"
      ? turf.polygon(f.geometry.coordinates)
      : turf.multiPolygon(f.geometry.coordinates),
  ),
);
let cityMerged = cityFeatureCollection.features[0];
for (let i = 1; i < cityFeatureCollection.features.length; i += 1) {
  try {
    const union = turf.union(
      turf.featureCollection([cityMerged, cityFeatureCollection.features[i]]),
    );
    if (union) cityMerged = union;
  } catch (error) {
    console.warn(`City union failed at ${i}: ${error.message}`);
  }
}

const cityCenter = turf.centerOfMass(cityMerged).geometry.coordinates;
const cityGeoJson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        id: "11",
        name: "서울특별시",
        center: [cityCenter[1], cityCenter[0]],
      },
      geometry: cityMerged.geometry,
    },
  ],
};

const districtGeoJson = {
  type: "FeatureCollection",
  features: districtFeatures,
};

const dongGeoJson = {
  type: "FeatureCollection",
  features: dongFeatures,
};

await writeFile(path.join(outDir, "seoul-city.geojson"), JSON.stringify(cityGeoJson));
await writeFile(path.join(outDir, "seoul-sigg.geojson"), JSON.stringify(districtGeoJson));
await writeFile(path.join(outDir, "seoul-dong.geojson"), JSON.stringify(dongGeoJson));

console.log(
  `Wrote city (1), districts (${districtFeatures.length}), dongs (${dongFeatures.length}) to ${outDir}`,
);

console.log("Fetching Han river polygon from Overpass…");
const overpassQuery = `[out:json][timeout:60];relation["name"="한강"]["natural"="water"];out geom;`;
const overpassEndpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
let overpassJson = null;
let lastError = null;
for (const endpoint of overpassEndpoints) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "budongsan-map-fetch/0.1 (https://localhost)",
        Accept: "application/json",
      },
      body: `data=${encodeURIComponent(overpassQuery)}`,
    });
    if (!response.ok) {
      lastError = new Error(`${endpoint} HTTP ${response.status}`);
      console.warn(lastError.message);
      continue;
    }
    overpassJson = await response.json();
    break;
  } catch (error) {
    lastError = error;
    console.warn(`${endpoint} failed: ${error.message}`);
  }
}
if (!overpassJson) {
  throw lastError ?? new Error("All Overpass endpoints failed");
}
const relation = overpassJson.elements.find((element) => element.type === "relation");
if (!relation) {
  throw new Error("Han river relation not found");
}

function ptKey([lon, lat]) {
  return `${lon.toFixed(7)},${lat.toFixed(7)}`;
}

function ringIsClosed(ring) {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function stitchWays(ways) {
  const remaining = ways.map((coords) => coords.slice());
  const rings = [];
  while (remaining.length > 0) {
    let current = remaining.shift();
    if (ringIsClosed(current)) {
      rings.push(current);
      continue;
    }
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
          remaining.splice(i, 1);
          progress = true;
          break;
        }
        if (ptKey(cTail) === ptKey(tail)) {
          current = current.concat(candidate.slice(0, -1).reverse());
          remaining.splice(i, 1);
          progress = true;
          break;
        }
        if (ptKey(cTail) === ptKey(head)) {
          current = candidate.slice(0, -1).concat(current);
          remaining.splice(i, 1);
          progress = true;
          break;
        }
        if (ptKey(cHead) === ptKey(head)) {
          current = candidate.slice(1).reverse().concat(current);
          remaining.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
    if (ringIsClosed(current) && current.length >= 4) {
      rings.push(current);
    } else if (current.length >= 4) {
      current.push(current[0]);
      rings.push(current);
    }
  }
  return rings;
}

const outerWays = [];
const innerWays = [];
for (const member of relation.members ?? []) {
  if (member.type !== "way" || !Array.isArray(member.geometry)) continue;
  const coords = member.geometry.map((node) => [node.lon, node.lat]);
  if (coords.length < 2) continue;
  if (member.role === "inner") {
    innerWays.push(coords);
  } else {
    outerWays.push(coords);
  }
}

const outerRings = stitchWays(outerWays);
const innerRings = stitchWays(innerWays);

const polygons = outerRings.map((outer) => {
  const outerPoly = turf.polygon([outer]);
  const holes = innerRings.filter((inner) => {
    const sample = turf.point(inner[0]);
    return turf.booleanPointInPolygon(sample, outerPoly);
  });
  return [outer, ...holes];
});

const hanRiverGeoJson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "han-river", name: "한강" },
      geometry:
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons },
    },
  ],
};

await writeFile(path.join(outDir, "han-river.geojson"), JSON.stringify(hanRiverGeoJson));
console.log(`Wrote Han river: ${outerRings.length} outer ring(s), ${innerRings.length} inner ring(s).`);
