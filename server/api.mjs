import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as turf from "@turf/turf";
import { db, migrate } from "./db.mjs";

migrate();

const app = express();
const port = Number(process.env.API_PORT ?? 8000);

const boundariesDir = path.resolve("public/boundaries");
const siggGeo = JSON.parse(await readFile(path.join(boundariesDir, "seoul-sigg.geojson"), "utf8"));
const dongGeo = JSON.parse(await readFile(path.join(boundariesDir, "seoul-dong.geojson"), "utf8"));

function featureBbox(feature) {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(feature);
  return { minLng, minLat, maxLng, maxLat };
}

const siggIndex = siggGeo.features.map((feature) => ({
  id: String(feature.properties.id),
  name: feature.properties.name,
  feature,
  bbox: featureBbox(feature),
}));

const dongIndex = dongGeo.features.map((feature) => ({
  id: String(feature.properties.id),
  name: feature.properties.name,
  district: feature.properties.district,
  feature,
  bbox: featureBbox(feature),
}));

const displayedAvgPriceSql =
  "COALESCE(vp.avg_price, p.avg_price, (c.min_price + c.max_price) / 2.0)";

function normalizeRegionName(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function dongFamilyName(value) {
  return normalizeRegionName(value).replace(/\d+동$/, "동");
}

function rowMatchesRegion(row, entry, regionType) {
  if (regionType === "district") {
    return normalizeRegionName(row.district) === normalizeRegionName(entry.name);
  }
  if (regionType === "dong") {
    return (
      normalizeRegionName(row.district) === normalizeRegionName(entry.district) &&
      dongFamilyName(row.neighborhood) === dongFamilyName(entry.name)
    );
  }
  return true;
}

function findRegionAt(lat, lng, entries) {
  const point = turf.point([lng, lat]);
  for (const entry of entries) {
    if (
      lng < entry.bbox.minLng ||
      lng > entry.bbox.maxLng ||
      lat < entry.bbox.minLat ||
      lat > entry.bbox.maxLat
    ) {
      continue;
    }
    if (turf.booleanPointInPolygon(point, entry.feature)) {
      return entry;
    }
  }
  return null;
}

function listComplexesIn(entry, extra = {}) {
  const { minLng, minLat, maxLng, maxLat } = entry.bbox;
  const candidates = db
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
        ${displayedAvgPriceSql} AS avgPrice,
        COALESCE(vp.price_count, p.price_count, 0) AS tradeCount,
        vp.latest_update AS noticeDate,
        CASE WHEN vp.price_count > 0 THEN 'vworld-file' ELSE 'legacy' END AS priceSource
      FROM apartment_complexes c
      LEFT JOIN (
        SELECT complex_id,
               MIN(price) AS min_price,
               MAX(price) AS max_price,
               AVG(price) AS avg_price,
               COUNT(*) AS price_count,
               MAX(COALESCE(updated_at, year)) AS latest_update
        FROM official_prices
        WHERE source = 'vworld-file' AND price > 0
        GROUP BY complex_id
      ) vp ON vp.complex_id = c.id
      LEFT JOIN (
        SELECT complex_id,
               MIN(price) AS min_price,
               MAX(price) AS max_price,
               AVG(price) AS avg_price,
               COUNT(*) AS price_count
        FROM official_prices
        WHERE source <> 'vworld-file'
        GROUP BY complex_id
      ) p ON p.complex_id = c.id
      WHERE c.lat BETWEEN @minLat AND @maxLat
        AND c.lng BETWEEN @minLng AND @maxLng
        AND (@query = '' OR c.name LIKE @like OR c.district LIKE @like OR c.neighborhood LIKE @like)
        AND (
          @band = 'all'
          OR (@band = 'under8' AND ${displayedAvgPriceSql} < 8)
          OR (@band = '8to15' AND ${displayedAvgPriceSql} >= 8 AND ${displayedAvgPriceSql} < 15)
          OR (@band = 'over15' AND ${displayedAvgPriceSql} >= 15)
        )
      ORDER BY avgPrice DESC
      LIMIT 1500
    `,
    )
    .all({
      minLng,
      minLat,
      maxLng,
      maxLat,
      query: extra.query ?? "",
      like: `%${extra.query ?? ""}%`,
      band: extra.band ?? "all",
    });

  return candidates.filter(
    (row) =>
      rowMatchesRegion(row, entry, extra.regionType) &&
      turf.booleanPointInPolygon(turf.point([row.lng, row.lat]), entry.feature),
  );
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function distributedPick(items, bbox, zoom) {
  const limit = zoom <= 11 ? 6 : zoom === 12 ? 14 : zoom === 13 ? 26 : zoom === 14 ? 42 : 70;
  const columns = zoom <= 12 ? 4 : zoom === 13 ? 6 : 8;
  const rows = zoom <= 12 ? 3 : zoom === 13 ? 4 : 5;
  const lngSpan = Math.max(bbox.east - bbox.west, 0.001);
  const latSpan = Math.max(bbox.north - bbox.south, 0.001);
  const buckets = new Map();

  for (const item of items) {
    const col = Math.min(columns - 1, Math.max(0, Math.floor(((item.lng - bbox.west) / lngSpan) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((bbox.north - item.lat) / latSpan) * rows)));
    const key = `${row}:${col}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.avgPrice - a.avgPrice);
  }

  const picked = [];
  let round = 0;
  while (picked.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      const next = bucket[round];
      if (next) {
        picked.push(next);
        added = true;
        if (picked.length >= limit) break;
      }
    }
    if (!added) break;
    round += 1;
  }

  return picked;
}

