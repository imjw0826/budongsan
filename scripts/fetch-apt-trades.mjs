import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
const lawdCode = process.argv[2] ?? "11650";
const dealMonth = process.argv[3] ?? "202604";
const rows = process.argv[4] ?? "100";

if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY is missing. Put it in .env.local or export it before running.");
  process.exit(1);
}

const endpoint =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";

const params = new URLSearchParams({
  pageNo: "1",
  numOfRows: rows,
  LAWD_CD: lawdCode,
  DEAL_YMD: dealMonth,
});

const keyParam = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);
const url = `${endpoint}?serviceKey=${keyParam}&${params.toString()}`;
const response = await fetch(url);
const text = await response.text();
const looksLikeGatewayAuthError =
  response.status === 401 || response.status === 403 || text.trim() === "Unauthorized" || text.trim() === "Forbidden";

if (!response.ok && looksLikeGatewayAuthError) {
  console.error(`Request failed: ${response.status} ${response.statusText}`);
  console.error(text.slice(0, 500));
  console.error(
    "Check that the key is approved for this exact OpenAPI service in data.go.kr and try the other encoded/decoded key value.",
  );
  process.exit(1);
}

if (!response.ok) {
  console.error(`Request failed: ${response.status} ${response.statusText}`);
  console.error(text.slice(0, 500));
  process.exit(1);
}

await mkdir(path.resolve("data/raw"), { recursive: true });
const outputPath = path.resolve("data/raw", `apt-trades-${lawdCode}-${dealMonth}.xml`);
await writeFile(outputPath, text, "utf8");

const hasItems = text.includes("<item>");
console.log(`Saved ${outputPath}`);
console.log(hasItems ? "Response contains trade items." : "No <item> rows found for this area/month.");
