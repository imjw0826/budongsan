import { XMLParser } from "fast-xml-parser";
import { db, migrate } from "../server/db.mjs";

migrate();

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY is missing.");
  process.exit(1);
}
const keyParam = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);

const monthsArg = Number(
  process.argv.find((arg) => arg.startsWith("--months="))?.split("=")[1] ?? "6",
);
const endArg = process.argv.find((arg) => arg.startsWith("--end="))?.split("=")[1];

function endYearMonth() {
  if (endArg) return endArg;
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(ym) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4));
  if (month === 1) return `${year - 1}12`;
  return `${year}${String(month - 1).padStart(2, "0")}`;
}

function monthList(end, count) {
  const out = [];
  let cursor = end;
  for (let i = 0; i < count; i += 1) {
    out.push(cursor);
    cursor = previousMonth(cursor);
  }
  return out;
}

const lawdRows = db
  .prepare(
    "SELECT DISTINCT SUBSTR(bjd_code, 1, 5) AS lawd FROM apartment_complexes WHERE bjd_code IS NOT NULL ORDER BY lawd",
  )
  .all();
const lawds = lawdRows.map((row) => row.lawd).filter(Boolean);
const months = monthList(endYearMonth(), monthsArg);

console.log(`Fetching ${lawds.length} districts × ${months.length} months = ${lawds.length * months.length} requests.`);

const parser = new XMLParser({ ignoreAttributes: true });

const insert = db.prepare(`
  INSERT OR REPLACE INTO official_prices (
    id, complex_id, year, building, floor, area, price
  ) VALUES (
    @id, @complexId, @year, @building, @floor, @area, @price
  )
`);

const findComplex = db.prepare(`
  SELECT id FROM apartment_complexes
  WHERE district = @district AND neighborhood = @umd
    AND (name = @name OR name LIKE @nameLike OR @name LIKE '%' || name || '%')
  ORDER BY
    CASE WHEN name = @name THEN 0 ELSE 1 END,
    LENGTH(name) DESC
  LIMIT 1
`);

const districtByLawd = new Map(
  db
    .prepare(
      "SELECT DISTINCT SUBSTR(bjd_code, 1, 5) AS lawd, district FROM apartment_complexes WHERE bjd_code IS NOT NULL",
    )
    .all()
    .map((row) => [row.lawd, row.district]),
);

function parsePrice(text) {
  const number = Number(String(text ?? "").replaceAll(",", "").trim());
  if (!Number.isFinite(number)) return 0;
  return Number((number / 10000).toFixed(2));
}

let inserted = 0;
let matched = 0;
let unmatched = 0;

for (const [districtIndex, lawd] of lawds.entries()) {
  const district = districtByLawd.get(lawd) ?? "";
  for (const ym of months) {
    const url =
      `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
      `?serviceKey=${keyParam}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&pageNo=1&numOfRows=1000`;

    let items = [];
    try {
      const response = await fetch(url);
      const text = await response.text();
      const json = parser.parse(text);
      const body = json?.response?.body;
      const rawItems = body?.items?.item;
      items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    } catch (error) {
      console.error(`Failed ${lawd} ${ym}: ${error.message}`);
      continue;
    }

    const tx = db.transaction((rows) => {
      for (const item of rows) {
        const name = String(item.aptNm ?? "").trim();
        const umd = String(item.umdNm ?? "").trim();
        if (!name || !umd || !district) continue;

        const complex = findComplex.get({
          district,
          umd,
          name,
          nameLike: `%${name}%`,
        });
        if (!complex) {
          unmatched += 1;
          continue;
        }
        matched += 1;

        const building = String(item.aptDong ?? "").trim() || "동정보없음";
        const floor = Number(item.floor) || 0;
        const area = Number(item.excluUseAr) || 0;
        const price = parsePrice(item.dealAmount);
        if (price <= 0 || area <= 0) continue;

        const yearMonth = `${item.dealYear}-${String(item.dealMonth).padStart(2, "0")}`;
        const day = String(item.dealDay ?? "").padStart(2, "0");

        insert.run({
          id: `${complex.id}-${yearMonth}-${day}-${item.jibun ?? ""}-${building}-${floor}-${area}`,
          complexId: complex.id,
          year: yearMonth,
          building,
          floor,
          area,
          price,
        });
        inserted += 1;
      }
    });
    tx(items);

    console.log(
      `[${districtIndex + 1}/${lawds.length}] ${district}(${lawd}) ${ym}: items=${items.length} matched=${matched} unmatched=${unmatched} inserted=${inserted}`,
    );
  }
}

console.log(`Done. inserted=${inserted}, matched=${matched}, unmatched=${unmatched}`);
