import express from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";
import { db, migrate } from "./db.mjs";

migrate();

const app = express();
const port = Number(process.env.API_PORT ?? 8000);

const buildingsCacheDir = path.resolve("data/buildings-cache");
await mkdir(buildingsCacheDir, { recursive: true });

const boundariesDir = path.resolve("public/boundaries");
const siggGeo = JSON.parse(await readFile(path.join(boundariesDir, "seoul-sigg.geojson"), "utf8"));
const dongGeo = JSON.parse(await readFile(path.join(boundariesDir, "seoul-dong.geojson"), "utf8"));

const chunkLayerFiles = {
  hanRiver: "han-river.geojson",
  roadsMinor: "seoul-roads-minor.geojson",
  parks: "seoul-parks.geojson",
  buildings: "seoul-buildings.geojson",
  complexes: "seoul-complexes.geojson",
};
const chunkLayerCache = new Map();
const chunkResponseCache = new Map();
const MAX_CHUNK_RESPONSE_CACHE = 300;
const CHUNK_GRID_SIZE = 64;
const CHUNK_LAYER_LIMITS = {
  parks: 220,
  roadsMinor: 900,
  buildings: 1200,
  complexes: 500,
};

function featureBbox(feature) {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(feature);
  return { minLng, minLat, maxLng, maxLat };
}

function bboxesOverlap(a, b) {
  return a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

function mergeBbox(a, b) {
  if (!a) return { ...b };
  return {
    minLng: Math.min(a.minLng, b.minLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
  };
}

function gridRangeForBbox(layerBbox, bbox) {
  const lngSpan = Math.max(layerBbox.maxLng - layerBbox.minLng, 0.000001);
  const latSpan = Math.max(layerBbox.maxLat - layerBbox.minLat, 0.000001);
  const clamp = (value) => Math.max(0, Math.min(CHUNK_GRID_SIZE - 1, value));
  return {
    minX: clamp(Math.floor(((bbox.minLng - layerBbox.minLng) / lngSpan) * CHUNK_GRID_SIZE)),
    maxX: clamp(Math.floor(((bbox.maxLng - layerBbox.minLng) / lngSpan) * CHUNK_GRID_SIZE)),
    minY: clamp(Math.floor(((bbox.minLat - layerBbox.minLat) / latSpan) * CHUNK_GRID_SIZE)),
    maxY: clamp(Math.floor(((bbox.maxLat - layerBbox.minLat) / latSpan) * CHUNK_GRID_SIZE)),
  };
}

function buildSpatialGrid(entries, layerBbox) {
  const grid = new Map();
  entries.forEach((entry, index) => {
    const range = gridRangeForBbox(layerBbox, entry.bbox);
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = `${x}:${y}`;
        const bucket = grid.get(key) ?? [];
        bucket.push(index);
        grid.set(key, bucket);
      }
    }
  });
  return grid;
}

function querySpatialGrid(indexed, queryBbox) {
  if (!indexed.layerBbox || !bboxesOverlap(indexed.layerBbox, queryBbox)) return [];
  const range = gridRangeForBbox(indexed.layerBbox, queryBbox);
  const candidateIndexes = new Set();
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      const bucket = indexed.grid.get(`${x}:${y}`);
      if (!bucket) continue;
      for (const index of bucket) candidateIndexes.add(index);
    }
  }
  const matches = [];
  for (const index of candidateIndexes) {
    const entry = indexed.features[index];
    if (entry && bboxesOverlap(entry.bbox, queryBbox)) matches.push(entry.feature);
  }
  return matches;
}

function isReasonableBuildingFootprint(feature) {
  const { minLng, minLat, maxLng, maxLat } = featureBbox(feature);
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  return lngSpan > 0 && latSpan > 0 && lngSpan <= 0.0015 && latSpan <= 0.0015;
}

