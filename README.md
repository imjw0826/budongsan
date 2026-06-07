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
