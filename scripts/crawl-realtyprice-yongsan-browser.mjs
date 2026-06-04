import { chromium } from "playwright-core";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://www.realtyprice.kr/notice";
const SOURCE_URL = `${BASE_URL}/town/searchObjection.htm`;
const DEFAULT_YEAR = "2026";
const DEFAULT_NOTICE_DATE = "20260430";
const YONGSAN = { code: "11170", name: "용산구" };
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = parseArgs(process.argv.slice(2));
const year = String(args.year ?? DEFAULT_YEAR);
const noticeDate = String(args["notice-date"] ?? DEFAULT_NOTICE_DATE);
const delayMs = Number(args.delay ?? 80);
const reset = Boolean(args.reset);
const headed = Boolean(args.headed);
const limitComplexes = args["limit-complexes"] ? Number(args["limit-complexes"]) : Infinity;
const limitUnits = args["limit-units"] ? Number(args["limit-units"]) : Infinity;
const outDir = path.resolve(
  String(args.out ?? `data/realtyprice/browser-yongsan-${year}-${noticeDate}`),
);
const districtFile = path.join(outDir, "용산구.json");
const unitsPath = path.join(outDir, "units.jsonl");
const completedPath = path.join(outDir, "completed-houses.txt");
const failedPath = path.join(outDir, "failed-houses.jsonl");
const manifestPath = path.join(outDir, "manifest.json");

mkdirSync(outDir, { recursive: true });

if (reset) {
  for (const file of [districtFile, unitsPath, completedPath, failedPath, manifestPath]) {
    if (existsSync(file)) writeFileSync(file, "");
  }
}

const completed = await loadCompleted(completedPath);
const failed = await loadFailed(failedPath);
const unitStream = createWriteStream(unitsPath, { flags: "a" });
let districtDoc = loadDistrictDoc();
let scannedRoads = districtDoc.counts?.roads ?? 0;
let scannedComplexes = districtDoc.counts?.complexes ?? 0;
let completedHouses = completed.size;
let failedHouses = failed.size;
let skippedCompleted = 0;
let writtenRows = districtDoc.counts?.priceRows ?? 0;

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: !headed,
  args: ["--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log(`Browser crawl started: ${SOURCE_URL}`);
  console.log(`Scope: 서울특별시 ${YONGSAN.name} ${year}/${noticeDate}`);

  const initials = await fetchRoadInitials(page);
  crawlLoop:
  for (const initial of initials) {
    const roads = await fetchRoads(page, initial.code);
    for (const road of roads) {
      if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) break crawlLoop;
      scannedRoads += 1;
      upsertRoad(districtDoc, initial, road);

      const complexes = await fetchRoadComplexes(page, initial.code, road);
      if (complexes.length === 0) continue;
      console.log(`Road ${road.name}: complexes=${complexes.length}`);

      for (const complex of complexes) {
        if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) break crawlLoop;
        scannedComplexes += 1;

        const complexDoc = upsertComplex(districtDoc, initial, road, complex);
        const selectedNoticeDate = complex.notice_date ?? noticeDate;
        const buildings = await fetchBuildings(page, initial.code, road, complex, selectedNoticeDate);
        console.log(`[${scannedComplexes}] ${complexDoc.aptName}: buildings=${buildings.length}`);

        for (const building of buildings) {
          const houses = await fetchHouses(page, initial.code, road, complex, building, selectedNoticeDate);
          console.log(`  ${building.name}: houses=${houses.length}`);

          const pendingHouses = [];
          for (const house of houses) {
            if (writtenRows >= limitUnits) break crawlLoop;
            const houseKey = [
              YONGSAN.code,
              road.code,
              complex.code,
              building.code,
              house.code,
              selectedNoticeDate,
            ].join(":");

            if (completed.has(houseKey)) {
              skippedCompleted += 1;
              continue;
            }
            if (failed.has(houseKey)) {
              skippedCompleted += 1;
              continue;
            }
            pendingHouses.push({ house, houseKey });
          }

          for (const { house, houseKey } of pendingHouses) {
            if (writtenRows >= limitUnits) break crawlLoop;
            let rows = [];
            try {
              rows = await fetchPriceRows(
                page,
                initial.code,
                road,
                complex,
                building,
                house,
                selectedNoticeDate,
              );
            } catch (error) {
              failed.add(houseKey);
              failedHouses += 1;
              await appendFile(
                failedPath,
                `${JSON.stringify({
                  houseKey,
                  error: error instanceof Error ? error.message : String(error),
                  house,
                  road: { code: road.code, name: road.name },
                  complex: { code: complex.code, name: complex.name },
                  building: { code: building.code, name: building.name },
                  crawledAt: new Date().toISOString(),
                })}\n`,
              );
              continue;
            }

            const normalized = rows.map((row) =>
                normalizePriceRow({
                  row,
                  initial,
                  road,
                  complex,
                  building,
                  house,
                  selectedNoticeDate,
                }),
              );

            for (const item of normalized) {
              unitStream.write(`${JSON.stringify(item)}\n`);
              appendUnitToComplex(complexDoc, item);
              writtenRows += 1;
            }

            completed.add(houseKey);
            completedHouses += 1;
            await appendFile(completedPath, `${houseKey}\n`);

            if (completedHouses % 100 === 0) {
              await writeDistrictDoc();
              await writeManifest();
              console.log(
                `progress houses=${completedHouses} rows=${writtenRows} skipped=${skippedCompleted}`,
              );
            }
            await sleep(delayMs);
          }
        }

        await writeDistrictDoc();
        await writeManifest();
      }
    }
  }
} finally {
  await writeDistrictDoc();
  await writeManifest();
  unitStream.end();
  await browser.close();
}