app.get("/api/apartments", (req, res) => {
  const zoom = Math.round(parseNumber(req.query.zoom, 12));
  const query = String(req.query.q ?? "").trim();
  const band = String(req.query.band ?? "all");
  const regionType = String(req.query.regionType ?? "");
  const regionId = String(req.query.regionId ?? "");

  let entry = null;
  if (regionType === "dong") entry = dongIndex.find((e) => e.id === regionId) ?? null;
  else if (regionType === "district") entry = siggIndex.find((e) => e.id === regionId) ?? null;

  if (!entry) {
    res.json({ totalInViewport: 0, items: [] });
    return;
  }

  const rows = listComplexesIn(entry, { query, band, regionType });
  const bbox = {
    west: entry.bbox.minLng,
    south: entry.bbox.minLat,
    east: entry.bbox.maxLng,
    north: entry.bbox.maxLat,
  };
  const items = regionType === "dong" ? rows : distributedPick(rows, bbox, zoom);
  res.json({ totalInViewport: rows.length, items });
});

app.get("/api/apartments/all", (_req, res) => {
  const rows = db
    .prepare(
      `
      SELECT
        c.id,
        c.name,
        c.district,
        c.neighborhood,
        c.lat,
        c.lng,
        ${displayedAvgPriceSql} AS avgPrice
      FROM apartment_complexes c
      LEFT JOIN (
        SELECT complex_id, AVG(price) AS avg_price
        FROM official_prices
        WHERE source = 'vworld-file' AND price > 0
        GROUP BY complex_id
      ) vp ON vp.complex_id = c.id
      LEFT JOIN (
        SELECT complex_id, AVG(price) AS avg_price
        FROM official_prices
        WHERE source <> 'vworld-file'
        GROUP BY complex_id
      ) p ON p.complex_id = c.id
      WHERE c.lat > 0 AND c.lng > 0
    `,
    )
    .all();
  res.json({ items: rows });
});

// 정적 배포(GitHub Pages)와 같은 경로를 dev 서버에서도 제공한다:
// 프론트는 항상 /api/meta.json, /api/apartments/{id}.json 을 호출한다.
app.get(["/api/meta", "/api/meta.json"], (_req, res) => {
  const row = db
    .prepare(
      `
      SELECT
        (SELECT MAX(COALESCE(updated_at, year)) FROM official_prices WHERE source = 'vworld-file') AS vworldLatest,
        (SELECT COUNT(*) FROM official_prices WHERE source = 'vworld-file') AS vworldUnitCount
    `,
    )
    .get();
  const lastUpdated = row?.vworldLatest
    ? String(row.vworldLatest).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  res.json({
    lastUpdated,
    source: row?.vworldUnitCount > 0 ? "VWorld 공동주택가격정보" : "국토교통부 주택 가격 정보",
    unitCount: row?.vworldUnitCount ?? 0,
  });
});

app.get("/api/regions/at", (req, res) => {
  const lat = parseNumber(req.query.lat, NaN);
  const lng = parseNumber(req.query.lng, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "invalid_coordinates" });
    return;
  }
  const district = findRegionAt(lat, lng, siggIndex);
  const dong = findRegionAt(lat, lng, dongIndex);
  res.json({
    district: district ? { id: district.id, name: district.name } : null,
    dong: dong ? { id: dong.id, name: dong.name, district: dong.district } : null,
  });
});

app.get("/api/apartments/:id", (req, res) => {
  const complexId = req.params.id.replace(/\.json$/, "");
  const complex = db
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
      WHERE c.id = ?
    `,
    )
    .get(complexId);

  if (!complex) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let prices = [];
  if (complex.priceSource === "vworld-file") {
    prices = db
      .prepare(
        `
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
      `,
      )
      .all(complexId);
  }

  if (prices.length === 0) {
    prices = db
      .prepare(
        `
        SELECT id, year, building, NULL AS ho, floor, area, price
        FROM official_prices
        WHERE complex_id = ?
          AND source <> 'vworld-file'
        ORDER BY building ASC, floor DESC, area ASC
      `,
      )
      .all(complexId);
  }

  res.json({ ...complex, prices });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});

server.on("error", (error) => {
  console.error("API server failed:", error);
  process.exitCode = 1;
});
