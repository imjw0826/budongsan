# API Setup

## Required Keys

Create `.env.local` in the project root:

```bash
DATA_GO_KR_SERVICE_KEY=공공데이터포털_일반인증키
VITE_VWORLD_API_KEY=브이월드_API_KEY
```

Do not commit `.env.local`.

## Public Data Portal

Use the 일반 인증키 from data.go.kr. Keep both the encoded and decoded versions available. If one returns an auth error, try the other.

Initial APIs:

- 국토교통부 아파트 매매 실거래가 자료
- 국토교통부 아파트 매매 실거래가 상세 자료
- 국토교통부 공동주택 단지 목록제공 서비스
- 국토교통부 공동주택 기본 정보제공 서비스

Apartment trade query parameters:

- `LAWD_CD`: 5-digit city/county/district legal-dong prefix, for example `11650` for Seoul Seocho-gu.
- `DEAL_YMD`: contract month in `YYYYMM`, for example `202604`.

## Local Smoke Test

Load `.env.local`, then fetch one month of Seocho-gu sample XML:

```bash
set -a
source .env.local
set +a
npm run fetch:trades -- 11650 202604 100
```

The raw XML is saved under `data/raw/`.

The trade fetch script uses the current data.go.kr gateway endpoint:

```text
https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade
```

Smoke-test all initial public endpoints:

```bash
set -a
source .env.local
set +a
npm run check:public-apis
```

Initial endpoint operations:

- `RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`
- `BldRgstHubService/getBrTitleInfo`
- `AptListService3/getSidoAptList3`
- `AptBasisInfoServiceV4/getAphusDtlInfoV4`

## VWorld

The current MVP uses a keyless temporary map background. The VWorld key will be used in the next step to replace it with official public map tiles or the 2D map SDK.