async function fetchRoadInitials(page) {
  return fetchList(
    page,
    "/road/searchRoadTown.road",
    roadParams({ gbn: "INITIALWORD", sigungu: YONGSAN.code }),
  );
}

async function fetchRoads(page, initial) {
  return fetchList(
    page,
    "/road/searchRoadTown.road",
    roadParams({ gbn: "ROAD", sigungu: YONGSAN.code, initial }),
  );
}

async function fetchRoadComplexes(page, initial, road) {
  return fetchList(page, "/search/searchApt.search", searchParams({ initial, road, gbnApt: "" }));
}

async function fetchBuildings(page, initial, road, complex, selectedNoticeDate) {
  return fetchList(
    page,
    "/search/searchApt.search",
    searchParams({
      initial,
      road,
      gbnApt: "DONG",
      aptCode: complex.code,
      selectedNoticeDate,
    }),
  );
}

async function fetchHouses(page, initial, road, complex, building, selectedNoticeDate) {
  return fetchList(
    page,
    "/search/searchApt.search",
    searchParams({
      initial,
      road,
      gbnApt: "HO",
      aptCode: complex.code,
      dongCode: building.code,
      selectedNoticeDate,
    }),
  );
}

async function fetchPriceRows(page, initial, road, complex, building, house, selectedNoticeDate) {
  return fetchList(
    page,
    "/search/townPriceListMap.search",
    searchParams({
      initial,
      road,
      gbnApt: "HO",
      aptCode: complex.code,
      dongCode: building.code,
      hoCode: house.code,
      selectedNoticeDate,
    }),
  );
}

async function fetchPriceRowsBatch(page, initial, road, complex, building, batch, selectedNoticeDate) {
  const requests = batch.map(({ house, houseKey }) => ({
    house,
    houseKey,
    params: searchParams({
      initial,
      road,
      gbnApt: "HO",
      aptCode: complex.code,
      dongCode: building.code,
      hoCode: house.code,
      selectedNoticeDate,
    }),
  }));

  return page.evaluate(
    async ({ endpoint, requests, delayMs }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const results = [];

      for (const request of requests) {
        try {
          const url = new URL(endpoint, window.location.origin);
          for (const [key, value] of Object.entries(request.params)) {
            url.searchParams.set(key, value == null ? "" : String(value));
          }
          const response = await window.fetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json,text/javascript,*/*;q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = await response.json();
          const message = json?.model?.message;
          if (message) throw new Error(`${message}${json.model.error_gbn ? ` (${json.model.error_gbn})` : ""}`);
          results.push({
            house: request.house,
            houseKey: request.houseKey,
            rows: Array.isArray(json?.model?.list) ? json.model.list : [],
          });
        } catch (error) {
          results.push({
            house: request.house,
            houseKey: request.houseKey,
            rows: [],
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (delayMs > 0) await sleep(delayMs);
      }

      return results;
    },
    { endpoint: `${BASE_URL}/search/townPriceListMap.search`, requests, delayMs },
  );
}

async function fetchList(page, endpoint, params) {
  const json = await browserJson(page, endpoint, params);
  const message = json?.model?.message;
  if (message) {
    throw new Error(`${message}${json.model.error_gbn ? ` (${json.model.error_gbn})` : ""}`);
  }
  return Array.isArray(json?.model?.list) ? json.model.list : [];
}

async function browserJson(page, endpoint, params, attempt = 1) {
  try {
    return await page.evaluate(
      async ({ endpoint, params }) => {
        const url = new URL(endpoint, window.location.origin);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value == null ? "" : String(value));
        }
        const response = await window.fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json,text/javascript,*/*;q=0.01",
            "X-Requested-With": "XMLHttpRequest",
          },
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      },
      { endpoint: `${BASE_URL}${endpoint}`, params },
    );
  } catch (error) {
    if (attempt < 4) {
      await sleep(500 * attempt);
      return browserJson(page, endpoint, params, attempt + 1);
    }
    throw error;
  }
}

