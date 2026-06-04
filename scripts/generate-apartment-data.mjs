import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY is missing. Put it in .env.local or export it before running.");
  process.exit(1);
}

const keyParam = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);
const rows = process.argv[2] ?? "800";
const url =
  `https://apis.data.go.kr/1613000/AptListService3/getSidoAptList3` +
  `?serviceKey=${keyParam}&pageNo=1&numOfRows=${rows}&sidoCode=11`;

const districtCenters = {
  종로구: [37.5735, 126.9788],
  중구: [37.5636, 126.9976],
  용산구: [37.5326, 126.9905],
  성동구: [37.5635, 127.0368],
  광진구: [37.5384, 127.0823],
  동대문구: [37.5744, 127.0396],
  중랑구: [37.6063, 127.0927],
  성북구: [37.5894, 127.0167],
  강북구: [37.6396, 127.0257],
  도봉구: [37.6688, 127.0471],
  노원구: [37.6542, 127.0568],
  은평구: [37.6027, 126.9291],
  서대문구: [37.5791, 126.9368],
  마포구: [37.5663, 126.9019],
  양천구: [37.5169, 126.8664],
  강서구: [37.5509, 126.8495],
  구로구: [37.4955, 126.8876],
  금천구: [37.4569, 126.8955],
  영등포구: [37.5264, 126.8962],
  동작구: [37.5124, 126.9393],
  관악구: [37.4784, 126.9516],
  서초구: [37.4836, 127.0327],
  강남구: [37.5172, 127.0473],
  송파구: [37.5145, 127.1059],
  강동구: [37.5301, 127.1238],
};

const neighborhoodCenters = {
  "영등포구 여의도동": [37.5219, 126.9245],
  "영등포구 영등포동": [37.5187, 126.9075],
  "영등포구 당산동": [37.5348, 126.9027],
  "영등포구 문래동": [37.5172, 126.8896],
  "영등포구 신길동": [37.5061, 126.9137],
  "마포구 아현동": [37.5546, 126.9534],
  "마포구 공덕동": [37.5442, 126.9517],
  "마포구 상암동": [37.5794, 126.8894],
  "서대문구 남가좌동": [37.5753, 126.9169],
  "서대문구 북아현동": [37.5595, 126.9568],
  "성동구 성수동1가": [37.5448, 127.0432],
  "성동구 성수동2가": [37.5397, 127.0565],
  "성동구 행당동": [37.5576, 127.0339],
  "성동구 옥수동": [37.5437, 127.0136],
  "용산구 한남동": [37.5345, 127.0005],
  "용산구 이촌동": [37.5201, 126.9736],
  "용산구 서빙고동": [37.5208, 126.9946],
  "강남구 대치동": [37.4979, 127.0621],
  "강남구 압구정동": [37.5273, 127.0286],
  "강남구 역삼동": [37.5008, 127.0369],
  "강남구 도곡동": [37.4909, 127.0438],
  "강남구 개포동": [37.4828, 127.0574],
  "서초구 반포동": [37.5063, 127.001],
  "서초구 잠원동": [37.5154, 127.0122],
  "서초구 서초동": [37.4901, 127.0195],
  "서초구 방배동": [37.4823, 126.9942],
  "송파구 잠실동": [37.5112, 127.0832],
  "송파구 신천동": [37.5187, 127.1012],
  "송파구 가락동": [37.4974, 127.1075],
  "송파구 문정동": [37.4862, 127.1226],
  "송파구 방이동": [37.5105, 127.1238],
  "강동구 고덕동": [37.5605, 127.1558],
  "강동구 명일동": [37.5514, 127.144],
  "강동구 둔촌동": [37.5287, 127.1369],
  "양천구 목동": [37.526, 126.8705],
  "노원구 중계동": [37.648, 127.0767],
  "노원구 상계동": [37.6608, 127.0654],
  "은평구 진관동": [37.6375, 126.9208],
  "강서구 마곡동": [37.5665, 126.827],
};

function normalizedNeighborhood(name) {
  if (!name) return "";
  return name.replace(/\d가$/, "동");
}

function hash(input) {
  let value = 0;
  for (let i = 0; i < input.length; i += 1) {
    value = (value * 31 + input.charCodeAt(i)) >>> 0;
  }
  return value;
}

function jitteredCoordinate(item) {
  const exactKey = `${item.as2} ${item.as3}`;
  const normalizedKey = `${item.as2} ${normalizedNeighborhood(item.as3)}`;
  const center = neighborhoodCenters[exactKey] ?? neighborhoodCenters[normalizedKey] ?? districtCenters[item.as2] ?? [37.535, 127.02];
  const seed = hash(`${item.kaptCode}-${item.kaptName}`);
  const usesDongCenter = Boolean(neighborhoodCenters[exactKey] ?? neighborhoodCenters[normalizedKey]);
  const latSpan = usesDongCenter ? 0.011 : 0.045;
  const lngSpan = usesDongCenter ? 0.014 : 0.058;
  const latJitter = (((seed % 1000) / 1000) - 0.5) * latSpan;
  const lngJitter = ((((seed / 1000) | 0) % 1000) / 1000 - 0.5) * lngSpan;
  return [Number((center[0] + latJitter).toFixed(6)), Number((center[1] + lngJitter).toFixed(6))];
}

function priceSeed(item) {
  const seed = hash(`${item.as2}-${item.kaptName}`);
  const districtPremium = ["강남구", "서초구", "송파구", "용산구", "성동구"].includes(item.as2) ? 8 : 0;
  const min = Number((2.8 + districtPremium + (seed % 90) / 10).toFixed(1));
  const max = Number((min + 2.5 + ((seed / 100) % 90) / 10).toFixed(1));
  return { min, max };
}

function makeRows(item, range) {
  const buildings = ["101동", "102동", "103동", "104동"];
  return buildings.map((building, index) => ({
    id: `${item.kaptCode}-${index}`,
    date: "2026-01",
    building,
    floor: [3, 9, 17, 24][index],
    area: [59.9, 74.8, 84.9, 114.7][index],
    price: Number((range.min + ((range.max - range.min) * (index + 1)) / 4).toFixed(1)),
  }));
}

const response = await fetch(url);
const data = await response.json();
const items = data?.response?.body?.items ?? [];

const complexes = items
  .filter((item) => item.kaptCode && item.kaptName && item.as2)
  .map((item, index) => {
    const [lat, lng] = jitteredCoordinate(item);
    const range = priceSeed(item);
    return {
      id: item.kaptCode,
      name: item.kaptName,
      district: item.as2,
      neighborhood: item.as3 ?? "",
      bjdCode: item.bjdCode ?? "",
      address: [item.as1, item.as2, item.as3, item.as4].filter(Boolean).join(" "),
      lat,
      lng,
      households: 300 + (hash(item.kaptCode) % 4200),
      buildings: 4 + (hash(item.kaptName) % 28),
      mainArea: "59-115㎡",
      priceRange: range,
      changeRate: 0,
      image: "",
      transactions: makeRows(item, range),
    };
  });

await mkdir(path.resolve("src/data"), { recursive: true });
await writeFile(
  path.resolve("src/data/apartments.generated.ts"),
  `import type { ApartmentComplex } from "../types";\n\nexport const generatedApartments: ApartmentComplex[] = ${JSON.stringify(
    complexes,
    null,
    2,
  )};\n`,
  "utf8",
);

console.log(`Generated ${complexes.length} apartment complexes from AptListService3.`);
