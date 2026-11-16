# budongsan (서울 부동산 지도)

## 1. 프로젝트 소개

서울 아파트 공시가격을 지도 위에서 훑어보는 웹앱입니다. 단지별 위치와 동·층·호별 공시가격을 한 화면에서 확인해, 지역과 단지 사이의 가격을 빠르게 비교하는 것이 목적입니다.

## 2. 기술 스택

- **프론트엔드:** React, TypeScript, Vite
- **지도:** Leaflet, VWorld 백지도 (API 키가 없으면 Esri 회색 지도)
- **차트·아이콘:** Recharts, lucide-react
- **API 서버:** Express, better-sqlite3
- **데이터:** V-World 국가중점데이터 공동주택가격정보 (반기 갱신)
- **배포:** GitHub Pages (API 응답을 정적 파일로 내보내 배포)

## 3. 이용 방법

**웹사이트:** https://imjw0826.github.io/budongsan/

- 지도를 움직이며 서울 아파트 단지의 공시가격을 봅니다.
- 단지 이름으로 검색하거나 조건으로 걸러 봅니다.
- 단지를 선택하면 동·층·호별 가격을 확인할 수 있습니다.

로컬에서 실행하려면 Node.js가 필요합니다.

```bash
git clone https://github.com/imjw0826/budongsan.git
cd budongsan
npm install
npm run dev        # API(8000) + 웹(5173) 동시 실행
```

원본 데이터는 저장소에 들어 있지 않습니다. [V-World 공동주택가격정보](https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=8)에서 서울특별시 SHP와 CSV를 받아 `data/vworld/shp/`, `data/vworld/csv/`에 풀어 둔 뒤 다음을 실행합니다.

```bash
npm run import:vworld -- --shp --csv   # 위치와 호별 가격 적재
npm run build:complexes                # 지도용 단지 데이터 생성
npm run deploy                         # GitHub Pages 재배포
```

## 4. 최근 업데이트

2026-09-29
