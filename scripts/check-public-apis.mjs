const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY is missing. Put it in .env.local or export it before running.");
  process.exit(1);
}

const keyParam = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);

const checks = [
  {
    name: "RTMSDataSvcAptTrade",
    url:
      `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
      `?serviceKey=${keyParam}&pageNo=1&numOfRows=1&LAWD_CD=11650&DEAL_YMD=202604`,
  },
  {
    name: "BldRgstHubService",
    url:
      `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo` +
      `?serviceKey=${keyParam}&pageNo=1&numOfRows=1&sigunguCd=11650&bjdongCd=10700&_type=xml`,
  },
  {
    name: "AptListService3",
    url:
      `https://apis.data.go.kr/1613000/AptListService3/getSidoAptList3` +
      `?serviceKey=${keyParam}&pageNo=1&numOfRows=1&sidoCode=11`,
  },
  {
    name: "AptBasisInfoServiceV4",
    url:
      `https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4` +
      `?ServiceKey=${keyParam}&kaptCode=A15876402`,
  },
];

for (const check of checks) {
  try {
    const response = await fetch(check.url);
    const text = await response.text();
    const preview = text
      .replaceAll(/\s+/g, " ")
      .replaceAll(serviceKey, "[REDACTED]")
      .slice(0, 220);
    const hasOkHeader = text.includes("<resultCode>00</resultCode>") || text.includes('"resultCode":"00"');
    console.log(`${check.name}: HTTP ${response.status}${hasOkHeader ? " / resultCode 00" : ""}`);
    console.log(`  ${preview}`);
  } catch (error) {
    console.log(`${check.name}: request failed`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}
