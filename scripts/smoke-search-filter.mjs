const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

const cases = [
  {
    name: "Hwanghak dong all apartments",
    path: "/api/apartments?regionType=dong&regionId=1114067000&zoom=17&q=&band=all",
    expectedTotal: 4,
    expectedDistrict: "중구",
    expectedNeighborhood: "황학동",
  },
  {
    name: "Hwanghak under 8eok filter",
    path: "/api/apartments?regionType=dong&regionId=1114067000&zoom=17&q=&band=under8",
    expectedTotal: 2,
    expectedDistrict: "중구",
    expectedNeighborhood: "황학동",
  },
  {
    name: "Hwanghak 8-15eok filter",
    path: "/api/apartments?regionType=dong&regionId=1114067000&zoom=17&q=&band=8to15",
    expectedTotal: 1,
    expectedDistrict: "중구",
    expectedNeighborhood: "황학동",
  },
  {
    name: "Hwanghak over 15eok filter",
    path: "/api/apartments?regionType=dong&regionId=1114067000&zoom=17&q=&band=over15",
    expectedTotal: 1,
    expectedDistrict: "중구",
    expectedNeighborhood: "황학동",
  },
  {
    name: "Exact complex search",
    path: "/api/apartments?regionType=dong&regionId=1114067000&zoom=17&q=%ED%99%A9%ED%95%99%EC%95%84%ED%81%AC%EB%A1%9C&band=all",
    expectedTotal: 1,
    expectedIds: ["A10086801"],
    expectedDistrict: "중구",
    expectedNeighborhood: "황학동",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const testCase of cases) {
  const response = await fetch(`${baseUrl}${testCase.path}`);
  assert(response.ok, `${testCase.name}: HTTP ${response.status}`);
  const data = await response.json();
  assert(
    data.totalInViewport === testCase.expectedTotal,
    `${testCase.name}: expected total ${testCase.expectedTotal}, got ${data.totalInViewport}`,
  );
  assert(
    Array.isArray(data.items) && data.items.length === testCase.expectedTotal,
    `${testCase.name}: expected ${testCase.expectedTotal} visible items, got ${data.items?.length}`,
  );
  for (const item of data.items) {
    assert(
      item.district === testCase.expectedDistrict,
      `${testCase.name}: wrong district for ${item.id}: ${item.district}`,
    );
    assert(
      item.neighborhood === testCase.expectedNeighborhood,
      `${testCase.name}: wrong neighborhood for ${item.id}: ${item.neighborhood}`,
    );
  }
  if (testCase.expectedIds) {
    const ids = data.items.map((item) => item.id).sort();
    assert(
      JSON.stringify(ids) === JSON.stringify([...testCase.expectedIds].sort()),
      `${testCase.name}: expected ids ${testCase.expectedIds.join(",")}, got ${ids.join(",")}`,
    );
  }
  console.log(`pass ${testCase.name}`);
}

console.log(`search/filter smoke passed (${cases.length} cases)`);
