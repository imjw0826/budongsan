import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

const BASE_URL = "https://www.realtyprice.kr/notice";
const SOURCE_URL = `${BASE_URL}/town/searchObjection.htm`;
const DEFAULT_YEAR = "2026";
const DEFAULT_NOTICE_DATE = "20260430";
const SEOUL_DISTRICTS = [
  { code: "11680", name: "강남구" },
  { code: "11740", name: "강동구" },
  { code: "11305", name: "강북구" },
  { code: "11500", name: "강서구" },
  { code: "11620", name: "관악구" },
  { code: "11215", name: "광진구" },
  { code: "11530", name: "구로구" },
  { code: "11545", name: "금천구" },
  { code: "11350", name: "노원구" },
  { code: "11320", name: "도봉구" },
  { code: "11230", name: "동대문구" },
  { code: "11590", name: "동작구" },
  { code: "11440", name: "마포구" },
  { code: "11410", name: "서대문구" },
  { code: "11650", name: "서초구" },
  { code: "11200", name: "성동구" },
  { code: "11290", name: "성북구" },
  { code: "11710", name: "송파구" },
  { code: "11470", name: "양천구" },
  { code: "11560", name: "영등포구" },
  { code: "11170", name: "용산구" },
  { code: "11380", name: "은평구" },
  { code: "11110", name: "종로구" },
  { code: "11140", name: "중구" },
  { code: "11260", name: "중랑구" },
];

const args = parseArgs(process.argv.slice(2));
const year = String(args.year ?? DEFAULT_YEAR);
const noticeDate = String(args["notice-date"] ?? DEFAULT_NOTICE_DATE);
const delayMs = Number(args.delay ?? 260);
const requestTimeoutMs = Number(args["request-timeout"] ?? 20000);
const outDir = path.resolve(String(args.out ?? `data/realtyprice/seoul-${year}-${noticeDate}`));
const districtFilter = args.district ? String(args.district) : "";
const districtFilters = args.districts
  ? String(args.districts)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  : districtFilter
    ? [districtFilter]
    : [];
const roadFilter = args.road ? String(args.road) : "";
const limitComplexes = args["limit-complexes"] ? Number(args["limit-complexes"]) : Infinity;
const limitUnits = args["limit-units"] ? Number(args["limit-units"]) : Infinity;
const minHouseholds = args["min-households"] ? Number(args["min-households"]) : 0;
const reset = Boolean(args.reset);

const districtsDir = path.join(outDir, "districts");
mkdirSync(districtsDir, { recursive: true });
migrate();
createTable();

const unitsPath = path.join(outDir, "units.jsonl");
const completedPath = path.join(outDir, "completed-houses.txt");
const manifestPath = path.join(outDir, "manifest.json");

if (reset) {
  for (const file of [unitsPath, completedPath, manifestPath]) {
    if (existsSync(file)) writeFileSync(file, "");
  }
  for (const district of SEOUL_DISTRICTS) {
    const file = districtFilePath(district.name);
    if (existsSync(file)) writeFileSync(file, "");
  }
  db.prepare(
    "DELETE FROM realtyprice_units WHERE year = ? AND notice_date_raw = ? AND source = ?",
  ).run(year, noticeDate, "realtyprice-road-crawler");
}

const completed = await loadCompleted(completedPath);
const unitStream = createWriteStream(unitsPath, { flags: "a" });
let completedHouses = completed.size;
let skippedCompleted = 0;
let scannedDistricts = 0;
let scannedRoads = 0;
let scannedComplexes = 0;
let skippedSmallComplexes = 0;
let writtenRows = 0;
let activeDistrictDoc = null;

const insertUnit = db.prepare(`
  INSERT OR REPLACE INTO realtyprice_units (
    id, year, notice_date_raw, notice_date, sido, district, legal_dong,
    bjd_code, apt_code, apt_name, building_code, building_name, ho_code,
    ho_name, floor, private_area, price_won, road_address, lot_address,
    full_address, x_coord, y_coord, ktown_ho_seq, raw_json, source, crawled_at
  ) VALUES (
    @id, @year, @noticeDateRaw, @noticeDate, @sido, @district, @legalDong,
    @bjdCode, @aptCode, @aptName, @buildingCode, @buildingName, @hoCode,
    @hoName, @floor, @privateArea, @priceWon, @roadAddress, @lotAddress,
    @fullAddress, @xCoord, @yCoord, @ktownHoSeq, @rawJson, @source, @crawledAt
  )
`);

