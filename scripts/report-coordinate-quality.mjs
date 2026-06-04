import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as turf from "@turf/turf";
import { db, migrate } from "../server/db.mjs";

migrate();

const boundariesDir = path.resolve("public/boundaries");
const reportPath = path.resolve("docs/data-quality-report.md");
const maxRows = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 200);

function featureBbox(feature) {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(feature);
  return { minLng, minLat, maxLng, maxLat };
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function dongFamilyName(value) {
  return normalize(value).replace(/\d+동$/, "동");
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
    if (turf.booleanPointInPolygon(point, entry.feature)) return entry;
  }
  return null;
}

function issueType(row, districtAt, dongAt) {
  if (!districtAt) return "outside-seoul";
  if (normalize(row.district) !== normalize(districtAt.name)) return "district-mismatch";
  if (!dongAt) return "dong-missing";
  if (dongFamilyName(row.neighborhood) !== dongFamilyName(dongAt.name)) return "dong-mismatch";
  return null;
}

const [siggGeo, dongGeo] = await Promise.all([
  readFile(path.join(boundariesDir, "seoul-sigg.geojson"), "utf8").then(JSON.parse),
  readFile(path.join(boundariesDir, "seoul-dong.geojson"), "utf8").then(JSON.parse),
]);

const districts = siggGeo.features.map((feature) => ({
  id: String(feature.properties.id),
  name: feature.properties.name,
  feature,
  bbox: featureBbox(feature),
}));

const dongs = dongGeo.features.map((feature) => ({
  id: String(feature.properties.id),
  name: feature.properties.name,
  district: feature.properties.district,
  feature,
  bbox: featureBbox(feature),
}));

const rows = db
  .prepare(
    `
      SELECT id, name, district, neighborhood, address, lat, lng, geocode_source AS geocodeSource
      FROM apartment_complexes
      WHERE lat > 0 AND lng > 0
      ORDER BY district, neighborhood, name
    `,
  )
  .all();

const issues = [];
const counts = new Map();

for (const row of rows) {
  const districtAt = findRegionAt(row.lat, row.lng, districts);
  const dongAt = findRegionAt(row.lat, row.lng, dongs);
  const type = issueType(row, districtAt, dongAt);
  if (!type) continue;
  counts.set(type, (counts.get(type) ?? 0) + 1);
  issues.push({
    ...row,
    issue: type,
    coordinateDistrict: districtAt?.name ?? "-",
    coordinateDong: dongAt?.name ?? "-",
  });
}

const issueLines = issues.slice(0, maxRows).map((row) =>
  [
    row.issue,
    row.id,
    row.name,
    `${row.district} ${row.neighborhood}`,
    `${row.coordinateDistrict} ${row.coordinateDong}`,
    `${Number(row.lat).toFixed(6)}, ${Number(row.lng).toFixed(6)}`,
    row.geocodeSource ?? "-",
  ].join(" | "),
);

const markdown = `# Apartment Coordinate Data Quality Report

Generated: ${new Date().toISOString()}

This report compares each apartment complex's declared database region against the administrative district/dong that contains its stored latitude/longitude. Legal-dong to administrative-dong family differences, such as 개포동 to 개포4동, are treated as compatible.

## Summary

- Total complexes checked: ${rows.length.toLocaleString()}
- Complexes with coordinate/region issues: ${issues.length.toLocaleString()}
- Outside Seoul boundary: ${(counts.get("outside-seoul") ?? 0).toLocaleString()}
- District mismatch: ${(counts.get("district-mismatch") ?? 0).toLocaleString()}
- Dong boundary missing: ${(counts.get("dong-missing") ?? 0).toLocaleString()}
- Dong mismatch: ${(counts.get("dong-mismatch") ?? 0).toLocaleString()}

## Issue Sample

Showing up to ${maxRows.toLocaleString()} rows.

issue | id | name | declared region | coordinate region | lat/lng | geocode source
--- | --- | --- | --- | --- | --- | ---
${issueLines.length ? issueLines.join("\n") : "No issues found. | - | - | - | - | - | -"}

## Recommended Handling

- Keep the apartments API filtering strict so mismatched complexes do not leak into selected dong views.
- Re-geocode rows in this report before using them for apartment-level marker placement.
- When a coordinate is intentionally approximate, mark it in the geocode source field and avoid showing it as exact.
`;

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, markdown);

console.log(`checked=${rows.length} issues=${issues.length} report=${reportPath}`);
