import { chromium } from "playwright-core";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, migrate } from "../server/db.mjs";

const BASE_URL = "https://www.realtyprice.kr/notice";
const SOURCE_URL = `${BASE_URL}/town/siteLink.htm`;
const DEFAULT_YEAR = "2026";
const DEFAULT_NOTICE_DATE = "20260430";
const YONGSAN = { code: "11170", name: "용산구" };
const SEOUL_DISTRICTS = [
  { code: "11680", name: "강남구" },
  { code: "11650", name: "서초구" },
  { code: "11170", name: "용산구" },
];
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = parseArgs(process.argv.slice(2));
const year = String(args.year ?? DEFAULT_YEAR);
const noticeDate = String(args["notice-date"] ?? DEFAULT_NOTICE_DATE);
const delayMs = Number(args.delay ?? 80);
const reset = Boolean(args.reset);
const headed = Boolean(args.headed);
const limitComplexes = args["limit-complexes"] ? Number(args["limit-complexes"]) : Infinity;
const limitUnits = args["limit-units"] ? Number(args["limit-units"]) : Infinity;
const minHouseholds = args["min-households"] ? Number(args["min-households"]) : 0;
const requestTimeoutMs = Number(args["request-timeout"] ?? 20000);
const useDbComplexes = String(args["use-db-complexes"] ?? "true") !== "false";
const districtFilters = args.districts
  ? String(args.districts)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  : args.district
    ? [String(args.district)]
    : [YONGSAN.name];
const outDir = path.resolve(
  String(args.out ?? `data/realtyprice/browser-priority-${year}-${noticeDate}`),
);
const districtsDir = path.join(outDir, "districts");
const unitsPath = path.join(outDir, "units.jsonl");
const completedPath = path.join(outDir, "completed-houses.txt");
const failedPath = path.join(outDir, "failed-houses.jsonl");
const manifestPath = path.join(outDir, "manifest.json");

mkdirSync(outDir, { recursive: true });
mkdirSync(districtsDir, { recursive: true });
migrate();

if (reset) {
  for (const file of [unitsPath, completedPath, failedPath, manifestPath]) {
    if (existsSync(file)) writeFileSync(file, "");
  }
  for (const district of SEOUL_DISTRICTS) {
    const file = districtFilePath(district.name);
    if (existsSync(file)) writeFileSync(file, "");
  }
}

