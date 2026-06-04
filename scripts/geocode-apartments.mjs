import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

migrate();

const key = process.env.VITE_VWORLD_API_KEY;
if (!key) {
  console.error("VITE_VWORLD_API_KEY is missing.");
  process.exit(1);
}

for (const statement of [
  "ALTER TABLE apartment_complexes ADD COLUMN geocode_source TEXT",
  "ALTER TABLE apartment_complexes ADD COLUMN geocode_score REAL",
]) {
  try {
    db.exec(statement);
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }
}

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
const cachePath = path.resolve("data/geocode-cache.json");
const cache = existsSync(cachePath)
  ? JSON.parse(await readFile(cachePath, "utf8"))
  : {};

function scoreItem(item, complex) {
  const title = item.title ?? "";
  const category = item.category ?? "";
  const address = [item.address?.road, item.address?.parcel].filter(Boolean).join(" ");
  let score = 0;
  if (title.includes(complex.name) || complex.name.includes(title)) score += 50;
  if (address.includes(complex.district)) score += 15;
  if (address.includes(complex.neighborhood)) score += 20;
  if (category.includes("아파트")) score += 20;
  if (category.includes("공동주택")) score += 12;
  if (category.includes("시설구역경계")) score += 8;
  return score;
}

async function searchComplex(complex) {
  const query = `${complex.address} ${complex.name}`;
  const encoded = encodeURIComponent(query);
  const url =
    `https://api.vworld.kr/req/search?service=search&request=search&version=2.0` +
    `&crs=EPSG:4326&size=5&page=1&type=place&format=json&query=${encoded}&key=${encodeURIComponent(key)}`;
  const response = await fetch(url);
  const json = await response.json();
  const items = json?.response?.result?.items ?? [];
  if (items.length === 0) return null;
  return items
    .map((item) => ({ item, score: scoreItem(item, complex) }))
    .sort((a, b) => b.score - a.score)[0];
}

const rows = db
  .prepare(
    `
    SELECT id, name, district, neighborhood, address, lat, lng, geocode_source
    FROM apartment_complexes
    WHERE geocode_source IS NULL OR geocode_source != 'vworld-place'
    ORDER BY district, neighborhood, name
    ${limit > 0 ? "LIMIT @limit" : ""}
  `,
  )
  .all(limit > 0 ? { limit } : {});

const update = db.prepare(`
  UPDATE apartment_complexes
  SET lat = @lat,
      lng = @lng,
      address = COALESCE(@address, address),
      geocode_source = 'vworld-place',
      geocode_score = @score
  WHERE id = @id
`);

let updated = 0;
let missed = 0;

for (const [index, complex] of rows.entries()) {
  if (cache[complex.id]) {
    const cached = cache[complex.id];
    if (cached.ok) {
      update.run({ ...cached, id: complex.id });
      updated += 1;
    } else {
      missed += 1;
    }
    continue;
  }

  try {
    const result = await searchComplex(complex);
    if (!result || result.score < 20) {
      cache[complex.id] = { ok: false };
      missed += 1;
    } else {
      const item = result.item;
      const payload = {
        ok: true,
        lat: Number(item.point.y),
        lng: Number(item.point.x),
        address: item.address?.parcel || item.address?.road || null,
        score: result.score,
      };
      cache[complex.id] = payload;
      update.run({ ...payload, id: complex.id });
      updated += 1;
    }
  } catch {
    cache[complex.id] = { ok: false };
    missed += 1;
  }

  if ((index + 1) % 50 === 0) {
    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
    console.log(`Processed ${index + 1}/${rows.length}; updated=${updated}; missed=${missed}`);
  }
}

await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
console.log(`Geocoding complete. updated=${updated}; missed=${missed}; remaining=${Math.max(rows.length - updated - missed, 0)}`);
