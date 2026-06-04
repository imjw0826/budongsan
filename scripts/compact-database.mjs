import { db, migrate } from "../server/db.mjs";

migrate();

function count(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function sourceCounts() {
  return db
    .prepare(
      `
      SELECT source, COUNT(*) AS n
      FROM realtyprice_units
      GROUP BY source
      ORDER BY n DESC
    `,
    )
    .all();
}

function duplicateOfficialRows() {
  return db
    .prepare(
      `
      SELECT COALESCE(SUM(cnt) - COUNT(*), 0) AS n
      FROM (
        SELECT COUNT(*) AS cnt
        FROM official_prices
        GROUP BY complex_id, year, building, floor, area, price
        HAVING cnt > 1
      )
    `,
    )
    .get().n;
}

const before = {
  apartmentComplexes: count("apartment_complexes"),
  officialPrices: count("official_prices"),
  realtypriceUnits: count("realtyprice_units"),
  realtypriceSummary: count("realtyprice_complex_summary"),
  sources: sourceCounts(),
  duplicateOfficialRows: duplicateOfficialRows(),
};

db.transaction(() => {
  db.prepare("DELETE FROM realtyprice_units WHERE source <> 'data.go.kr-file'").run();

  db.exec(`
    DELETE FROM official_prices
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM official_prices
      GROUP BY complex_id, year, building, floor, area, price
    );

    DELETE FROM realtyprice_complex_summary;

    INSERT INTO realtyprice_complex_summary (
      match_key,
      district,
      legal_dong,
      apt_name,
      unit_count,
      min_price_won,
      max_price_won,
      avg_price_won,
      min_area,
      max_area,
      latest_notice_date,
      apt_code
    )
    SELECT
      district || '|' || legal_dong || '|' || lower(replace(replace(apt_name, ' ', ''), '아파트', '')),
      district,
      legal_dong,
      apt_name,
      COUNT(*),
      MIN(price_won),
      MAX(price_won),
      AVG(price_won),
      MIN(private_area),
      MAX(private_area),
      MAX(notice_date),
      MIN(apt_code)
    FROM realtyprice_units
    WHERE source = 'data.go.kr-file'
    GROUP BY district, legal_dong, lower(replace(replace(apt_name, ' ', ''), '아파트', ''));
  `);
})();

db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");
db.pragma("optimize");
db.pragma("wal_checkpoint(TRUNCATE)");

const after = {
  apartmentComplexes: count("apartment_complexes"),
  officialPrices: count("official_prices"),
  realtypriceUnits: count("realtyprice_units"),
  realtypriceSummary: count("realtyprice_complex_summary"),
  sources: sourceCounts(),
  duplicateOfficialRows: duplicateOfficialRows(),
};

console.log(JSON.stringify({ before, after }, null, 2));
