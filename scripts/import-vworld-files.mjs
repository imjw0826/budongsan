// import-vworld-files.mjs
// -----------------------------------------------------------------------------
// V-World 국가중점데이터 공동주택가격 "파일 다운로드" 임포트.
// (API 키 승인이 필요 없는 경로 — vworld.kr 데이터셋 dsId=8 에서 받은 파일 사용)
//
//   Phase A (--shp)        AL_D166 SHP/DBF — 동(건물) 단위 포인트 + 평균공시가
//                          → 단지명으로 그룹 → 평균 좌표 → apartment_complexes.lat/lng
//   Phase B (--complexes)  CSV 의 아파트 단지 중 DB 에 없는 것을 신규 생성
//                          (SHP 좌표 + CSV 집계로 세대수·동수·주력면적·가격범위 산출)
//   Phase C (--csv)        AL_D167 CSV — 호별 공시가격 (동명·층명·호명·전용면적·공시가격)
//                          → official_prices 재적재 (source='vworld-file')
//
// 입력 파일 (data/vworld/ 아래에 압축 해제):
//   data/vworld/shp/AL_D166_11_YYYYMMDD.dbf   (EPSG:5186 좌표가 A11/A12 에 수치로 포함)
//   data/vworld/csv/AL_D167_11_YYYYMMDD.csv   (CP949 인코딩, 278만 행)
//
// 사용
//   node scripts/import-vworld-files.mjs --shp --complexes --csv   # 전체
//   node scripts/import-vworld-files.mjs --csv --year 2026         # 가격만
//   ...후속: node scripts/build-complex-shapes.mjs                 # 지도 geojson 재생성
// -----------------------------------------------------------------------------