const insertTransaction = db.transaction((rows) => {
  for (const row of rows) insertUnit.run(row);
});

try {
  await crawl();
} finally {
  if (activeDistrictDoc) await writeDistrictDoc(activeDistrictDoc);
  await flushManifest();
  unitStream.end();
}

async function crawl() {
  console.log(
    `Starting RealtyPrice road crawl: Seoul ${year}/${noticeDate}` +
      `${districtFilters.length > 0 ? ` districts=${districtFilters.join(",")}` : ""}` +
      `${roadFilter ? ` road=${roadFilter}` : ""}` +
      `${minHouseholds > 0 ? ` min-households=${minHouseholds}` : ""}` +
      ` request-timeout=${requestTimeoutMs}ms`,
  );

  const districts = selectDistricts(await fetchRoadDistricts());

  for (const district of districts) {
    scannedDistricts += 1;
    activeDistrictDoc = loadDistrictDoc(district);
    console.log(`District: ${district.name}`);

    const initials = await fetchRoadInitials(district);
    for (const initial of initials) {
      const roads = (await fetchRoads(district, initial.code)).filter(
        (item) => !roadFilter || item.name === roadFilter || item.code === roadFilter,
      );

      for (const road of roads) {
        if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) return;
        scannedRoads += 1;
        upsertRoad(activeDistrictDoc, initial, road);

        const complexes = await fetchRoadComplexes(district, initial.code, road);
        if (complexes.length === 0) continue;
        console.log(`  Road: ${road.name} complexes=${complexes.length}`);

        for (const complex of complexes) {
          if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) return;
          scannedComplexes += 1;

          const buildings = await fetchBuildings({ district, initial: initial.code, road, complex });
          const aptName = stripBunji(complex.name);
          console.log(
            `    [${scannedComplexes}] ${aptName} buildings=${buildings.length}`,
          );

          const buildingHouseGroups = [];
          let householdCount = 0;
          for (const building of buildings) {
            const houses = await fetchHouses({ district, initial: initial.code, road, complex, building });
            console.log(`      ${building.name}: houses=${houses.length}`);
            buildingHouseGroups.push({ building, houses });
            householdCount += houses.length;
          }

          if (minHouseholds > 0 && householdCount < minHouseholds) {
            skippedSmallComplexes += 1;
            console.log(`      skip ${aptName}: households=${householdCount} < ${minHouseholds}`);
            await flushManifest();
            continue;
          }

          const complexDoc = upsertComplex(activeDistrictDoc, {
            district,
            initial,
            road,
            complex,
            householdCount,
          });

          for (const { building, houses } of buildingHouseGroups) {
            for (const house of houses) {
              if (writtenRows >= limitUnits) return;
              const houseKey = [
                district.code,
                road.code,
                complex.code,
                building.code,
                house.code,
                complex.notice_date ?? noticeDate,
              ].join(":");

              if (completed.has(houseKey)) {
                skippedCompleted += 1;
                continue;
              }

              const rows = await fetchPriceRows({ district, initial: initial.code, road, complex, building, house });
              const normalizedRows = rows.map((row) =>
                normalizePriceRow({ row, district, initial, road, complex, building, house }),
              );

              if (normalizedRows.length > 0) {
                insertTransaction(normalizedRows);
                for (const item of normalizedRows) {
                  unitStream.write(`${JSON.stringify(item)}\n`);
                  appendUnitToComplex(complexDoc, item);
                  writtenRows += 1;
                }
              }

              completed.add(houseKey);
              completedHouses += 1;
              await appendFile(completedPath, `${houseKey}\n`);

              if (completedHouses % 100 === 0) {
                await writeDistrictDoc(activeDistrictDoc);
                await flushManifest();
                console.log(
                  `      progress houses=${completedHouses} rows=${writtenRows} skipped=${skippedCompleted}`,
                );
              }
              await sleep(delayMs);
            }
          }

          await writeDistrictDoc(activeDistrictDoc);
          await flushManifest();
        }
      }
    }

    await writeDistrictDoc(activeDistrictDoc);
  }
}

async function fetchRoadDistricts() {
  const districts = await fetchList(
    "/road/searchRoadTown.road",
    roadParams({ gbn: "SIGUNGU", sido: "11" }),
  );
  return districts.length > 0 ? districts : SEOUL_DISTRICTS;
}

