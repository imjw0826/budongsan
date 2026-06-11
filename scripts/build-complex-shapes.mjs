// build-complex-shapes.mjs
// -----------------------------------------------------------------------------
// apartment_complexes → public/boundaries/seoul-complexes.geojson 재생성.
//
// 평균 공시가 우선순위:
//   1) official_prices source='vworld-file' (V-World 파일 임포트, 호별 평균)
//   2) 그 외 official_prices 평균
//   3) (min_price + max_price) / 2  — 둘 다 없을 때
//
// 선행: node scripts/import-vworld-files.mjs --shp --csv
// -----------------------------------------------------------------------------

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

migrate();

const complexesOut = path.resolve("public/boundaries/seoul-complexes.geojson");

const complexes = db
  .prepare(
    `
    SELECT
      c.id, c.name, c.district, c.neighborhood, c.lat, c.lng,
      c.households, c.buildings AS buildingCount,
      COALESCE(vf.avg_price, p.avg_price, (c.min_price + c.max_price) / 2.0) AS avgPrice,
      COALESCE(vf.min_price, p.min_price, c.min_price) AS minPrice,
      COALESCE(vf.max_price, p.max_price, c.max_price) AS maxPrice
    FROM apartment_complexes c
    LEFT JOIN (
      SELECT complex_id, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price
      FROM official_prices
      WHERE source = 'vworld-file' AND price > 0
      GROUP BY complex_id
    ) vf ON vf.complex_id = c.id
    LEFT JOIN (
      SELECT complex_id, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price
      FROM official_prices
      WHERE source <> 'vworld-file' AND price > 0
      GROUP BY complex_id
    ) p ON p.complex_id = c.id
    WHERE c.lat > 0 AND c.lng > 0
  `,
  )
  .all();

// Rank: by households then by avgPrice (stable global ranking)
complexes.sort((a, b) => {
  const ha = a.households ?? 0;
  const hb = b.households ?? 0;
  if (hb !== ha) return hb - ha;
  return (b.avgPrice ?? 0) - (a.avgPrice ?? 0);
});
complexes.forEach((c, i) => {
  c.rank = i + 1;
});

const complexesFc = {
  type: "FeatureCollection",
  features: complexes.map((c) => ({
    type: "Feature",
    properties: {
      id: c.id,
      name: c.name,
      district: c.district,
      neighborhood: c.neighborhood,
      avgPrice: c.avgPrice == null ? null : Number(c.avgPrice.toFixed(2)),
      minPrice: c.minPrice == null ? null : Number(c.minPrice.toFixed(2)),
      maxPrice: c.maxPrice == null ? null : Number(c.maxPrice.toFixed(2)),
      households: c.households,
      buildingCount: c.buildingCount ?? 0,
      rank: c.rank,
    },
    geometry: {
      type: "Point",
      coordinates: [Number(c.lng.toFixed(6)), Number(c.lat.toFixed(6))],
    },
  })),
};

await writeFile(complexesOut, JSON.stringify(complexesFc));
console.log(`Wrote ${complexesFc.features.length} complexes → ${complexesOut}`);
