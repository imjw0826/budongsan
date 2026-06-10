// export-static-api.mjs
// -----------------------------------------------------------------------------
// SQLite → 정적 JSON 변환 (GitHub Pages 배포용).
// 프론트엔드가 호출하는 두 엔드포인트를 파일로 미리 생성한다:
//   /api/meta.json               ← GET /api/meta
//   /api/apartments/{id}.json    ← GET /api/apartments/:id
//
// 사용: node scripts/export-static-api.mjs --out dist/api
// -----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

migrate();

const outIdx = process.argv.indexOf("--out");
const outDir = path.resolve(outIdx >= 0 ? process.argv[outIdx + 1] : "dist/api");
mkdirSync(path.join(outDir, "apartments"), { recursive: true });

// ---- meta.json --------------------------------------------------------------

const metaRow = db
  .prepare(
    `
    SELECT
      (SELECT MAX(COALESCE(updated_at, year)) FROM official_prices WHERE source = 'vworld-file') AS vworldLatest,
      (SELECT COUNT(*) FROM official_prices WHERE source = 'vworld-file') AS vworldUnitCount
  `,
  )
  .get();
writeFileSync(
  path.join(outDir, "meta.json"),
  JSON.stringify({
    lastUpdated: metaRow?.vworldLatest
      ? String(metaRow.vworldLatest).slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    source: metaRow?.vworldUnitCount > 0 ? "VWorld 공동주택가격정보" : "국토교통부 주택 가격 정보",
    unitCount: metaRow?.vworldUnitCount ?? 0,
  }),
);

// ---- apartments/{id}.json ---------------------------------------------------
// server/api.mjs 의 GET /api/apartments/:id 와 동일한 응답 형태를 유지한다.

const complexes = db
  .prepare(
    `
    SELECT
      c.id,
      c.name,
      c.district,
      c.neighborhood,
      c.address,
      c.lat,
      c.lng,
      c.households,
      c.buildings,
      c.main_area AS mainArea,
      COALESCE(vp.min_price, p.min_price, c.min_price) AS minPrice,
      COALESCE(vp.max_price, p.max_price, c.max_price) AS maxPrice,
      CASE WHEN vp.price_count > 0 THEN 'vworld-file' ELSE 'legacy' END AS priceSource,
      vp.latest_update AS noticeDate
    FROM apartment_complexes c
    LEFT JOIN (
      SELECT complex_id,
             MIN(price) AS min_price,
             MAX(price) AS max_price,
             COUNT(*) AS price_count,
             MAX(COALESCE(updated_at, year)) AS latest_update
      FROM official_prices
      WHERE source = 'vworld-file' AND price > 0
      GROUP BY complex_id
    ) vp ON vp.complex_id = c.id
    LEFT JOIN (
      SELECT complex_id, MIN(price) AS min_price, MAX(price) AS max_price
      FROM official_prices
      WHERE source <> 'vworld-file'
      GROUP BY complex_id
    ) p ON p.complex_id = c.id
  `,
  )
  .all();

const vworldPrices = db.prepare(`
  SELECT
    id,
    year,
    building,
    ho,
    floor,
    area,
    COALESCE(price_won / 100000000.0, price) AS price
  FROM official_prices
  WHERE complex_id = ?
    AND source = 'vworld-file'
  ORDER BY building ASC, floor DESC, ho ASC, area ASC
`);

const legacyPrices = db.prepare(`
  SELECT id, year, building, NULL AS ho, floor, area, price
  FROM official_prices
  WHERE complex_id = ?
    AND source <> 'vworld-file'
  ORDER BY building ASC, floor DESC, area ASC
`);

let written = 0;
let totalBytes = 0;
for (const complex of complexes) {
  const prices =
    complex.priceSource === "vworld-file"
      ? vworldPrices.all(complex.id)
      : legacyPrices.all(complex.id);
  const json = JSON.stringify({ ...complex, prices });
  totalBytes += json.length;
  writeFileSync(path.join(outDir, "apartments", `${complex.id}.json`), json);
  written += 1;
}

console.log(
  `정적 API 생성 완료: meta.json + 단지 ${written}개 → ${outDir} (${(totalBytes / 1e6).toFixed(0)} MB)`,
);