import { createReadStream, readdirSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import proj4 from "proj4";
import { db, migrate } from "../server/db.mjs";

migrate();

// ---------- args ------------------------------------------------------------

const args = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const getArg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`);
  const next = idx >= 0 ? process.argv[idx + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
};

const runShp = args.has("--shp");
const runComplexes = args.has("--complexes");
const runCsv = args.has("--csv");
if (!runShp && !runComplexes && !runCsv) {
  console.error("실행할 단계를 지정하세요: --shp (위치) / --complexes (누락 단지 생성) / --csv (호별 가격)");
  process.exit(1);
}

// ---------- 좌표계: EPSG:5186 (Korea 2000 / Central Belt 2010) → WGS84 -------

proj4.defs(
  "EPSG:5186",
  "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);
const toWgs84 = proj4("EPSG:5186", "EPSG:4326");

// ---------- 공통: 이름 정규화 + 단지 매칭 ------------------------------------

function normalizeName(value) {
  return String(value ?? "")
    .replace(/\(.*?\)/g, "") // "신현(101동)" → "신현"
    .replace(/\s+/g, "")
    .replace(/아파트$/, "")
    .toLowerCase();
}

let complexes = [];
const complexesByBjd = new Map();

function loadComplexIndex() {
  complexes = db
    .prepare(
      `SELECT id, name, bjd_code AS bjd, lat, lng FROM apartment_complexes
       WHERE bjd_code IS NOT NULL AND bjd_code != ''`,
    )
    .all();
  complexesByBjd.clear();
  for (const c of complexes) {
    if (!complexesByBjd.has(c.bjd)) complexesByBjd.set(c.bjd, []);
    complexesByBjd.get(c.bjd).push({ ...c, norm: normalizeName(c.name) });
  }
}
loadComplexIndex();

function matchComplex(bjd, rawName) {
  const candidates = complexesByBjd.get(bjd);
  if (!candidates) return null;
  const norm = normalizeName(rawName);
  if (!norm) return null;
  return (
    candidates.find((c) => c.norm === norm) ??
    candidates.find((c) => c.norm.length >= 2 && norm.length >= 2 && (c.norm.includes(norm) || norm.includes(c.norm))) ??
    null
  );
}

function findFile(dir, ext) {
  const hits = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
  if (hits.length === 0) throw new Error(`${dir} 에 ${ext} 파일이 없습니다.`);
  return path.join(dir, hits.sort().at(-1)); // 최신 날짜 파일
}

// ---------- Phase A: DBF → 단지 좌표 -----------------------------------------

function readDbfRows(dbfPath) {
  const fd = openSync(dbfPath, "r");
  const head = Buffer.alloc(32);
  readSync(fd, head, 0, 32, 0);
  const nRecords = head.readUInt32LE(4);
  const headerSize = head.readUInt16LE(8);
  const recordSize = head.readUInt16LE(10);

  const fieldArea = Buffer.alloc(headerSize - 32);
  readSync(fd, fieldArea, 0, fieldArea.length, 32);
  const nFields = Math.floor((headerSize - 33) / 32);
  const fields = [];
  for (let i = 0; i < nFields; i += 1) {
    const fd32 = fieldArea.subarray(i * 32, i * 32 + 32);
    fields.push({ name: fd32.toString("ascii", 0, 11).split("\0")[0], len: fd32[16] });
  }

  const decoder = new TextDecoder("euc-kr");
  const rows = [];
  const buf = Buffer.alloc(recordSize);
  for (let r = 0; r < nRecords; r += 1) {
    readSync(fd, buf, 0, recordSize, headerSize + r * recordSize);
    if (buf[0] === 0x2a) continue; // deleted flag
    const row = {};
    let pos = 1;
    for (const f of fields) {
      row[f.name] = decoder.decode(buf.subarray(pos, pos + f.len)).trim();
      pos += f.len;
    }
    rows.push(row);
  }
  closeSync(fd);
  return rows;
}

let shpGroupsCache = null;

// 동(건물) 포인트를 (법정동, 단지 base 이름) 으로 그룹 → 평균 좌표
// A0=PNU A1=법정동코드 A9=구분명 A10=공동주택명 A11=X A12=Y
function buildShpGroups() {
  if (shpGroupsCache) return shpGroupsCache;
  const dbfPath = findFile(path.resolve("data/vworld/shp"), ".dbf");
  console.log(`▶ DBF 읽기: ${path.basename(dbfPath)}`);
  const rows = readDbfRows(dbfPath);
  console.log(`  레코드 ${rows.length}개`);

  const groups = new Map();
  let skipped = 0;
  for (const row of rows) {
    const bjd = row.A1;
    const name = row.A10;
    const x = Number(row.A11);
    const y = Number(row.A12);
    if (!bjd || !name || !Number.isFinite(x) || !Number.isFinite(y) || x === 0) {
      skipped += 1;
      continue;
    }
    const key = `${bjd}|${normalizeName(name)}`;
    if (!groups.has(key)) groups.set(key, { bjd, name, sx: 0, sy: 0, n: 0, pnu: row.A0 });
    const g = groups.get(key);
    g.sx += x;
    g.sy += y;
    g.n += 1;
  }
  console.log(`  단지 그룹 ${groups.size}개 (좌표 없는 레코드 ${skipped}건 제외)`);
  shpGroupsCache = groups;
  return groups;
}

/** SHP 그룹에서 (법정동, 이름) 으로 WGS84 좌표 찾기 — 정확/부분 일치 순. */
function shpCoordFor(groups, bjd, name) {
  const norm = normalizeName(name);
  let g = groups.get(`${bjd}|${norm}`);
  if (!g) {
    for (const cand of groups.values()) {
      if (cand.bjd !== bjd) continue;
      const cn = normalizeName(cand.name);
      if (cn.length >= 2 && norm.length >= 2 && (cn.includes(norm) || norm.includes(cn))) {
        g = cand;
        break;
      }
    }
  }
  if (!g) return null;
  const [lng, lat] = toWgs84.forward([g.sx / g.n, g.sy / g.n]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 37.3 || lat > 37.8 || lng < 126.6 || lng > 127.3) return null;
  return { lat, lng, pnu: g.pnu };
}

function runShpPhase() {
  const groups = buildShpGroups();

  const updatePos = db.prepare(
    `UPDATE apartment_complexes
     SET lat = @lat, lng = @lng, geocode_source = 'vworld-shp', vworld_pnu = @pnu, vworld_name = @vname
     WHERE id = @id`,
  );

  let matched = 0;
  let moved = 0;
  const seen = new Set();
  db.transaction(() => {
    for (const g of groups.values()) {
      const hit = matchComplex(g.bjd, g.name);
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      const [lng, lat] = toWgs84.forward([g.sx / g.n, g.sy / g.n]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < 37.3 || lat > 37.8 || lng < 126.6 || lng > 127.3) continue; // 서울 범위 밖 무시
      matched += 1;
      if (Math.hypot(hit.lat - lat, hit.lng - lng) > 0.0001) moved += 1;
      updatePos.run({ id: hit.id, lat, lng, pnu: g.pnu, vname: g.name });
    }
  })();

  console.log(`▶ 위치 갱신: ${matched}/${complexes.length} 단지 (~10m 이상 이동 ${moved}건)`);
  console.log(`  미매칭 ${complexes.length - matched}건은 기존 좌표 유지`);
}

// ---------- Phase B: CSV 의 미등록 아파트 단지 신규 생성 ----------------------

async function runComplexesPhase() {
  const csvPath = findFile(path.resolve("data/vworld/csv"), ".csv");
  const groups = buildShpGroups();
  console.log(`▶ 누락 단지 스캔: ${path.basename(csvPath)}`);

  // (법정동, 단지명) 별 집계: 호수·동수·면적 분포·가격 범위
  const agg = new Map();
  const decoder = new TextDecoder("euc-kr");
  let lineNo = 0;
  let carry = "";

  const handleLine = (line) => {
    lineNo += 1;
    if (lineNo === 1 || !line) return;
    const cols = line.split(",");
    if (cols.length < 19) return;
    const [, bjd, bjdName, , , jibun, , , , , kind, , name, building, , ho, areaRaw, priceRaw] = cols;
    if (kind !== "아파트" || !bjd || !name) return;
    const key = `${bjd}|${normalizeName(name)}`;
    if (!agg.has(key)) {
      agg.set(key, {
        bjd,
        bjdName,
        jibun,
        name,
        buildings: new Set(),
        hos: new Set(),
        areas: new Map(),
        minWon: Infinity,
        maxWon: 0,
      });
    }
    const a = agg.get(key);
    if (building) a.buildings.add(building);
    a.hos.add(`${building}|${ho}`);
    const area = Math.round(Number(areaRaw) || 0);
    if (area > 0) a.areas.set(area, (a.areas.get(area) ?? 0) + 1);
    const won = Number(priceRaw);
    if (won > 0) {
      if (won < a.minWon) a.minWon = won;
      if (won > a.maxWon) a.maxWon = won;
    }
  };

  for await (const chunk of createReadStream(csvPath, { highWaterMark: 1 << 20 })) {
    const text = carry + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) handleLine(line.replace(/\r$/, ""));
  }
  if (carry) handleLine(carry.replace(/\r$/, ""));
  console.log(`  CSV 아파트 단지 ${agg.size}개 발견`);

  const insertComplex = db.prepare(`
    INSERT INTO apartment_complexes
      (id, name, district, neighborhood, address, bjd_code, lat, lng,
       households, buildings, main_area, min_price, max_price,
       source, geocode_source, vworld_pnu, vworld_name)
    VALUES
      (@id, @name, @district, @neighborhood, @address, @bjd, @lat, @lng,
       @households, @buildings, @mainArea, @minPrice, @maxPrice,
       'vworld-file', 'vworld-shp', @pnu, @vname)
  `);

  let created = 0;
  let existed = 0;
  let noCoord = 0;
  db.transaction(() => {
    for (const a of agg.values()) {
      if (matchComplex(a.bjd, a.name)) {
        existed += 1;
        continue;
      }
      const coord = shpCoordFor(groups, a.bjd, a.name);
      if (!coord) {
        noCoord += 1;
        continue;
      }
      // 법정동명 "서울특별시 종로구 청운동" → 구 / 동
      const parts = String(a.bjdName ?? "").split(/\s+/);
      const district = parts[1] ?? "";
      const neighborhood = parts[2] ?? "";
      if (!district || !neighborhood) {
        noCoord += 1;
        continue;
      }
      let mainArea = 0;
      let best = 0;
      for (const [area, cnt] of a.areas) {
        if (cnt > best) {
          best = cnt;
          mainArea = area;
        }
      }
      const hash = createHash("md5").update(`${a.bjd}|${normalizeName(a.name)}`).digest("hex").slice(0, 8);
      insertComplex.run({
        id: `VW${a.bjd}${hash}`,
        name: a.name,
        district,
        neighborhood,
        address: `${a.bjdName} ${a.jibun ?? ""}`.trim(),
        bjd: a.bjd,
        lat: coord.lat,
        lng: coord.lng,
        households: a.hos.size,
        buildings: a.buildings.size || 1,
        mainArea: mainArea ? `${mainArea}㎡` : "-",
        minPrice: a.minWon === Infinity ? 0 : Number((a.minWon / 1e8).toFixed(2)),
        maxPrice: Number((a.maxWon / 1e8).toFixed(2)),
        pnu: coord.pnu,
        vname: a.name,
      });
      created += 1;
    }
  })();

  console.log(`▶ 단지 생성: 신규 ${created}개 (기존 매칭 ${existed} · 좌표/주소 없음 ${noCoord})`);
  loadComplexIndex(); // 이후 CSV 가격 매칭에 신규 단지 반영
}

// ---------- Phase C: CSV → official_prices -----------------------------------

const stdrYear = getArg("year", null); // null 이면 CSV 의 기준연도 그대로

async function runCsvPhase() {
  const csvPath = findFile(path.resolve("data/vworld/csv"), ".csv");
  console.log(`▶ CSV 읽기: ${path.basename(csvPath)} (CP949 스트리밍)`);

  const insertPrice = db.prepare(`
    INSERT OR REPLACE INTO official_prices
      (id, complex_id, year, building, floor, area, price, ho, price_won, source, source_pnu, updated_at)
    VALUES
      (@id, @complexId, @year, @building, @floor, @area, @price, @ho, @priceWon, 'vworld-file', @pnu, @updatedAt)
  `);

  // CSV 컬럼:
  // 0 고유번호(PNU) 1 법정동코드 2 법정동명 3 특수지구분코드 4 특수지구분명 5 지번
  // 6 기준연도 7 기준월 8 공동주택코드 9 공동주택구분코드 10 공동주택구분명
  // 11 특수지명 12 공동주택명 13 동명 14 층명 15 호명 16 전용면적 17 공시가격 18 데이터기준일자
  const decoder = new TextDecoder("euc-kr");
  const updatedAt = new Date().toISOString();
  const matchCache = new Map(); // `${bjd}|${name}` → complex | null

  let lineNo = 0;
  let inserted = 0;
  let unmatched = 0;
  let pending = [];

  const flush = db.transaction((batch) => {
    for (const p of batch) insertPrice.run(p);
  });

  function handleLine(line) {
    lineNo += 1;
    if (lineNo === 1 || !line) return; // header
    const cols = line.split(",");
    if (cols.length < 19) return;
    const [pnu, bjd, , , , , year, , , , kind, , name, building, floorRaw, ho, areaRaw, priceRaw] = cols;
    if (stdrYear && year !== stdrYear) return;

    const key = `${bjd}|${name}`;
    let hit = matchCache.get(key);
    if (hit === undefined) {
      hit = matchComplex(bjd, name);
      matchCache.set(key, hit);
    }
    if (!hit) {
      if (kind === "아파트") unmatched += 1;
      return;
    }

    const priceWon = Number(priceRaw);
    const area = Number(areaRaw);
    if (!Number.isFinite(priceWon) || priceWon <= 0) return;

    pending.push({
      id: `${hit.id}-${year}-${building || "-"}-${ho || "-"}-${areaRaw}`,
      complexId: hit.id,
      year,
      building: building || "동정보없음",
      floor: Number(floorRaw) || 0,
      area: Number.isFinite(area) ? area : 0,
      price: Number((priceWon / 1e8).toFixed(2)), // 억 단위
      ho: ho || null,
      priceWon,
      pnu,
      updatedAt,
    });
    inserted += 1;

    if (pending.length >= 5000) {
      flush(pending);
      pending = [];
      if (inserted % 100000 < 5000) console.log(`  …${inserted.toLocaleString()}건 적재 (행 ${lineNo.toLocaleString()})`);
    }
  }

  let carry = "";
  for await (const chunk of createReadStream(csvPath, { highWaterMark: 1 << 20 })) {
    const text = carry + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) handleLine(line.replace(/\r$/, ""));
  }
  if (carry) handleLine(carry.replace(/\r$/, ""));
  if (pending.length) flush(pending);

  console.log(`▶ CSV 적재 완료: official_prices ${inserted.toLocaleString()}건 (전체 ${lineNo.toLocaleString()}행)`);
  console.log(`  미매칭 아파트 행 ${unmatched.toLocaleString()}건 (빌라·연립 등 비대상 제외)`);
}

// ---------- run ---------------------------------------------------------------

if (runShp) runShpPhase();
if (runComplexes) await runComplexesPhase();
if (runCsv) await runCsvPhase();

console.log(`\n다음 단계: node scripts/build-complex-shapes.mjs  (지도 geojson 재생성)`);
