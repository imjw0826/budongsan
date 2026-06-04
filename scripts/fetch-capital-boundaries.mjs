import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as turf from "@turf/turf";

const sources = [
  {
    file: "/private/tmp/gyeonggi.geojson",
    fallbackUrl:
      "https://raw.githubusercontent.com/raqoon886/Local_HangJeongDong/master/hangjeongdong_%EA%B2%BD%EA%B8%B0%EB%8F%84.geojson",
  },
  {
    file: "/private/tmp/incheon.geojson",
    fallbackUrl:
      "https://raw.githubusercontent.com/raqoon886/Local_HangJeongDong/master/hangjeongdong_%EC%9D%B8%EC%B2%9C%EA%B4%91%EC%97%AD%EC%8B%9C.geojson",
  },
];

const outDir = path.resolve("public/boundaries");
await mkdir(outDir, { recursive: true });

async function readSource({ file, fallbackUrl }) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    const response = await fetch(fallbackUrl);
    if (!response.ok) throw new Error(`Failed ${fallbackUrl}: HTTP ${response.status}`);
    return response.json();
  }
}

function asPolygonFeature(feature) {
  if (feature.geometry.type === "Polygon") return turf.polygon(feature.geometry.coordinates);
  if (feature.geometry.type === "MultiPolygon") return turf.multiPolygon(feature.geometry.coordinates);
  return null;
}

function unionFeatures(features, label) {
  const polygons = features.map(asPolygonFeature).filter(Boolean);
  let merged = polygons[0];
  for (let i = 1; i < polygons.length; i += 1) {
    try {
      const next = turf.union(turf.featureCollection([merged, polygons[i]]));
      if (next) merged = next;
    } catch (error) {
      console.warn(`Union failed for ${label} at ${i}: ${error.message}`);
    }
  }
  return merged;
}

const grouped = new Map();
for (const source of sources) {
  const data = await readSource(source);
  for (const feature of data.features) {
    const { sido, sidonm, sgg, sggnm } = feature.properties ?? {};
    if (!sido || !sidonm || !sgg || !sggnm) continue;
    const id = `${sido}-${sgg}`;
    if (!grouped.has(id)) {
      grouped.set(id, {
        id,
        name: sggnm,
        sido: sidonm,
        code: sgg,
        features: [],
      });
    }
    grouped.get(id).features.push(feature);
  }
}

const outputFeatures = [];
for (const group of grouped.values()) {
  const merged = unionFeatures(group.features, `${group.sido} ${group.name}`);
  if (!merged) continue;
  const center = turf.centerOfMass(merged).geometry.coordinates;
  outputFeatures.push({
    type: "Feature",
    properties: {
      id: group.id,
      name: group.name,
      sido: group.sido,
      code: group.code,
      center: [center[1], center[0]],
    },
    geometry: merged.geometry,
  });
}

await writeFile(
  path.join(outDir, "capital-sigg.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: outputFeatures }),
);

console.log(`Wrote ${outputFeatures.length} 수도권 시군구 boundaries.`);