function selectDistricts(items) {
  if (districtFilters.length === 0) return items;

  const selected = [];
  const seen = new Set();
  for (const filter of districtFilters) {
    const district = items.find((item) => item.name === filter || item.code === filter);
    if (!district) {
      console.warn(`District filter did not match: ${filter}`);
      continue;
    }

    const key = String(district.code || district.name);
    if (seen.has(key)) continue;
    selected.push(district);
    seen.add(key);
  }
  return selected;
}

async function fetchRoadInitials(district) {
  return fetchList(
    "/road/searchRoadTown.road",
    roadParams({ gbn: "INITIALWORD", sido: "11", sigungu: district.code }),
  );
}

async function fetchRoads(district, initial) {
  return fetchList(
    "/road/searchRoadTown.road",
    roadParams({ gbn: "ROAD", sido: "11", sigungu: district.code, initial }),
  );
}

async function fetchRoadComplexes(district, initial, road) {
  return fetchList(
    "/search/searchApt.search",
    searchParams({ district, initial, road, gbnApt: "" }),
  );
}

async function fetchBuildings({ district, initial, road, complex }) {
  return fetchList(
    "/search/searchApt.search",
    searchParams({
      district,
      initial,
      road,
      gbnApt: "DONG",
      aptCode: complex.code,
      selectedNoticeDate: complex.notice_date ?? noticeDate,
    }),
  );
}

async function fetchHouses({ district, initial, road, complex, building }) {
  return fetchList(
    "/search/searchApt.search",
    searchParams({
      district,
      initial,
      road,
      gbnApt: "HO",
      aptCode: complex.code,
      dongCode: building.code,
      selectedNoticeDate: complex.notice_date ?? noticeDate,
    }),
  );
}

async function fetchPriceRows({ district, initial, road, complex, building, house }) {
  return fetchList("/search/townPriceListMap.search", {
    page_no: "1",
    reg_name: "",
    sreg: "",
    seub: "",
    old_reg: "",
    old_eub: "",
    gbn: "0",
    year,
    notice_date: String(complex.notice_date ?? noticeDate),
    reg: "",
    eub: "",
    apt_name: "",
    bun1: "",
    bun2: "",
    road_code: String(road.code),
    initialword: initial,
    build_bun1: "",
    build_bun2: "",
    gbnApt: "HO",
    apt_code: String(complex.code),
    dong_code: String(building.code),
    ho_code: String(house.code),
    tabGbn: "Text",
    full_addr_name: "",
    dong_name: "",
    ho_name: "",
    notice_amt: "",
    ktown_ho_seq: "",
    past_yn: "0",
    print_yn: "0",
    searchGbnRoad: "1",
    searchGbnBunji: "",
    searchGbnBunjiYear: "",
    capcha: "",
    capcha_chk_yn: "N",
    referrer: "OB",
  });
}

function roadParams({ gbn, sido = "11", sigungu = "", initial = "", road = "" }) {
  return {
    p_gbn: gbn,
    p_sido: sido,
    p_sigungu: sigungu,
    p_initialword: initial,
    p_road: road,
    sido,
    sigungu,
    initialword: initial,
    road,
    rdoCondiRoad: "1",
    build_bun1: "",
    build_bun2: "",
    apt_name: "",
  };
}

function searchParams({
  district,
  initial,
  road,
  gbnApt,
  aptCode = "",
  dongCode = "",
  hoCode = "",
  selectedNoticeDate = "",
}) {
  return {
    gbn: "0",
    year,
    notice_date: selectedNoticeDate,
    notice_date_year: noticeDate,
    gbnApt,
    road_reg: district.code,
    road: road.code,
    initialword: initial,
    build_bun1: "",
    build_bun2: "",
    reg: "",
    eub: "",
    apt_name: "",
    bun1: "",
    bun2: "",
    apt_code: String(aptCode),
    dong_code: String(dongCode),
    ho_code: String(hoCode),
    init_gbn: "N",
    past_yn: "0",
    searchGbnRoad: "1",
    searchGbnBunji: "",
    searchGbnBunjiYear: "",
  };
}

async function fetchList(endpoint, params) {
  const json = await fetchJson(endpoint, params);
  const message = json?.model?.message;
  if (message) {
    throw new Error(`${message}${json.model.error_gbn ? ` (${json.model.error_gbn})` : ""}`);
  }
  return Array.isArray(json?.model?.list) ? json.model.list : [];
}

