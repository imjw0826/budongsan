import { createReadStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { db, migrate } from "../server/db.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args.file ? path.resolve(String(args.file)) : "";
const outDir = path.resolve(String(args.out ?? "data/realtyprice/bulk-csv-seoul"));
const reset = Boolean(args.reset);
const limit = args.limit ? Number(args.limit) : Infinity;

if (!file) {
  console.error("Usage: npm run import:realtyprice-csv -- --file=/path/to/public-price.csv");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
migrate();
createTable();

if (reset) {
  db.prepare("DELETE FROM realtyprice_units WHERE source = 'data.go.kr-file'").run();
}

const unitsPath = path.join(outDir, "units.jsonl");
const manifestPath = path.join(outDir, "manifest.json");
if (reset) await writeFile(unitsPath, "");

const insertUnit = db.prepare(`
  INSERT OR REPLACE INTO realtyprice_units (
    id, year, notice_date_raw, notice_date, sido, district, legal_dong,
    bjd_code, apt_code, apt_name, building_code, building_name, ho_code,
    ho_name, floor, private_area, price_won, road_address, lot_address,
    full_address, x_coord, y_coord, ktown_ho_seq, raw_json, source
  ) VALUES (
    @id, @year, @noticeDateRaw, @noticeDate, @sido, @district, @legalDong,
    @bjdCode, @aptCode, @aptName, @buildingCode, @buildingName, @hoCode,
    @hoName, @floor, @privateArea, @priceWon, @roadAddress, @lotAddress,
    @fullAddress, @xCoord, @yCoord, @ktownHoSeq, @rawJson, 'data.go.kr-file'
  )
`);

const insertBatch = db.transaction((rows) => {
  for (const row of rows) insertUnit.run(row);
});

let headers = null;
let totalRows = 0;
let seoulRows = 0;
let writtenRows = 0;
let batch = [];
let jsonBuffer = [];

const stream = createReadStream(file, { encoding: "utf8" });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

console.log(`Importing ${file}`);

for await (const line of rl) {
  if (!line.trim()) continue;
  const values = parseCsvLine(line);
  if (!headers) {
    headers = values.map((value) => stripBom(value).trim());
    continue;
  }

  totalRows += 1;
  const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  const normalized = normalizeRow(raw, totalRows);
  if (!normalized) continue;
  if (normalized.sido !== "서울특별시") continue;

  seoulRows += 1;
  batch.push(normalized);
  jsonBuffer.push(`${JSON.stringify(normalized)}\n`);
  writtenRows += 1;

  if (batch.length >= 5000) {
    insertBatch(batch);
    await appendFile(unitsPath, jsonBuffer.join(""));
    batch = [];
    jsonBuffer = [];
    console.log(`  rows=${totalRows.toLocaleString()} seoul=${seoulRows.toLocaleString()}`);
  }

  if (writtenRows >= limit) break;
}

if (batch.length > 0) {
  insertBatch(batch);
  await appendFile(unitsPath, jsonBuffer.join(""));
}

await writeFile(
  manifestPath,
  JSON.stringify(
    {
      source: "국토교통부_주택 공시가격 정보 fileData",
      sourceUrl: "https://www.data.go.kr/data/3073746/fileData.do",
      importedAt: new Date().toISOString(),
      input: file,
      output: {
        units: path.relative(process.cwd(), unitsPath),
        sqlite: "data/budongsan.sqlite table realtyprice_units",
      },
      counts: { totalRows, seoulRows, writtenRows },
    },
    null,
    2,
  ),
);

console.log(`Done. total=${totalRows} seoul=${seoulRows} written=${writtenRows}`);

function normalizeRow(raw, rowNumber) {
  const sido = pick(raw, ["시도", "시도명", "광역시도", "sido"]);
  const district = pick(raw, ["시군구", "시군구명", "시군구명칭", "sgg"]);
  const legalDong = pick(raw, ["읍면동", "동리", "법정동", "법정동명", "emd"]);
  const aptName = pick(raw, ["단지명", "공동주택명", "아파트명", "apt_name"]);
  const buildingName = pick(raw, ["동명", "건물동명", "동", "dong_name"]) || "동명없음";
  const hoName = pick(raw, ["호명", "호", "호수", "ho_name"]);
  const priceWon = parsePrice(pick(raw, ["공동주택가격", "공시가격", "가격", "notice_amt"]));

  if (!sido || !aptName || !hoName || priceWon == null) return null;

  const baseYear = pick(raw, ["기준연도", "기준년도", "공시년도", "year"]);
  const baseMonth = pick(raw, ["기준월"]);
  const noticeDate =
    pick(raw, ["공시기준일자", "기준일자", "공시일자", "notice_date"]) ||
    (baseYear && baseMonth ? `${baseYear}.${String(baseMonth).padStart(2, "0")}` : "") ||
    pick(raw, ["기준년월"]);
  const year = baseYear || String(noticeDate).match(/\d{4}/)?.[0] || "";
  const privateArea = parseFloat(pick(raw, ["전용면적", "전용면적(㎡)", "전용면적(m2)", "면적"]));
  const roadAddress = clean(pick(raw, ["도로명주소", "도로명", "full_road_name"]));
  const lotAddress = clean(pick(raw, ["지번주소", "소재지", "지번", "short_addr_name"]));
  const fullAddress = clean(pick(raw, ["주소", "전체주소", "full_addr_name"])) || roadAddress || lotAddress;
  const bjdCode = pick(raw, ["법정동코드", "토지고유번호", "PNU", "pnu", "bjd_code"]);
  const aptCode = pick(raw, ["단지코드", "공동주택코드", "apt_code"]) || stableHash(`${sido}:${district}:${legalDong}:${aptName}`);
  const buildingCode = pick(raw, ["동코드", "building_code"]) || stableHash(`${aptCode}:${buildingName}`);
  const hoCode = pick(raw, ["호코드", "ho_code"]) || stableHash(`${aptCode}:${buildingName}:${hoName}`);
  const ktownHoSeq = pick(raw, ["관리건축물대장PK", "건축물대장PK", "ktown_ho_seq"]);

  return {
    id: `data-go-kr-2025:${rowNumber}`,
    year,
    noticeDateRaw: clean(noticeDate),
    noticeDate: clean(noticeDate),
    sido,
    district,
    legalDong,
    bjdCode,
    aptCode,
    aptName,
    buildingCode,
    buildingName,
    hoCode,
    hoName,
    floor: parseFloor(hoName),
    privateArea: Number.isFinite(privateArea) ? privateArea : null,
    priceWon,
    roadAddress,
    lotAddress,
    fullAddress,
    xCoord: null,
    yCoord: null,
    ktownHoSeq: ktownHoSeq || null,
    rawJson: JSON.stringify(raw),
  };
}

function createTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtyprice_units (
      id TEXT PRIMARY KEY,
      year TEXT NOT NULL,
      notice_date_raw TEXT NOT NULL,
      notice_date TEXT NOT NULL,
      sido TEXT NOT NULL,
      district TEXT NOT NULL,
      legal_dong TEXT NOT NULL,
      bjd_code TEXT NOT NULL,
      apt_code TEXT NOT NULL,
      apt_name TEXT NOT NULL,
      building_code TEXT NOT NULL,
      building_name TEXT NOT NULL,
      ho_code TEXT NOT NULL,
      ho_name TEXT NOT NULL,
      floor INTEGER,
      private_area REAL,
      price_won INTEGER,
      road_address TEXT,
      lot_address TEXT,
      full_address TEXT,
      x_coord REAL,
      y_coord REAL,
      ktown_ho_seq TEXT,
      raw_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'realtyprice-crawler'
    );
  `);

  try {
    db.exec("ALTER TABLE realtyprice_units ADD COLUMN source TEXT NOT NULL DEFAULT 'realtyprice-crawler'");
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_realtyprice_addr ON realtyprice_units(district, legal_dong, apt_name);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_codes ON realtyprice_units(apt_code, building_code, ho_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_bjd ON realtyprice_units(bjd_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_floor ON realtyprice_units(apt_code, building_name, floor);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_source ON realtyprice_units(source);
  `);
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function pick(raw, names) {
  for (const name of names) {
    if (raw[name] != null && String(raw[name]).trim() !== "") return clean(raw[name]);
  }
  return "";
}

function parsePrice(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function parseFloor(hoName) {
  const tail = String(hoName).split("-").at(-1) ?? "";
  const match = tail.match(/\d+/);
  if (!match) return null;
  return Math.floor(Number(match[0]) / 100);
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const index = body.indexOf("=");
    if (index === -1) result[body] = true;
    else result[body.slice(0, index)] = body.slice(index + 1);
  }
  return result;
}
