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

const complexMatchKeySql =
  "c.district || '|' || c.neighborhood || '|' || lower(replace(replace(c.name, ' ', ''), '아파트', ''))";

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
        COALESCE(r.min_price_won / 100000000.0, p.min_price, c.min_price) AS minPrice,
        COALESCE(r.max_price_won / 100000000.0, p.max_price, c.max_price) AS maxPrice,
        COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) AS avgPrice,
        COALESCE(r.unit_count, p.trade_count, 0) AS tradeCount,
        r.latest_notice_date AS noticeDate,
        CASE WHEN r.match_key IS NOT NULL THEN 'data.go.kr-file' ELSE 'legacy' END AS priceSource
      FROM apartment_complexes c
      LEFT JOIN realtyprice_complex_summary r
        ON r.match_key = ${complexMatchKeySql}
      LEFT JOIN (
        SELECT complex_id,
               MIN(price) AS min_price,
               MAX(price) AS max_price,
               AVG(price) AS avg_price,
               COUNT(*) AS trade_count
        FROM official_prices
        GROUP BY complex_id
      ) p ON p.complex_id = c.id
      WHERE c.lat BETWEEN @minLat AND @maxLat
        AND c.lng BETWEEN @minLng AND @maxLng
        AND (@query = '' OR c.name LIKE @like OR c.district LIKE @like OR c.neighborhood LIKE @like)
        AND (
          @band = 'all'
          OR (@band = 'under8' AND COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) < 8)
          OR (@band = '8to15' AND COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) >= 8 AND COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) < 15)
          OR (@band = 'over15' AND COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) >= 15)
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
        COALESCE(r.avg_price_won / 100000000.0, p.avg_price, (c.min_price + c.max_price) / 2.0) AS avgPrice
      FROM apartment_complexes c
      LEFT JOIN realtyprice_complex_summary r
        ON r.match_key = ${complexMatchKeySql}
      LEFT JOIN (
        SELECT complex_id, AVG(price) AS avg_price
        FROM official_prices
        GROUP BY complex_id
      ) p ON p.complex_id = c.id
      WHERE c.lat > 0 AND c.lng > 0
    `,
    )
    .all();
  res.json({ items: rows });
});

app.get("/api/meta", (_req, res) => {
  const row = db
    .prepare(
      `
      SELECT
        (SELECT MAX(latest_notice_date) FROM realtyprice_complex_summary) AS latestNotice,
        (SELECT SUM(unit_count) FROM realtyprice_complex_summary) AS unitCount
    `,
    )
    .get();
  const lastUpdated = row?.latestNotice
    ? String(row.latestNotice).replace(".", "-")
    : new Date().toISOString().slice(0, 10);
  res.json({
    lastUpdated,
    source: "국토교통부 주택 가격 정보",
    unitCount: row?.unitCount ?? 0,
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
        COALESCE(r.min_price_won / 100000000.0, p.min_price, c.min_price) AS minPrice,
        COALESCE(r.max_price_won / 100000000.0, p.max_price, c.max_price) AS maxPrice,
        r.match_key AS realtypriceMatchKey,
        r.unit_count AS realtypriceUnitCount,
        r.latest_notice_date AS noticeDate
      FROM apartment_complexes c
      LEFT JOIN realtyprice_complex_summary r
        ON r.match_key = ${complexMatchKeySql}
      LEFT JOIN (
        SELECT complex_id, MIN(price) AS min_price, MAX(price) AS max_price
        FROM official_prices
        GROUP BY complex_id
      ) p ON p.complex_id = c.id
      WHERE c.id = ?
    `,
    )
    .get(req.params.id);

  if (!complex) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let prices = [];
  if (complex.realtypriceMatchKey) {
    prices = db
      .prepare(
        `
        SELECT
          id,
          COALESCE(notice_date, year) AS year,
          building_name AS building,
          ho_name AS ho,
          COALESCE(floor, 0) AS floor,
          private_area AS area,
          price_won / 100000000.0 AS price
        FROM realtyprice_units
        WHERE source = 'data.go.kr-file'
          AND district || '|' || legal_dong || '|' || lower(replace(replace(apt_name, ' ', ''), '아파트', '')) = ?
        ORDER BY building_name ASC, floor DESC, ho_name ASC, private_area ASC
      `,
      )
      .all(complex.realtypriceMatchKey);
  }

  if (prices.length === 0) {
    prices = db
      .prepare(
        `
        SELECT id, year, building, NULL AS ho, floor, area, price
        FROM official_prices
        WHERE complex_id = ?
        ORDER BY building ASC, floor DESC, area ASC
      `,
      )
      .all(req.params.id);
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
