import { db, migrate } from "../server/db.mjs";

migrate();

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY is missing.");
  process.exit(1);
}

const year = process.argv.find((arg) => arg.startsWith("--year="))?.split("=")[1] ?? "2024";
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
const keyParam = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);

const bjdCodes = db
  .prepare(
    `
    SELECT DISTINCT bjd_code AS bjdCode
    FROM apartment_complexes
    WHERE bjd_code IS NOT NULL AND bjd_code != ''
    ORDER BY bjd_code
    ${limit > 0 ? "LIMIT @limit" : ""}
  `,
  )
  .all(limit > 0 ? { limit } : {});

const insert = db.prepare(`
  INSERT OR REPLACE INTO official_prices (
    id, complex_id, year, building, floor, area, price
  ) VALUES (
    @id, @complexId, @year, @building, @floor, @area, @price
  )
`);

const findComplex = db.prepare(`
  SELECT id
  FROM apartment_complexes
  WHERE bjd_code = @bjdCode
    AND (@name = '' OR name LIKE @nameLike OR @name LIKE '%' || name || '%')
  ORDER BY LENGTH(name) DESC
  LIMIT 1
`);

function normalizePrice(value) {
  const number = Number(String(value ?? "").replaceAll(",", ""));
  if (!Number.isFinite(number)) return 0;
  return Number((number / 100000000).toFixed(2));
}

function normalizeArea(value) {
  const number = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) ? number : 0;
}

async function fetchBjd(bjdCode, pageNo = 1) {
  const url =
    `http://apis.data.go.kr/1611000/nsdi/ApartHousingPriceService/attr/getApartHousingPriceAttr` +
    `?serviceKey=${keyParam}&pnu=${bjdCode}&stdrYear=${year}&format=json&numOfRows=1000&pageNo=${pageNo}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok || text.startsWith("Unexpected")) {
    throw new Error(text.slice(0, 180));
  }
  return JSON.parse(text);
}

let inserted = 0;
for (const [index, row] of bjdCodes.entries()) {
  try {
    let pageNo = 1;
    while (true) {
      const json = await fetchBjd(row.bjdCode, pageNo);
      const body = json.apartHousingPrices;
      const fields = Array.isArray(body?.field) ? body.field : body?.field ? [body.field] : [];
      if (fields.length === 0) break;

      for (const field of fields) {
        const name = field.aphusNm ?? "";
        const complex = findComplex.get({
          bjdCode: row.bjdCode,
          name,
          nameLike: `%${name}%`,
        });
        if (!complex) continue;

        const building = field.dongNm || field.aphusDongNm || field.buldNm || "동정보없음";
        const floor = Number(field.floorNm ?? field.floor ?? 0) || 0;
        const area = normalizeArea(field.prvuseAr ?? field.area);
        const price = normalizePrice(field.pblntfPc ?? field.apasmtPc ?? field.price);
        if (price <= 0) continue;

        insert.run({
          id: `${complex.id}-${year}-${building}-${floor}-${area}-${field.hoNm ?? ""}`,
          complexId: complex.id,
          year,
          building,
          floor,
          area,
          price,
        });
        inserted += 1;
      }

      const total = Number(body?.totalCount ?? 0);
      if (pageNo * 1000 >= total) break;
      pageNo += 1;
    }
    console.log(`Fetched ${index + 1}/${bjdCodes.length}: ${row.bjdCode}`);
  } catch (error) {
    console.error(`Failed ${row.bjdCode}: ${error.message}`);
  }
}

console.log(`Inserted/updated ${inserted} official price rows.`);
