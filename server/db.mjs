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

    CREATE TABLE IF NOT EXISTS realtyprice_units (
      id TEXT PRIMARY KEY,
      year TEXT,
      notice_date TEXT,
      notice_date_raw TEXT,
      bjd_code TEXT,
      sido TEXT,
      district TEXT,
      legal_dong TEXT,
      apt_name TEXT,
      apt_code TEXT,
      building_name TEXT,
      building_code TEXT,
      ho_name TEXT,
      ho_code TEXT,
      floor INTEGER,
      private_area REAL,
      price_won INTEGER,
      road_address TEXT,
      lot_address TEXT,
      source TEXT NOT NULL DEFAULT 'realtyprice-crawler',
      crawled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS realtyprice_complex_summary (
      match_key TEXT PRIMARY KEY,
      district TEXT NOT NULL,
      legal_dong TEXT NOT NULL,
      apt_name TEXT NOT NULL,
      unit_count INTEGER NOT NULL,
      min_price_won INTEGER,
      max_price_won INTEGER,
      avg_price_won REAL,
      min_area REAL,
      max_area REAL,
      latest_notice_date TEXT,
      apt_code TEXT
    );

  `);

  for (const statement of [
    "ALTER TABLE apartment_complexes ADD COLUMN bjd_code TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN geocode_source TEXT",
    "ALTER TABLE apartment_complexes ADD COLUMN geocode_score REAL",
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
    CREATE INDEX IF NOT EXISTS idx_complexes_district_neighborhood ON apartment_complexes(district, neighborhood);
    CREATE INDEX IF NOT EXISTS idx_prices_complex ON official_prices(complex_id);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_addr ON realtyprice_units(district, legal_dong, apt_name);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_codes ON realtyprice_units(apt_code, building_code, ho_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_bjd ON realtyprice_units(bjd_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_floor ON realtyprice_units(apt_code, building_name, floor);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_source ON realtyprice_units(source);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_summary_region ON realtyprice_complex_summary(district, legal_dong);
  `);
}
