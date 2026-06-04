#!/usr/bin/env node
// Build static vector tiles (.pbf) from all public/boundaries/*.geojson.
//
// Output: public/tiles/{z}/{x}/{y}.pbf — one MVT protobuf per tile, with each
// source layer as a separate MVT layer. MapLibre reads via:
//   { type: 'vector', tiles: ['/tiles/{z}/{x}/{y}.pbf'], minzoom, maxzoom }
//
// We skip the PMTiles archive step because the JS pmtiles npm package is
// reader-only. Raw .pbf files served as static assets give the same client
// behavior (per-tile cache, LOD, MVT decoding) — only the single-file
// distribution benefit is missing, which we can add later via `pmtiles
// convert` (CLI) once installed.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BOUNDARIES = join(ROOT, "public", "boundaries");
const OUTPUT = join(ROOT, "public", "tiles");

// Source layer config — file → MVT layer name → zoom range it lives in.
// Tighter zoom ranges = smaller tiles at off-range zooms.
const LAYERS = [
  { file: "seoul-city.geojson",      name: "city",        minZoom: 6,  maxZoom: 14 },
  { file: "seoul-sigg.geojson",      name: "districts",   minZoom: 6,  maxZoom: 14 },
  { file: "seoul-dong.geojson",      name: "dongs",       minZoom: 11, maxZoom: 14 },
  { file: "capital-sigg.geojson",    name: "neighbors",   minZoom: 6,  maxZoom: 14 },
  { file: "han-river.geojson",       name: "hanRiver",    minZoom: 8,  maxZoom: 14 },
  { file: "seoul-parks.geojson",     name: "parks",       minZoom: 10, maxZoom: 14 },
  { file: "seoul-roads-minor.geojson", name: "roadsMinor", minZoom: 12, maxZoom: 14 },
  { file: "seoul-buildings.geojson",   name: "buildings",  minZoom: 13, maxZoom: 14 },
  { file: "seoul-complexes.geojson",   name: "complexes",  minZoom: 11, maxZoom: 14 },
];

const TILE_MIN_ZOOM = 6;
const TILE_MAX_ZOOM = 14;

// Seoul bounding box (rough) — tiles outside are skipped.
const SEOUL_BOUNDS = { west: 126.7, east: 127.25, south: 37.4, north: 37.72 };

function lng2tile(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// ---------------------------------------------------------------------------
// 1. Build a tile index per layer (geojson-vt does the slicing + simplify).
// ---------------------------------------------------------------------------

console.log("Indexing layers...");
const indices = [];
for (const cfg of LAYERS) {
  const path = join(BOUNDARIES, cfg.file);
  try {
    statSync(path);
  } catch {
    console.warn(`  [skip] ${cfg.file} missing`);
    continue;
  }
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  const index = geojsonvt(json, {
    maxZoom: cfg.maxZoom,
    indexMaxZoom: cfg.maxZoom,
    indexMaxPoints: 0,    // index every feature, no clustering
    tolerance: 3,         // simplification (px) at maxZoom
    extent: 4096,         // MVT standard
    buffer: 64,           // tile edge padding (px)
    lineMetrics: false,
  });
  indices.push({ cfg, index });
  console.log(`  ${cfg.name.padEnd(11)} z${cfg.minZoom}-${cfg.maxZoom}  ${(raw.length / 1024).toFixed(0)} KB source`);
}

// ---------------------------------------------------------------------------
// 2. Walk the tile pyramid; emit a .pbf per non-empty tile.
// ---------------------------------------------------------------------------

let written = 0;
let totalBytes = 0;

for (let z = TILE_MIN_ZOOM; z <= TILE_MAX_ZOOM; z += 1) {
  const xMin = lng2tile(SEOUL_BOUNDS.west, z);
  const xMax = lng2tile(SEOUL_BOUNDS.east, z);
  const yMin = lat2tile(SEOUL_BOUNDS.north, z);
  const yMax = lat2tile(SEOUL_BOUNDS.south, z);

  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      // Collect features from every layer that covers this zoom.
      const tileLayers = {};
      for (const { cfg, index } of indices) {
        if (z < cfg.minZoom || z > cfg.maxZoom) continue;
        const tile = index.getTile(z, x, y);
        if (!tile || tile.features.length === 0) continue;
        tileLayers[cfg.name] = {
          ...tile,
          version: 2,
          name: cfg.name,
          extent: 4096,
        };
      }
      if (Object.keys(tileLayers).length === 0) continue;

      const buff = vtpbf.fromGeojsonVt(tileLayers, { version: 2 });
      const dir = join(OUTPUT, String(z), String(x));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${y}.pbf`);
      writeFileSync(file, buff);
      written += 1;
      totalBytes += buff.length;
    }
  }
  console.log(
    `  z${String(z).padStart(2)}: tiles ${String(written).padStart(5)} cumulative · ` +
      `${(totalBytes / 1024).toFixed(0)} KB total`,
  );
}

console.log(`\nDone. ${written} tiles · ${(totalBytes / 1024 / 1024).toFixed(2)} MB total`);
console.log(`Serve via: vite (public/tiles/*) — no server endpoint needed.`);
