#!/usr/bin/env node
// Reduce GeoJSON file size by:
//   1. Rounding all coordinates to a fixed decimal precision.
//   2. Stripping properties that the renderer never reads.
//
// At Seoul latitude (~37.5°N), 5 decimals = ~1.1 m horizontal — far below
// the smallest visible pixel at our max zoom, so visual quality is unchanged.
//
// Usage:
//   node scripts/optimize-boundaries.mjs           # in-place rewrite
//   node scripts/optimize-boundaries.mjs --dry     # report-only
//   node scripts/optimize-boundaries.mjs --out=tmp # write next to original as *.opt.geojson
//
// Re-run after `scripts/fetch-*.mjs` regenerates the upstream files.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BOUNDARIES = join(ROOT, "public", "boundaries");

const PRECISION = 5; // decimals; 5 → ~1.1 m at Seoul lat

/**
 * Per-file kept-property whitelist. Any property not in this list is removed.
 * Properties read by the renderer were identified by grepping `feature.properties.*`
 * in src/. When you add a new use site, update this list.
 */
const KEEP_PROPS = {
  "seoul-buildings": new Set(["id", "complexId"]),
  "seoul-roads-minor": new Set(["id"]),
  "seoul-parks": new Set(["id"]),
  "seoul-complexes": new Set([
    "id",
    "name",
    "district",
    "neighborhood",
    "avgPrice",
    "households",
    "buildingCount",
    "rank",
  ]),
  "seoul-dong": new Set(["id", "name", "district", "center"]),
  "seoul-sigg": new Set(["id", "name", "code", "center"]),
  "seoul-city": new Set(["id", "name", "center"]),
  "han-river": new Set(["id", "name"]),
  "capital-sigg": new Set(["id", "name", "sido", "code", "center"]),
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const outSuffix = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? null;

function roundCoord(value) {
  // Math.round is faster than toFixed (no string conversion) and produces a
  // value JSON.stringify renders without trailing zeros.
  const f = 10 ** PRECISION;
  return Math.round(value * f) / f;
}

function roundCoords(node) {
  if (typeof node === "number") return node; // shouldn't reach with valid GeoJSON
  if (!Array.isArray(node)) return node;
  if (typeof node[0] === "number" && typeof node[1] === "number") {
    // [lng, lat] or [lng, lat, alt] — leave alt untouched
    const out = [roundCoord(node[0]), roundCoord(node[1])];
    if (node.length > 2) out.push(node[2]);
    return out;
  }
  return node.map(roundCoords);
}

function roundCenter(prop) {
  if (!Array.isArray(prop) || prop.length < 2) return prop;
  return [roundCoord(prop[0]), roundCoord(prop[1])];
}

function optimiseFile(name) {
  const path = join(BOUNDARIES, `${name}.geojson`);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }

  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  const keep = KEEP_PROPS[name];

  for (const feature of json.features ?? []) {
    if (feature.geometry?.coordinates) {
      feature.geometry.coordinates = roundCoords(feature.geometry.coordinates);
    }
    if (feature.properties && keep) {
      const trimmed = {};
      for (const k of Object.keys(feature.properties)) {
        if (!keep.has(k)) continue;
        let v = feature.properties[k];
        if (k === "center") v = roundCenter(v);
        trimmed[k] = v;
      }
      feature.properties = trimmed;
    }
  }

  const next = JSON.stringify(json);
  const before = stat.size;
  const after = next.length;

  if (!dryRun) {
    const writePath = outSuffix ? path.replace(/\.geojson$/, `.${outSuffix}.geojson`) : path;
    writeFileSync(writePath, next);
  }

  return { name, before, after };
}

const targets = Object.keys(KEEP_PROPS);
const rows = [];
let totalBefore = 0;
let totalAfter = 0;

for (const name of targets) {
  const result = optimiseFile(name);
  if (!result) {
    console.warn(`[skip] ${name}.geojson not present`);
    continue;
  }
  rows.push(result);
  totalBefore += result.before;
  totalAfter += result.after;
}

const fmt = (n) => `${(n / 1024).toFixed(0).padStart(7)} KB`;
const pct = (b, a) => `${(((b - a) / b) * 100).toFixed(1).padStart(5)}%`;

console.log(`\nGeoJSON optimisation${dryRun ? " (dry run)" : ""} — precision=${PRECISION} decimals\n`);
console.log("name".padEnd(22), "before".padStart(11), "after".padStart(11), "saved".padStart(7));
for (const r of rows) {
  console.log(r.name.padEnd(22), fmt(r.before), fmt(r.after), pct(r.before, r.after));
}
console.log("-".repeat(54));
console.log("total".padEnd(22), fmt(totalBefore), fmt(totalAfter), pct(totalBefore, totalAfter));
console.log();