const completed = await loadCompleted(completedPath);
const failed = await loadFailed(failedPath);
const unitStream = createWriteStream(unitsPath, { flags: "a" });
let districtDoc = null;
let scannedDistricts = 0;
let scannedRoads = 0;
let scannedComplexes = 0;
let completedHouses = completed.size;
let failedHouses = failed.size;
let skippedCompleted = 0;
let skippedSmallComplexes = 0;
let writtenRows = 0;

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
  await page.goto(SOURCE_URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log(`Browser crawl started: ${SOURCE_URL}`);
  console.log(
    `Scope: 서울특별시 ${districtFilters.join(",")} ${year}/${noticeDate}` +
      `${minHouseholds > 0 ? ` min-households=${minHouseholds}` : ""}` +
      ` request-timeout=${requestTimeoutMs}ms`,
  );

  const districts = selectDistricts();
  crawlLoop:
  for (const district of districts) {
    scannedDistricts += 1;
    districtDoc = loadDistrictDoc(district);
    console.log(`District: ${district.name}`);

    if (useDbComplexes) {
      const dongs = await fetchBjdDongs(page, district);
      await crawlDbComplexes(page, district, dongs);
      await writeDistrictDoc(districtDoc);
      continue;
    }

    const initials = await fetchRoadInitials(page, district);
    for (const initial of initials) {
      const roads = await fetchRoads(page, district, initial.code);
      for (const road of roads) {
        if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) break crawlLoop;
        scannedRoads += 1;
        upsertRoad(districtDoc, initial, road);
        if (scannedRoads % 25 === 0) {
          console.log(
            `scanned roads=${scannedRoads} complexes=${scannedComplexes} rows=${writtenRows}`,
          );
        }

        const complexes = await fetchRoadComplexes(page, district, initial.code, road);
        if (complexes.length === 0) continue;
        console.log(`Road ${district.name} ${road.name}: complexes=${complexes.length}`);

        for (const complex of complexes) {
          if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) break crawlLoop;
          scannedComplexes += 1;

          const aptName = stripBunji(complex.name);
          const selectedNoticeDate = complex.notice_date ?? noticeDate;
          const buildings = await fetchBuildings(
            page,
            district,
            initial.code,
            road,
            complex,
            selectedNoticeDate,
          );
          console.log(`[${scannedComplexes}] ${district.name} ${aptName}: buildings=${buildings.length}`);

          const buildingHouseGroups = [];
          let householdCount = 0;
          for (const building of buildings) {
            const houses = await fetchHouses(
              page,
              district,
              initial.code,
              road,
              complex,
              building,
              selectedNoticeDate,
            );
            console.log(`  ${building.name}: houses=${houses.length}`);
            buildingHouseGroups.push({ building, houses });
            householdCount += houses.length;
          }

          if (minHouseholds > 0 && householdCount < minHouseholds) {
            skippedSmallComplexes += 1;
            console.log(`  skip ${aptName}: households=${householdCount} < ${minHouseholds}`);
            await writeManifest();
            continue;
          }

          const complexDoc = upsertComplex(
            districtDoc,
            district,
            initial,
            road,
            complex,
            householdCount,
          );

          for (const { building, houses } of buildingHouseGroups) {
            const pendingHouses = [];
            for (const house of houses) {
              if (writtenRows >= limitUnits) break crawlLoop;
              const houseKey = [
                district.code,
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
                  district,
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
                  district,
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
                await writeDistrictDoc(districtDoc);
                await writeManifest();
                console.log(
                  `progress houses=${completedHouses} rows=${writtenRows} skipped=${skippedCompleted}`,
                );
              }
              await sleep(delayMs);
            }
          }

          await writeDistrictDoc(districtDoc);
          await writeManifest();
        }
      }
    }

    await writeDistrictDoc(districtDoc);
  }
} finally {
  if (districtDoc) await writeDistrictDoc(districtDoc);
  await writeManifest();
  unitStream.end();
  await browser.close();
}

async function fetchRoadInitials(page, district) {
  return fetchList(
    page,
    "/road/searchRoadTown.road",
    roadParams({ gbn: "INITIALWORD", sigungu: district.code }),
  );
}

async function fetchBjdDongs(page, district) {
  const sigungu = String(district.code).slice(2);
  return fetchList(
    page,
    "/bjd/searchBjdTown.bjd",
    { gubun: "DONGRI", sido: "11", sgg: sigungu, eub: "" },
  );
}

