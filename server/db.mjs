import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = path.resolve("data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "budongsan.sqlite"));
db.pragma("journal_mode = WAL");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apartment_complexes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      district TEXT NOT NULL,
      neighborhood TEXT NOT NULL,
      address TEXT NOT NULL,
      bjd_code TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      households INTEGER NOT NULL,
      buildings INTEGER NOT NULL,
      main_area TEXT NOT NULL,
      min_price REAL NOT NULL,
      max_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'AptListService3'
    );

    CREATE TABLE IF NOT EXISTS official_prices (
      id TEXT PRIMARY KEY,
      complex_id TEXT NOT NULL REFERENCES apartment_complexes(id) ON DELETE CASCADE,
      year TEXT NOT NULL,
      building TEXT NOT NULL,
      floor INTEGER NOT NULL,
      area REAL NOT NULL,
      price REAL NOT NULL
    );

  `);

  for (const statement of [
    "ALTER TABLE apartment_complexes ADD COLUMN bjd_code TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN geocode_source TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN geocode_score REAL",
    "ALTER TABLE apartment_complexes ADD COLUMN vworld_pnu TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN vworld_name TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN vworld_aphus_code TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN vworld_stdr_year TEXT",
    "ALTER TABLE official_prices ADD COLUMN ho TEXT",
    "ALTER TABLE official_prices ADD COLUMN price_won INTEGER",
    "ALTER TABLE official_prices ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'",
    "ALTER TABLE official_prices ADD COLUMN source_pnu TEXT",
    "ALTER TABLE official_prices ADD COLUMN source_aphus_code TEXT",
    "ALTER TABLE official_prices ADD COLUMN updated_at TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!String(error.message).includes("duplicate column name")) throw error;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_complexes_lat_lng ON apartment_complexes(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_complexes_bjd_code ON apartment_complexes(bjd_code);
    CREATE INDEX IF NOT EXISTS idx_complexes_vworld_pnu ON apartment_complexes(vworld_pnu);
    CREATE INDEX IF NOT EXISTS idx_complexes_district_neighborhood ON apartment_complexes(district, neighborhood);
    CREATE INDEX IF NOT EXISTS idx_prices_complex ON official_prices(complex_id);
    CREATE INDEX IF NOT EXISTS idx_prices_source ON official_prices(source, year);
    CREATE INDEX IF NOT EXISTS idx_prices_source_pnu ON official_prices(source_pnu);
  `);
}