async function fetchJson(endpoint, params, attempt = 1) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value == null ? "" : String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Accept: "application/json,text/javascript,*/*;q=0.01",
        "User-Agent": "budongsan-research-crawler/0.2",
        "X-Requested-With": "XMLHttpRequest",
        Referer: SOURCE_URL,
      },
    });
  } catch (error) {
    if (attempt < 5) {
      console.warn(
        `Retry ${attempt}/4 ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(1000 * attempt);
      return fetchJson(endpoint, params, attempt + 1);
    }
    throw error;
  }

  if (!response.ok) {
    if (attempt < 5) {
      console.warn(`Retry ${attempt}/4 ${endpoint}: HTTP ${response.status}`);
      await sleep(1000 * attempt);
      return fetchJson(endpoint, params, attempt + 1);
    }
    throw new Error(`${endpoint} HTTP ${response.status}`);
  }

  return response.json();
}

function loadDistrictDoc(district) {
  const file = districtFilePath(district.name);
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (text) return JSON.parse(text);
  }
  return {
    source: SOURCE_URL,
    fetchedAt: null,
    year,
    noticeDate,
    sido: "서울특별시",
    district: { code: district.code, name: district.name },
    roads: [],
    complexes: [],
    counts: {
      roads: 0,
      complexes: 0,
      units: 0,
      priceRows: 0,
    },
  };
}

async function writeDistrictDoc(doc) {
  doc.fetchedAt = new Date().toISOString();
  doc.counts = {
    roads: doc.roads.length,
    complexes: doc.complexes.length,
    units: doc.complexes.reduce((sum, complex) => sum + complex.units.length, 0),
    priceRows: doc.complexes.reduce(
      (sum, complex) =>
        sum + complex.units.reduce((unitSum, unit) => unitSum + unit.prices.length, 0),
      0,
    ),
  };
  await writeFile(districtFilePath(doc.district.name), `${JSON.stringify(doc, null, 2)}\n`);
}

async function flushManifest() {
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        source: SOURCE_URL,
        fetchedAt: new Date().toISOString(),
        year,
        noticeDate,
        scope: {
          sido: "서울특별시",
          district: districtFilters.length > 0 ? districtFilters.join(",") : "ALL",
          road: roadFilter || "ALL",
          minHouseholds: minHouseholds || null,
        },
        files: {
          districts: path.relative(process.cwd(), districtsDir),
          units: path.relative(process.cwd(), unitsPath),
          completedHouses: path.relative(process.cwd(), completedPath),
          sqlite: "data/budongsan.sqlite table realtyprice_units",
        },
        counts: {
          scannedDistricts,
          scannedRoads,
          scannedComplexes,
          completedHouses,
          skippedCompleted,
          skippedSmallComplexes,
          writtenRows,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function upsertRoad(doc, initial, road) {
  let target = doc.roads.find((item) => item.code === String(road.code));
  if (!target) {
    target = {
      code: String(road.code),
      name: String(road.name),
      initial: String(initial.code),
    };
    doc.roads.push(target);
  }
  return target;
}

function upsertComplex(doc, { district, initial, road, complex, householdCount }) {
  const aptCode = String(complex.code);
  let target = doc.complexes.find((item) => item.aptCode === aptCode);
  if (!target) {
    const sourceName = String(complex.name ?? "");
    target = {
      aptCode,
      aptName: stripBunji(sourceName),
      sourceName,
      sido: "서울특별시",
      sigunguCode: String(district.code),
      sigungu: String(district.name),
      roadCode: String(road.code),
      roadName: String(road.name),
      roadInitial: String(initial.code),
      detailAddress: cleanDetailAddress(complex.bunji || extractParenthetical(sourceName)),
      noticeDate: String(complex.notice_date ?? noticeDate),
      xCoord: Number(complex.x_coord ?? 0) || null,
      yCoord: Number(complex.y_coord ?? 0) || null,
      households: householdCount ?? null,
      units: [],
    };
    doc.complexes.push(target);
  } else if (householdCount != null && target.households == null) {
    target.households = householdCount;
  }
  return target;
}

function appendUnitToComplex(complexDoc, row) {
  let unit = complexDoc.units.find(
    (item) => item.buildingCode === row.buildingCode && item.hoCode === row.hoCode,
  );
  if (!unit) {
    unit = {
      buildingCode: row.buildingCode,
      buildingName: row.buildingName,
      hoCode: row.hoCode,
      hoName: row.hoName,
      floor: row.floor,
      privateArea: row.privateArea,
      roadAddress: row.roadAddress,
      lotAddress: row.lotAddress,
      fullAddress: row.fullAddress,
      ktownHoSeq: row.ktownHoSeq,
      prices: [],
    };
    complexDoc.units.push(unit);
  }

  if (!unit.prices.some((price) => price.noticeDate === row.noticeDate)) {
    unit.prices.push({
      year: row.year,
      noticeDate: row.noticeDate,
      noticeDateRaw: row.noticeDateRaw,
      priceWon: row.priceWon,
    });
  }
}

function normalizePriceRow({ row, district, road, complex, building, house }) {
  const noticeDateText = String(row.notice_date ?? row.notice_date_name ?? "");
  const priceWon = parsePrice(row.notice_amt);
  const hoName = String(row.ho_name || house.name || "");
  const aptName = String(row.apt_name || stripBunji(complex.name));
  const buildingName = String(row.dong_name || building.name || "");
  const id = [
    row.ktown_ho_seq || house.code,
    row.notice_date || noticeDateText,
    row.apt_code || complex.code,
    row.dong_code || building.code,
    row.ho_code || house.code,
  ].join(":");

  return {
    id,
    year: noticeDateText.slice(0, 4) || year,
    noticeDateRaw: String(complex.notice_date ?? noticeDate),
    noticeDate: noticeDateText,
    sido: "서울특별시",
    district: district.name,
    legalDong: parseLegalDong(row.short_addr_name),
    bjdCode: String(row.reg || district.code),
    aptCode: String(row.apt_code || complex.code),
    aptName,
    buildingCode: String(row.dong_code || building.code),
    buildingName,
    hoCode: String(row.ho_code || house.code),
    hoName,
    floor: parseFloor(hoName),
    privateArea: parseFloat(String(row.priv_area ?? "")) || null,
    priceWon,
    roadAddress: clean(row.full_road_name) || `서울특별시 ${district.name} ${road.name}`,
    lotAddress: clean(row.short_addr_name),
    fullAddress: clean(row.full_addr_name),
    xCoord: Number(complex.x_coord ?? 0) || null,
    yCoord: Number(complex.y_coord ?? 0) || null,
    ktownHoSeq: row.ktown_ho_seq ? String(row.ktown_ho_seq) : null,
    rawJson: JSON.stringify(row),
    source: "realtyprice-road-crawler",
    crawledAt: new Date().toISOString(),
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
      source TEXT NOT NULL DEFAULT 'realtyprice-crawler',
      crawled_at TEXT
    );
  `);

  for (const statement of [
    "ALTER TABLE realtyprice_units ADD COLUMN notice_date_raw TEXT",
    "ALTER TABLE realtyprice_units ADD COLUMN full_address TEXT",
    "ALTER TABLE realtyprice_units ADD COLUMN x_coord REAL",
    "ALTER TABLE realtyprice_units ADD COLUMN y_coord REAL",
    "ALTER TABLE realtyprice_units ADD COLUMN ktown_ho_seq TEXT",
    "ALTER TABLE realtyprice_units ADD COLUMN raw_json TEXT",
    "ALTER TABLE realtyprice_units ADD COLUMN source TEXT NOT NULL DEFAULT 'realtyprice-crawler'",
    "ALTER TABLE realtyprice_units ADD COLUMN crawled_at TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!String(error.message).includes("duplicate column name")) throw error;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_realtyprice_addr ON realtyprice_units(district, legal_dong, apt_name);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_codes ON realtyprice_units(apt_code, building_code, ho_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_bjd ON realtyprice_units(bjd_code);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_floor ON realtyprice_units(apt_code, building_name, floor);
    CREATE INDEX IF NOT EXISTS idx_realtyprice_source ON realtyprice_units(source);
  `);
}

async function loadCompleted(file) {
  if (!existsSync(file)) return new Set();
  const text = await readFile(file, "utf8");
  return new Set(text.split(/\r?\n/).filter(Boolean));
}

function districtFilePath(name) {
  return path.join(districtsDir, `${safeFileName(name)}.json`);
}

function parsePrice(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function parseFloor(hoName) {
  const match = String(hoName ?? "").match(/(\d{3,4})/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return Math.floor(number / 100);
}

function parseLegalDong(value) {
  const text = clean(value);
  const match = text.match(/^([^\s]+)/);
  return match?.[1] ?? "";
}

function stripBunji(name) {
  return String(name ?? "").replace(/^\([^)]*\)\s*/, "").trim();
}

function extractParenthetical(name) {
  return String(name ?? "").match(/^\(([^)]*)\)/)?.[1] ?? "";
}

function cleanDetailAddress(value) {
  return clean(value).replace(/^\((.*)\)$/, "$1");
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
