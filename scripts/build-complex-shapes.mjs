import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

migrate();

const buildingsPath = path.resolve("public/boundaries/seoul-buildings.geojson");
const complexesOut = path.resolve("public/boundaries/seoul-complexes.geojson");

const buildings = JSON.parse(await readFile(buildingsPath, "utf8"));
const complexes = db
  .prepare(
    `
    SELECT
      c.id, c.name, c.district, c.neighborhood, c.lat, c.lng, c.households,
      COALESCE(p.avg_price, (c.min_price + c.max_price) / 2.0) AS avgPrice
    FROM apartment_complexes c
    LEFT JOIN (
      SELECT complex_id, AVG(price) AS avg_price FROM official_prices GROUP BY complex_id
    ) p ON p.complex_id = c.id
    WHERE c.lat > 0 AND c.lng > 0
  `,
  )
  .all();

console.log(
  `${buildings.features.length} buildings, ${complexes.length} complexes — assigning…`,
);

// Precompute building centroid + index by lat-cell
const CELL = 0.005; // ~500m
const grid = new Map();
const bldData = buildings.features.map((feature, idx) => {
  const ring = feature.geometry.coordinates[0];
  let lng = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  lng /= ring.length;
  lat /= ring.length;
  const cellKey = `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  if (!grid.has(cellKey)) grid.set(cellKey, []);
  grid.get(cellKey).push(idx);
  return { idx, lng, lat, feature };
});

const MAX_DIST_DEG = 0.0012; // ~120m
const MAX_DIST_SQ = MAX_DIST_DEG * MAX_DIST_DEG;

const buildingAssign = new Int32Array(bldData.length).fill(-1);
const buildingDist = new Float64Array(bldData.length).fill(Infinity);

complexes.forEach((complex, complexIdx) => {
  const cellLat = Math.floor(complex.lat / CELL);
  const cellLng = Math.floor(complex.lng / CELL);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const key = `${cellLat + dy}:${cellLng + dx}`;
      const bucket = grid.get(key);
      if (!bucket) continue;
      for (const bIdx of bucket) {
        const b = bldData[bIdx];
        const dlng = b.lng - complex.lng;
        const dlat = b.lat - complex.lat;
        const dist = dlng * dlng + dlat * dlat;
        if (dist > MAX_DIST_SQ) continue;
        if (dist < buildingDist[bIdx]) {
          buildingDist[bIdx] = dist;
          buildingAssign[bIdx] = complexIdx;
        }
      }
    }
  }
});

// For each complex, collect its buildings + recomputed centroid
const complexBuildings = new Map();
let assignedCount = 0;
for (let i = 0; i < bldData.length; i += 1) {
  const complexIdx = buildingAssign[i];
  if (complexIdx < 0) continue;
  assignedCount += 1;
  const id = complexes[complexIdx].id;
  if (!complexBuildings.has(id)) complexBuildings.set(id, []);
  complexBuildings.get(id).push(i);
  bldData[i].feature.properties.complexId = id;
}
console.log(`Assigned ${assignedCount} / ${bldData.length} buildings to a complex.`);

// Recompute marker center as centroid of assigned building centroids; fallback to original lat/lng
const enriched = complexes.map((c) => {
  const owned = complexBuildings.get(c.id) ?? [];
  let lat = c.lat;
  let lng = c.lng;
  if (owned.length > 0) {
    let sLat = 0;
    let sLng = 0;
    for (const bIdx of owned) {
      sLat += bldData[bIdx].lat;
      sLng += bldData[bIdx].lng;
    }
    lat = sLat / owned.length;
    lng = sLng / owned.length;
  }
  return {
    ...c,
    centerLat: Number(lat.toFixed(6)),
    centerLng: Number(lng.toFixed(6)),
    buildingCount: owned.length,
  };
});

// Rank: by households then by avgPrice (stable global ranking)
enriched.sort((a, b) => {
  const ha = a.households ?? 0;
  const hb = b.households ?? 0;
  if (hb !== ha) return hb - ha;
  return (b.avgPrice ?? 0) - (a.avgPrice ?? 0);
});
enriched.forEach((c, i) => {
  c.rank = i + 1;
});

const complexesFc = {
  type: "FeatureCollection",
  features: enriched.map((c) => ({
    type: "Feature",
    properties: {
      id: c.id,
      name: c.name,
      district: c.district,
      neighborhood: c.neighborhood,
      avgPrice: c.avgPrice,
      households: c.households,
      buildingCount: c.buildingCount,
      rank: c.rank,
    },
    geometry: { type: "Point", coordinates: [c.centerLng, c.centerLat] },
  })),
};

await writeFile(buildingsPath, JSON.stringify(buildings));
await writeFile(complexesOut, JSON.stringify(complexesFc));

console.log(`Wrote ${complexesFc.features.length} complexes → ${complexesOut}`);
console.log(`Updated building features with complexId → ${buildingsPath}`);