function capLayerFeatures(layer, features) {
  const filtered = layer === "buildings" ? features.filter(isReasonableBuildingFootprint) : features;
  const limit = CHUNK_LAYER_LIMITS[layer];
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function tileToBbox(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return {
    west,
    east,
    north: (northRad * 180) / Math.PI,
    south: (southRad * 180) / Math.PI,
  };
}

async function getIndexedChunkLayer(layer) {
  if (!chunkLayerFiles[layer]) return null;
  const cached = chunkLayerCache.get(layer);
  if (cached) return cached;
  const data = JSON.parse(await readFile(path.join(boundariesDir, chunkLayerFiles[layer]), "utf8"));
  let layerBbox = null;
  const features = data.features.map((feature) => {
    const bbox = featureBbox(feature);
    layerBbox = mergeBbox(layerBbox, bbox);
    return { feature, bbox };
  });
  const indexed = {
    type: "FeatureCollection",
    features,
    layerBbox,
    grid: layerBbox ? buildSpatialGrid(features, layerBbox) : new Map(),
  };
  chunkLayerCache.set(layer, indexed);
  return indexed;
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

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function queryOverpass(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "budongsan-map/0.1 (https://localhost)",
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) {
        lastError = new Error(`${endpoint} HTTP ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("All Overpass endpoints failed");
}

function overpassToFeatureCollection(json) {
  const nodes = new Map();
  for (const element of json.elements ?? []) {
    if (element.type === "node") {
      nodes.set(element.id, [element.lon, element.lat]);
    }
  }
  const features = [];
  for (const element of json.elements ?? []) {
    if (element.type !== "way") continue;
    const coords = Array.isArray(element.geometry)
      ? element.geometry.map((node) => [node.lon, node.lat])
      : (element.nodes ?? []).map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 3) continue;
    const ring = [...coords];
    if (
      ring[0][0] !== ring[ring.length - 1][0] ||
      ring[0][1] !== ring[ring.length - 1][1]
    ) {
      ring.push(ring[0]);
    }
    features.push({
      type: "Feature",
      properties: {
        id: element.id,
        building: element.tags?.building ?? null,
        name: element.tags?.name ?? null,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return { type: "FeatureCollection", features };
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

app.get("/api/map/chunks", async (req, res) => {
  const z = Math.floor(parseNumber(req.query.z, NaN));
  const x = Math.floor(parseNumber(req.query.x, NaN));
  const y = Math.floor(parseNumber(req.query.y, NaN));
  const requestedLayers = String(req.query.layers ?? "")
    .split(",")
    .map((layer) => layer.trim())
    .filter(Boolean);

  if (![z, x, y].every(Number.isFinite) || z < 8 || z > 18) {
    res.status(400).json({ error: "invalid_tile" });
    return;
  }
  const maxIndex = 2 ** z;
  if (x < 0 || y < 0 || x >= maxIndex || y >= maxIndex) {
    res.status(400).json({ error: "tile_out_of_range" });
    return;
  }

  const cacheKey = `${z}/${x}/${y}?${requestedLayers.sort().join(",")}`;
  const cachedResponse = chunkResponseCache.get(cacheKey);
  if (cachedResponse) {
    res.json(cachedResponse);
    return;
  }

  const tileBbox = tileToBbox(z, x, y);
  const queryBbox = {
    minLng: tileBbox.west,
    minLat: tileBbox.south,
    maxLng: tileBbox.east,
    maxLat: tileBbox.north,
  };
  const layers = {};

  try {
    for (const layer of requestedLayers) {
      const indexed = await getIndexedChunkLayer(layer);
      if (!indexed) continue;
      const features = querySpatialGrid(indexed, queryBbox);
      layers[layer] = {
        type: "FeatureCollection",
        features: capLayerFeatures(layer, features),
      };
    }
    const payload = {
      id: `${z}/${x}/${y}`,
      coord: { z, x, y },
      bbox: tileBbox,
      layers,
      loadedAt: Date.now(),
    };
    chunkResponseCache.set(cacheKey, payload);
    while (chunkResponseCache.size > MAX_CHUNK_RESPONSE_CACHE) {
      const firstKey = chunkResponseCache.keys().next().value;
      if (!firstKey) break;
      chunkResponseCache.delete(firstKey);
    }
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: "chunk_load_failed", message: String(error?.message ?? error) });
  }
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

app.get("/api/buildings", async (req, res) => {
  const south = parseNumber(req.query.south, NaN);
  const west = parseNumber(req.query.west, NaN);
  const north = parseNumber(req.query.north, NaN);
  const east = parseNumber(req.query.east, NaN);
  if (![south, west, north, east].every(Number.isFinite)) {
    res.status(400).json({ error: "invalid_bbox" });
    return;
  }
  if (north - south > 0.05 || east - west > 0.06) {
    res.status(400).json({ error: "bbox_too_large" });
    return;
  }

  const cacheKey = [south, west, north, east].map((n) => n.toFixed(4)).join("_");
  const cachePath = path.join(buildingsCacheDir, `${cacheKey}.geojson`);
  if (existsSync(cachePath)) {
    res.type("application/geo+json").send(await readFile(cachePath, "utf8"));
    return;
  }

  const query =
    `[out:json][timeout:25];` +
    `(way["building"~"apartments|residential|house"]` +
    `(${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}););` +
    `out geom;`;

  try {
    const json = await queryOverpass(query);
    const collection = overpassToFeatureCollection(json);
    const body = JSON.stringify(collection);
    await writeFile(cachePath, body, "utf8");
    res.type("application/geo+json").send(body);
  } catch (error) {
    res.status(502).json({ error: "overpass_failed", message: String(error?.message ?? error) });
  }
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});

server.on("error", (error) => {
  console.error("API server failed:", error);
  process.exitCode = 1;
});
