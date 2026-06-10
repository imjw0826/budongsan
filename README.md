# Budongsan Map

서울 아파트 공시가격을 지도 위에서 빠르게 훑어보고, 단지별 동·층·호 가격을 확인하는 웹앱입니다.

## Tech Stack

- Frontend: React, TypeScript, Vite
- Map: Leaflet 1.9 + CARTO Positron raster tiles
- Charts: Recharts
- Icons: lucide-react
- API server: Express + better-sqlite3
- Data: V-World 국가중점데이터 공동주택가격정보 (반기 갱신)

## 개발

```bash
npm install
npm run dev        # API(8000) + Vite(5173) 동시 실행
```

## 배포

GitHub Pages 정적 사이트: **https://imjw0826.github.io/budongsan/**

```bash
npm run deploy   # 정적 export + gh-pages 푸시 (자세한 내용: DEPLOY.md)
```

## 데이터 갱신 (반기마다)

V-World 공동주택가격정보는 반기(5월/11월경)마다 갱신됩니다. 새 데이터 반영 절차:

1. [V-World 공동주택가격정보 데이터셋](https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=8) 접속 (로그인 필요)
2. 두 파일 다운로드 — 시도: **서울특별시**, 구분: 전체데이터
   - **SHP** (공동주택가격공간정보, `AL_D166_11_*.zip`) — 동 단위 위치 포인트
   - **CSV** (공동주택가격정보, `AL_D167_11_*.zip`) — 호별 공시가격, 약 400 MB
3. 압축 해제 후 배치 (기존 파일은 삭제해도 됨 — 최신 날짜 파일이 자동 선택됨)
   ```
   data/vworld/shp/AL_D166_11_YYYYMMDD.{dbf,shp,shx,prj}
   data/vworld/csv/AL_D167_11_YYYYMMDD.csv
   ```
4. 임포트 + 지도 데이터 재생성
   ```bash
   npm run import:vworld -- --shp --csv   # 위치 갱신 + 호별 가격 적재 (~2분)
   npm run build:complexes                # public/boundaries/seoul-complexes.geojson 재생성
   ```
5. 재배포: `npm run deploy`
6. 검증 (선택)
   ```bash
   npm run report:coordinate-quality      # 좌표-행정구역 일치 리포트 → docs/
   ```

참고:
- SHP 는 EPSG:5186 좌표계, CSV 는 CP949 인코딩 — 변환은 임포트 스크립트가 처리합니다.
- `data/` 디렉터리는 gitignore 대상이라 원본 파일은 커밋되지 않습니다.
- API 키가 필요 없는 경로입니다 (V-World 오픈API 의 /ned/ 계열은 별도 국가중점데이터 키 승인이 필요해서 파일 다운로드 방식을 사용).