function roadParams({ gbn, sigungu = "", initial = "", road = "" }) {
  return {
    p_gbn: gbn,
    p_sido: "11",
    p_sigungu: sigungu,
    p_initialword: initial,
    p_road: road,
    sido: "11",
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
    road_reg: YONGSAN.code,
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

function loadDistrictDoc() {
  if (existsSync(districtFile)) {
    const text = readFileSync(districtFile, "utf8").trim();
    if (text) return JSON.parse(text);
  }
  return {
    source: SOURCE_URL,
    crawler: "playwright-browser-context",
    fetchedAt: new Date().toISOString(),
    year,
    noticeDate,
    sido: "서울특별시",
    district: YONGSAN,
    roads: [],
    complexes: [],
    counts: { roads: 0, complexes: 0, units: 0, priceRows: 0 },
  };
}

async function writeDistrictDoc() {
  districtDoc.fetchedAt = new Date().toISOString();
  districtDoc.counts = {
    roads: districtDoc.roads.length,
    complexes: districtDoc.complexes.length,
    units: districtDoc.complexes.reduce((sum, complex) => sum + complex.units.length, 0),
    priceRows: districtDoc.complexes.reduce(
      (sum, complex) =>
        sum + complex.units.reduce((unitSum, unit) => unitSum + unit.prices.length, 0),
      0,
    ),
  };
  await writeFile(districtFile, `${JSON.stringify(districtDoc, null, 2)}\n`);
}

async function writeManifest() {
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        source: SOURCE_URL,
        crawler: "playwright-browser-context",
        fetchedAt: new Date().toISOString(),
        year,
        noticeDate,
        scope: { sido: "서울특별시", district: YONGSAN.name },
        files: {
          district: path.relative(process.cwd(), districtFile),
          units: path.relative(process.cwd(), unitsPath),
          completedHouses: path.relative(process.cwd(), completedPath),
          failedHouses: path.relative(process.cwd(), failedPath),
        },
        counts: {
          scannedRoads,
          scannedComplexes,
          completedHouses,
          failedHouses,
          skippedCompleted,
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
    target = { code: String(road.code), name: String(road.name), initial: String(initial.code) };
    doc.roads.push(target);
  }
  return target;
}

function upsertComplex(doc, initial, road, complex) {
  const aptCode = String(complex.code);
  let target = doc.complexes.find((item) => item.aptCode === aptCode);
  if (!target) {
    const sourceName = String(complex.name ?? "");
    target = {
      aptCode,
      aptName: stripBunji(sourceName),
      sourceName,
      sido: "서울특별시",
      sigunguCode: YONGSAN.code,
      sigungu: YONGSAN.name,
      roadCode: String(road.code),
      roadName: String(road.name),
      roadInitial: String(initial.code),
      detailAddress: cleanDetailAddress(complex.bunji || extractParenthetical(sourceName)),
      noticeDate: String(complex.notice_date ?? noticeDate),
      xCoord: Number(complex.x_coord ?? 0) || null,
      yCoord: Number(complex.y_coord ?? 0) || null,
      units: [],
    };
    doc.complexes.push(target);
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
  if (!unit.prices.some((item) => item.year === row.year && item.noticeDate === row.noticeDate)) {
    unit.prices.push({
      year: row.year,
      noticeDate: row.noticeDate,
      noticeDateRaw: row.noticeDateRaw,
      priceWon: row.priceWon,
    });
  }
}

function normalizePriceRow({ row, road, complex, building, house, selectedNoticeDate }) {
  const noticeDateText = String(row.notice_date ?? row.notice_date_name ?? "");
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
    noticeDateRaw: String(selectedNoticeDate ?? noticeDate),
    noticeDate: noticeDateText,
    sido: "서울특별시",
    district: YONGSAN.name,
    legalDong: parseLegalDong(row.short_addr_name),
    bjdCode: String(row.reg || YONGSAN.code),
    aptCode: String(row.apt_code || complex.code),
    aptName,
    buildingCode: String(row.dong_code || building.code),
    buildingName,
    hoCode: String(row.ho_code || house.code),
    hoName,
    floor: parseFloor(hoName),
    privateArea: parseFloat(String(row.priv_area ?? "")) || null,
    priceWon: parsePrice(row.notice_amt),
    roadAddress: clean(row.full_road_name) || `서울특별시 ${YONGSAN.name} ${road.name}`,
    lotAddress: clean(row.short_addr_name),
    fullAddress: clean(row.full_addr_name),
    xCoord: Number(complex.x_coord ?? 0) || null,
    yCoord: Number(complex.y_coord ?? 0) || null,
    ktownHoSeq: row.ktown_ho_seq ? String(row.ktown_ho_seq) : null,
    rawJson: row,
    source: "realtyprice-browser-crawler",
    crawledAt: new Date().toISOString(),
  };
}

async function loadCompleted(file) {
  if (!existsSync(file)) return new Set();
  const text = await readFile(file, "utf8");
  return new Set(text.split(/\r?\n/).filter(Boolean));
}

async function loadFailed(file) {
  if (!existsSync(file)) return new Set();
  const text = await readFile(file, "utf8");
  const keys = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).houseKey;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return new Set(keys);
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
  return clean(value).match(/^([^\s]+)/)?.[1] ?? "";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
