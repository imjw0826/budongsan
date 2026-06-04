# Budongsan Map

한국 아파트 가격을 지도 위에서 빠르게 훑어보고, 단지별 가격 범위와 거래 변화를 확인하는 웹앱 MVP입니다.

현재 화면은 UI 검증용 샘플 데이터와 실제 VWorld 지도 타일을 사용합니다. 공공데이터포털 API 연동용 스크립트는 준비되어 있으며, 다음 단계에서 수집 데이터를 프론트 데이터 모델에 연결할 예정입니다.

## Tech Stack

- Frontend: React, TypeScript, Vite
- Charts: Recharts
- Icons: lucide-react
- Map tiles: VWorld WMTS
- Public data: data.go.kr OpenAPI
- Tooling: ESLint, TypeScript compiler

## Public APIs

현재 확인한 API 엔드포인트:

- `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`
- `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`
- `https://apis.data.go.kr/1613000/AptListService3/getSidoAptList3`
- `https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4`
- `https://api.vworld.kr/req/wmts/1.0.0/{key}/Base/{z}/{y}/{x}.png`

## Environment Variables

Create `.env.local` in the project root.

```bash
DATA_GO_KR_SERVICE_KEY=공공데이터포털_일반인증키
VITE_VWORLD_API_KEY=브이월드_API_KEY
```

Use the encoded public data key if available. Do not commit `.env.local`.

## Local Development

Install dependencies:

```bash
npm install
```

Start the local dev server:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

## Verification

Run type check and production build:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

Smoke-test the configured public APIs:

```bash
set -a
source .env.local
set +a
npm run check:public-apis
```

Fetch one month of apartment trade XML:

```bash
set -a
source .env.local
set +a
npm run fetch:trades -- 11650 202604 100
```

Arguments:

- `11650`: LAWD_CD, Seoul Seocho-gu
- `202604`: DEAL_YMD, April 2026
- `100`: numOfRows

Raw XML is saved under `data/raw/`, which is ignored by Git.

## Current Features

- VWorld tile-based map background
- Apartment price labels by range
- Search by complex name, district, or neighborhood
- Price-band filter
- Complex list
- Detail panel with price range, change rate, household count
- Transaction trend chart
- Floor-level transaction chart
- Recent transaction table

## Next Steps

- Parse real XML/JSON OpenAPI responses into normalized local data.
- Replace `src/data/apartments.ts` sample data with collected apartment complexes and trades.
- Add district/month selection for data collection.
- Add backend storage with PostgreSQL/PostGIS when the data volume grows beyond static files.