async function crawlDbComplexes(page, district, dongs) {
  const dongByName = new Map(dongs.map((item) => [String(item.name), String(item.code)]));
  const complexes = loadDbComplexes(district);
  console.log(`DB complexes ${district.name}: ${complexes.length}`);

  for (const dbComplex of complexes) {
    if (scannedComplexes >= limitComplexes || writtenRows >= limitUnits) return;

    const eub = dongByName.get(dbComplex.neighborhood);
    if (!eub) {
      await writeFailedComplex("missing-dong-code", { district, dbComplex });
      continue;
    }

    const apt = await findAptByDbComplex(page, district, eub, dbComplex);
    if (!apt) {
      await writeFailedComplex("apt-not-found", { district, dbComplex });
      continue;
    }

    scannedComplexes += 1;
    const selectedNoticeDate = apt.notice_date ?? noticeDate;
    const aptName = stripBunji(apt.name || dbComplex.name);
    const buildings = await fetchBuildingsByBjd(page, district, eub, dbComplex, apt, selectedNoticeDate);
    console.log(`[${scannedComplexes}] ${district.name} ${aptName}: buildings=${buildings.length}`);

    const buildingHouseGroups = [];
    let householdCount = 0;
    for (const building of buildings) {
      const houses = await fetchHousesByBjd(
        page,
        district,
        eub,
        dbComplex,
        apt,
        building,
        selectedNoticeDate,
      );
      console.log(`  ${building.name}: houses=${houses.length}`);
      buildingHouseGroups.push({ building, houses });
      householdCount += houses.length;
    }

    if (minHouseholds > 0 && householdCount < minHouseholds) {
      skippedSmallComplexes += 1;
      console.log(`  skip ${aptName}: households=${householdCount} < ${minHouseholds}`);
      await writeManifest();
      continue;
    }

    const complexDoc = upsertComplex(
      districtDoc,
      district,
      { code: "" },
      { code: "", name: "" },
      apt,
      householdCount,
    );
    complexDoc.localComplexId = dbComplex.id;
    complexDoc.neighborhood = dbComplex.neighborhood;
    complexDoc.localHouseholds = dbComplex.households;

    for (const { building, houses } of buildingHouseGroups) {
      const pendingHouses = [];
      for (const house of houses) {
        if (writtenRows >= limitUnits) return;
        const houseKey = [
          district.code,
          eub,
          apt.code,
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
        if (writtenRows >= limitUnits) return;
        let rows = [];
        try {
          rows = await fetchPriceRowsByBjd(
            page,
            district,
            eub,
            dbComplex,
            apt,
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
              complex: { code: apt.code, name: apt.name, localId: dbComplex.id },
              building: { code: building.code, name: building.name },
              crawledAt: new Date().toISOString(),
            })}\n`,
          );
          continue;
        }

        const normalized = rows.map((row) =>
          normalizePriceRow({
            row,
            district,
            road: { name: "" },
            complex: apt,
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
          await writeDistrictDoc(districtDoc);
          await writeManifest();
          console.log(
            `progress houses=${completedHouses} rows=${writtenRows} skipped=${skippedCompleted}`,
          );
        }
        await sleep(delayMs);
      }
    }

    await writeDistrictDoc(districtDoc);
    await writeManifest();
  }
}

function loadDbComplexes(district) {
  return db
    .prepare(
      `
      SELECT id, name, district, neighborhood, address, households
      FROM apartment_complexes
      WHERE district = ?
        AND households >= ?
      ORDER BY neighborhood, name
      `,
    )
    .all(district.name, minHouseholds || 0);
}

async function findAptByDbComplex(page, district, eub, dbComplex) {
  for (const aptName of candidateAptNames(dbComplex.name)) {
    const matches = await fetchAptsByName(page, district, eub, aptName);
    if (matches.length === 0) continue;
    return chooseAptMatch(matches, dbComplex.name) ?? matches[0];
  }
  return null;
}

async function fetchAptsByName(page, district, eub, aptName) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      bjdSearchParams({ district, eub, aptName, gbnApt: "" }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchBuildingsByBjd(page, district, eub, dbComplex, apt, selectedNoticeDate) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      bjdSearchParams({
        district,
        eub,
        aptName: dbComplex.name,
        gbnApt: "DONG",
        aptCode: apt.code,
        selectedNoticeDate,
      }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchHousesByBjd(page, district, eub, dbComplex, apt, building, selectedNoticeDate) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      bjdSearchParams({
        district,
        eub,
        aptName: dbComplex.name,
        gbnApt: "HO",
        aptCode: apt.code,
        dongCode: building.code,
        selectedNoticeDate,
      }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchPriceRowsByBjd(page, district, eub, dbComplex, apt, building, house, selectedNoticeDate) {
  return fetchList(
    page,
    "/search/townPriceListMap.search",
    bjdSearchParams({
      district,
      eub,
      aptName: dbComplex.name,
      gbnApt: "HO",
      aptCode: apt.code,
      dongCode: building.code,
      hoCode: house.code,
      selectedNoticeDate,
    }),
  );
}

function bjdSearchParams({
  district,
  eub,
  aptName = "",
  gbnApt,
  aptCode = "",
  dongCode = "",
  hoCode = "",
  selectedNoticeDate = noticeDate,
}) {
  return {
    page_no: "1",
    reg_name: "",
    sreg: "",
    seub: "",
    old_reg: "",
    old_eub: "",
    gbn: "1",
    year,
    notice_date: selectedNoticeDate,
    notice_date_year: noticeDate,
    reg: district.code,
    eub,
    apt_name: aptName,
    bun1: "",
    bun2: "",
    road_code: "",
    road_reg: "",
    road: "",
    initialword: "",
    build_bun1: "",
    build_bun2: "",
    gbnApt,
    apt_code: String(aptCode),
    dong_code: String(dongCode),
    ho_code: String(hoCode),
    tabGbn: "Text",
    full_addr_name: "",
    dong_name: "",
    ho_name: "",
    notice_amt: "",
    ktown_ho_seq: "",
    past_yn: "1",
    print_yn: "0",
    searchGbnRoad: "",
    searchGbnBunji: "0",
    searchGbnBunjiYear: "",
    capcha: "",
    capcha_chk_yn: "N",
  };
}

async function fetchRoads(page, district, initial) {
  return fetchList(
    page,
    "/road/searchRoadTown.road",
    roadParams({ gbn: "ROAD", sigungu: district.code, initial }),
  );
}

async function fetchRoadComplexes(page, district, initial, road) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      searchParams({ district, initial, road, gbnApt: "" }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchBuildings(page, district, initial, road, complex, selectedNoticeDate) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      searchParams({
        district,
        initial,
        road,
        gbnApt: "DONG",
        aptCode: complex.code,
        selectedNoticeDate,
      }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchHouses(page, district, initial, road, complex, building, selectedNoticeDate) {
  try {
    return await fetchList(
      page,
      "/search/searchApt.search",
      searchParams({
        district,
        initial,
        road,
        gbnApt: "HO",
        aptCode: complex.code,
        dongCode: building.code,
        selectedNoticeDate,
      }),
    );
  } catch (error) {
    if (isHttp400(error)) return [];
    throw error;
  }
}

async function fetchPriceRows(page, district, initial, road, complex, building, house, selectedNoticeDate) {
  return fetchList(
    page,
    "/search/townPriceListMap.search",
    searchParams({
      district,
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

async function fetchPriceRowsBatch(page, district, initial, road, complex, building, batch, selectedNoticeDate) {
  const requests = batch.map(({ house, houseKey }) => ({
    house,
    houseKey,
    params: searchParams({
      district,
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
    async ({ endpoint, requests, delayMs, requestTimeoutMs }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const results = [];

      for (const request of requests) {
        try {
          const url = new URL(endpoint, window.location.origin);
          for (const [key, value] of Object.entries(request.params)) {
            url.searchParams.set(key, value == null ? "" : String(value));
          }
          const request = window.fetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json,text/javascript,*/*;q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
            credentials: "same-origin",
          });
          const timeout = new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error(`request timeout ${requestTimeoutMs}ms`)), requestTimeoutMs),
          );
          const response = await Promise.race([request, timeout]);
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
    { endpoint: `${BASE_URL}/search/townPriceListMap.search`, requests, delayMs, requestTimeoutMs },
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
      async ({ endpoint, params, requestTimeoutMs }) => {
        const url = new URL(endpoint, window.location.origin);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value == null ? "" : String(value));
        }
        const request = window.fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json,text/javascript,*/*;q=0.01",
            "X-Requested-With": "XMLHttpRequest",
          },
          credentials: "same-origin",
        });
        const timeout = new Promise((_, reject) =>
          window.setTimeout(() => reject(new Error(`request timeout ${requestTimeoutMs}ms`)), requestTimeoutMs),
        );
        const response = await Promise.race([request, timeout]);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      },
      { endpoint: `${BASE_URL}${endpoint}`, params, requestTimeoutMs },
    );
  } catch (error) {
    if (isHttp400(error)) throw error;
    if (attempt < 4) {
      console.warn(
        `Retry ${attempt}/3 ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
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

function loadDistrictDoc(district) {
  const districtFile = districtFilePath(district.name);
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
    district,
    roads: [],
    complexes: [],
    counts: { roads: 0, complexes: 0, units: 0, priceRows: 0 },
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
        scope: {
          sido: "서울특별시",
          districts: districtFilters,
          minHouseholds: minHouseholds || null,
        },
        files: {
          districts: path.relative(process.cwd(), districtsDir),
          units: path.relative(process.cwd(), unitsPath),
          completedHouses: path.relative(process.cwd(), completedPath),
          failedHouses: path.relative(process.cwd(), failedPath),
        },
        counts: {
          scannedDistricts,
          scannedRoads,
          scannedComplexes,
          completedHouses,
          failedHouses,
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
    target = { code: String(road.code), name: String(road.name), initial: String(initial.code) };
    doc.roads.push(target);
  }
  return target;
}

function upsertComplex(doc, district, initial, road, complex, householdCount) {
  const aptCode = String(complex.code);
  let target = doc.complexes.find((item) => item.aptCode === aptCode);
  if (!target) {
    const sourceName = String(complex.name ?? "");
    target = {
      aptCode,
      aptName: stripBunji(sourceName),
      sourceName,
      sido: "서울특별시",
      sigunguCode: district.code,
      sigungu: district.name,
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
  if (!unit.prices.some((item) => item.year === row.year && item.noticeDate === row.noticeDate)) {
    unit.prices.push({
      year: row.year,
      noticeDate: row.noticeDate,
      noticeDateRaw: row.noticeDateRaw,
      priceWon: row.priceWon,
    });
  }
}

function normalizePriceRow({ row, district, road, complex, building, house, selectedNoticeDate }) {
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
    priceWon: parsePrice(row.notice_amt),
    roadAddress: clean(row.full_road_name) || `서울특별시 ${district.name} ${road.name}`,
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

function selectDistricts() {
  const selected = [];
  const seen = new Set();

  for (const filter of districtFilters) {
    const district = SEOUL_DISTRICTS.find((item) => item.name === filter || item.code === filter);
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

function candidateAptNames(name) {
  const raw = clean(name);
  const withoutApartment = raw.replace(/아파트/g, "").trim();
  const withoutSpaces = raw.replace(/\s+/g, "");
  return [...new Set([raw, withoutApartment, withoutSpaces].filter(Boolean))];
}

function chooseAptMatch(matches, dbName) {
  const target = normalizeAptName(dbName);
  return (
    matches.find((item) => normalizeAptName(item.name) === target) ??
    matches.find((item) => normalizeAptName(item.name).includes(target)) ??
    matches.find((item) => target.includes(normalizeAptName(item.name)))
  );
}

function normalizeAptName(value) {
  return String(value ?? "")
    .replace(/^\([^)]*\)\s*/, "")
    .replace(/아파트/g, "")
    .replace(/[()\s·._-]/g, "")
    .toLowerCase();
}

async function writeFailedComplex(reason, payload) {
  await appendFile(
    failedPath,
    `${JSON.stringify({
      reason,
      ...payload,
      crawledAt: new Date().toISOString(),
    })}\n`,
  );
}

function isHttp400(error) {
  return String(error instanceof Error ? error.message : error).includes("HTTP 400");
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

function safeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "_");
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
