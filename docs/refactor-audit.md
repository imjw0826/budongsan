# 리팩터 감사 — 현재 구현 기준

[`docs/seoul_real_estate_map_refactor_prompt.md`](./seoul_real_estate_map_refactor_prompt.md)와 현재 코드를 비교한 후, 최신 제품 결정까지 반영한 상태 문서입니다.

범례: ✅ 완료 · ⚠️ 부분 / 검토 · ❌ 미구현

## 1. 아키텍처

| 항목 | 상태 | 근거 |
|---|---|---|
| GeoJSON 일괄 로드 폐기 | ✅ | 정적 지도 레이어는 `public/tiles/{z}/{x}/{y}.pbf` raw MVT로 제공. 클라이언트 렌더 경로에서 `/api/map/chunks` 호출 없음 |
| Tile-like chunk structure | ✅ → 대체 | `tileChunkManager`/viewport chunk는 제거되고 MapLibre vector tile source가 LOD와 cache를 담당 |
| Canvas 렌더링 | ✅ → 대체 | Canvas/d3 렌더러 제거, MapLibre WebGL renderer로 단일화 |
| Transform 기반 pan/zoom | ✅ | MapLibre native camera interaction. React state는 `moveend` 이후 제품 상태 동기화에만 사용 |
| Zoom 기반 layer visibility | ✅ | `getZoomLayerVisibility(zoom)` |
| Viewport 기반 아파트 필터링 | ✅ | 구 또는 동 polygon + viewport + rank budget |
| MapLibre 실구현 | ✅ | [`src/map/maplibre/`](../src/map/maplibre/) — Stage / LayerStack / FeatureLayer / Marker / MarkerOverlay |
| 렌더러 인터페이스 분리 | ✅ → 단일화 | d3-geo / Canvas / Svg / WebGL placeholder는 MapLibre 전환과 함께 제거. 모든 layer는 MapLibre source+layer로 단일화 |

## 2. 레이어 정책

### Level 1: 서울 전체

| 표시 | 현재 |
|---|---|
| 서울 / 인접 행정구역 경계 | ✅ |
| 구 이름 | ✅ `showDistrictLabels: zoom < 14` |
| 구 hover 강조 | ✅ |
| 도로 / 건물 / 아파트 | ✅ 숨김 |

### Level 2: 구 단위 (`zoom 12~13`)

| 표시 | 현재 |
|---|---|
| 선택된 구 경계 강조 | ✅ |
| 한강 / 큰 공원 | ✅ |
| 대표 아파트 가격 칩 | ✅ `showApartmentLabels: >= 12`, `selectedDistrict || selectedDong` |
| 점형 단지 레이어 | ✅ 제거됨. 가격 칩 사용 |
| 광역 교통성 선형 레이어 | ✅ 제거됨 |
| 작은 도로 / 건물 | ✅ 숨김 |

### Level 3: 동 / 단지 (`zoom 14+`)

| 표시 | 현재 |
|---|---|
| 동 경계 / 동 라벨 | ✅ |
| 선택 동의 보조도로 | ✅ |
| 선택 동의 건물 footprint | ✅ |
| 아파트 이름 + 가격 칩 | ✅ |
| 아파트 popup / 상세 페이지 | ✅ |

## 3. 이번 수정에서 처리한 회귀

| 항목 | 상태 | 처리 |
|---|---|---|
| Level2에서 아파트 단지 위치가 보이지 않음 | ✅ | z12부터 제한된 가격 칩 노출 |
| 점형 단지 레이어가 제품 방향과 충돌 | ✅ | 가격 칩으로 단일화 |
| 광역 교통성 선형 레이어가 지도에 남음 | ✅ | 런타임 레이어, 서버 chunk layer, 데이터 생성 스크립트에서 제거 |
| 관련 문서 잔존 | ✅ | 문서 기준에서 제거 |
| pan/zoom 중 흰색 깜빡임 | ✅ | MapLibre WebGL tile renderer로 전환. 2026-06-04 Browser QA에서 scroll/drag 직후 흰색 플래시 미재현 |

## 4. 남은 검토

### P1 — 관찰 가능성 / 성능

- [x] Canvas/tile-cache 단계의 `cacheHitRate`, `visibleTiles`, `loadedTiles`, `renderedFeatures`, `TileCache.evictUnusedTiles(currentTileIds)` 작업은 MapLibre 전환으로 런타임 경로에서 제거됨
- [x] 정적 지리 레이어 cache/LOD는 MapLibre vector source가 담당
- [x] `usePerfLogger`는 일반 dev 세션에서 jank를 만들지 않도록 `?perf=1` 또는 `localStorage.mapPerf = "1"`일 때만 동작
- [x] white flicker 브라우저 수동 QA 완료: z12~13 가격 칩, z14+ 동 라벨, 건물 footprint, 보조도로, scroll/drag 직후 프레임에서 흰색 플래시 미재현

### P2 — 장기 렌더러

- [x] MapLibre renderer가 production path
- [x] `src/map/maplibre/`에 Stage / LayerStack / Marker / MarkerOverlay 분리
- [x] `src/map/data/`에 정적 GeoJSON 보조 loader와 hit-test용 repository 분리
- [x] `src/map/interactions/`에 pan/zoom phase hook 유지
- [x] Vector tiles 실험 → **완료**. PMTiles는 JS writer가 없어 raw MVT `.pbf` 정적 타일로 진행 (`scripts/build-vector-tiles.mjs` + `geojson-vt` + `vt-pbf`). PMTiles archive 포장은 tippecanoe/pmtiles CLI 설치 시 단일 명령으로 추가 가능 (`pmtiles convert ./tiles ./seoul.pmtiles`).

### P3 — 데이터 최적화

- [x] GeoJSON coordinate precision 축소 — [`scripts/optimize-boundaries.mjs`](../scripts/optimize-boundaries.mjs) (5자리, ~1.1 m, 전체 18.0 → 15.7 MB / -12.7%, dong·sigg·city·capital-sigg는 -45%+)
- [x] unused properties 제거 스크립트 — 동일 스크립트가 화이트리스트로 처리 (fullName, districtCode, highway, leisure, name 등 런타임 미사용 속성 제거)
- [x] zoom 별 geometry simplify 버전 생성 — Vector tile 파이프라인(`scripts/build-vector-tiles.mjs`)에서 `geojson-vt`가 zoom 별로 자동 simplification (tolerance=3px) 수행. 별도 simplify 스크립트 불필요.

## 5. 변경 파일

| 파일 | 변경 |
|---|---|
| [`src/map/constants.ts`](../src/map/constants.ts) | 광역 선형 / 점형 단지 visibility 제거, 가격 칩 z12 시작 |
| [`src/App.tsx`](../src/App.tsx) | 구 또는 동 선택 시 z12부터 complexes 요청, 가격 칩 표시 |
| [`src/map/maplibre/MapLibreLayerStack.tsx`](../src/map/maplibre/MapLibreLayerStack.tsx) | raw MVT source/layer 등록, hover/click 표현식, zoom visibility 적용 |
| [`src/map/maplibre/MapLibreMarkerOverlay.tsx`](../src/map/maplibre/MapLibreMarkerOverlay.tsx) | 구/동 라벨과 가격 칩 HTML overlay |
| [`src/map/data/mapRepository.ts`](../src/map/data/mapRepository.ts) | React 상태와 apartment filtering에 필요한 최소 GeoJSON repository |
| [`src/map/data/useMapData.ts`](../src/map/data/useMapData.ts) | 지도 보조 데이터 로딩 |
| [`server/api.mjs`](../server/api.mjs) | 정적 지도 청크는 클라이언트 렌더 경로에서 미사용. 동적 아파트/상세 API 유지 |
| [`src/data/boundaries.ts`](../src/data/boundaries.ts) | MapLibre 전환 후 제거됨 |
| [`scripts/fetch-seoul-outlines.mjs`](../scripts/fetch-seoul-outlines.mjs) | 광역 선형 파일 생성 제거, 보조도로만 생성 |
| [`docs/zoom-visibility.md`](./zoom-visibility.md) | 최신 줌 기준 반영 |
| [`src/map/layers/createOutsideSeoulMask.ts`](../src/map/layers/createOutsideSeoulMask.ts) | 서울 외부 mask geometry 생성 |
| [`src/map/interactions/usePanZoomPhaseCounters.ts`](../src/map/interactions/usePanZoomPhaseCounters.ts) | pan/zoom phase counter 유지 |
| [`src/map/constants.ts`](../src/map/constants.ts) | MapLibre visibility 기준 유지. historical tile/cache constants는 legacy fallback 전용으로 주석 명시 |
| [`scripts/optimize-boundaries.mjs`](../scripts/optimize-boundaries.mjs) | GeoJSON precision (5자리) + unused property whitelist. 전체 -12.7% / -2.4 MB. `--dry` / `--out=…` 모드 지원. |
| `public/boundaries/*.geojson` | 위 스크립트 결과로 in-place 갱신 (전체 -2.4 MB). |

## 7. MapLibre 마이그레이션 (이번 세션 완료)

### 새로 추가된 모듈

| 파일 | 역할 |
|---|---|
| [`src/map/maplibre/MapLibreStage.tsx`](../src/map/maplibre/MapLibreStage.tsx) | `maplibregl.Map` 마운트, 카메라 이벤트 ↔ React 상태 브리지, flyTo, panZoom phase emit |
| [`src/map/maplibre/MapLibreContext.ts`](../src/map/maplibre/MapLibreContext.ts) | map 인스턴스 + version 카운터 공유 |
| [`src/map/maplibre/MapLibreLayerStack.tsx`](../src/map/maplibre/MapLibreLayerStack.tsx) | 모든 vector 레이어 (mask / neighbors / districts / dongs / han / parks / roads / buildings) 등록 + hover/click 표현식 |
| [`src/map/maplibre/MapLibreMarker.tsx`](../src/map/maplibre/MapLibreMarker.tsx) | `maplibregl.Marker` + React portal 으로 DOM 마커 |
| [`src/map/maplibre/MapLibreMarkerOverlay.tsx`](../src/map/maplibre/MapLibreMarkerOverlay.tsx) | 구 라벨 / 동 라벨 / 가격 칩 / 팝업 — 기존 MarkerOverlayLayers의 MapLibre 버전 |
| [`src/map/viewport.ts`](../src/map/viewport.ts) | 공유 `MapViewport` 타입 (이전 `bounds.ts`에서 추출) |
| [`src/ErrorBoundary.tsx`](../src/ErrorBoundary.tsx) | 마운트 에러를 DOM에 표면화 (회귀 시 진단 비용 감소) |

### 제거된 모듈 (legacy d3 스택)

`src/map/MapStage.tsx`, `MapPaths.tsx`, `MapMarker.tsx`, `MapMarkerLayer.tsx`, `FlyTo.ts`, `useMapState.ts`, `projection.ts`, `bounds.ts`, `layers/{CanvasLayerSet, VectorOverlayLayers, MarkerOverlayLayers, styles}.tsx`, `renderers/{CanvasLayers, CanvasMapRenderer, SvgMapRenderer, WebGLMapRenderer, MapLibreRenderer, types}.tsx` — 18개 파일 삭제.

### 의존성 변경

- 추가: `maplibre-gl`
- 제거: `d3-geo`, `d3-zoom`, `d3-selection`, `d3-interpolate`, `d3-transition`, `@types/d3-*` (총 6개)

### 번들 영향

| 메트릭 | Pre-migration | Post-migration |
|---|---|---|
| JS (min) | 304 KB | 1,258 KB |
| JS (gzip) | 99 KB | 346 KB |
| CSS (min) | 21 KB | 91 KB (MapLibre 기본 CSS 포함) |

번들 크기 증가는 MapLibre GL JS 본체 (vector tile 렌더러 + 셰이더 + 텍스트 라이브러리)가 거의 전부. PMTiles 도입 시 데이터 페이로드는 크게 줄어드는 방향이라 trade-off는 장기적으로 positive.

### 마이그레이션 중 발견·수정한 버그

| 증상 | 원인 | 수정 |
|---|---|---|
| `Invalid LngLat latitude value` 크래시 | `[lat, lng]` ↔ `[lng, lat]` 순서 혼동 | MapLibre용 `SEOUL_CENTER_LNGLAT` 명명 + 호출처 정리 |
| 지도가 모두 mask로 가려짐 | GeoJSON 표준은 hole ring을 outer와 반대 방향으로 winding하는데, `createOutsideSeoulMask`는 city outer ring을 그대로 hole로 사용 | hole ring을 `.reverse()` 처리 |
| HMR 시 `getLayer` 호출 크래시 | map.remove() 이후 cleanup이 호출되어 style이 없음 | cleanup에서 `getStyle()` null 체크 후 bail |
| ref 값을 render 중 읽어 lint 경고 | map 인스턴스를 ref에 저장 | 상태 변수로 승격 |

### 검증

- [x] `tsc -b` 통과
- [x] `vite build` 통과 (1.26 MB JS / 91 KB CSS / 369 ms)
- [x] `eslint src/` 0 error
- [x] `node scripts/smoke-search-filter.mjs` 5/5 통과
- [x] Browser QA: 초기 25개 구 라벨 + 한강 + 외곽 마스크 정상, 용산구 진입 시 동 경계 + 가격 칩 노출. pan/scroll 직후 한강·건물·도로 레이어가 흰색으로 비지 않음. Vite HMR client의 과거 generic `Error` 로그 외 신규 앱 오류 없음.

## 8. 코드 스플리팅 + Vector tile 파이프라인 (이번 세션)

### Phase 1: 코드 스플리팅

- App.tsx → `App.tsx` (라우터, 32줄) + `MapPage.tsx` (lazy) + `DetailPage.tsx` (lazy)
- `vite.config.ts` `manualChunks`로 `maplibre` / `react` / `turf` vendor chunks 분리
- 결과: 디테일 페이지 진입은 maplibre 없이 ~86 KB gzip만 받음 (이전 346 KB → **75% 감소**)

| Chunk | gzip |
|---|---|
| react vendor | 60 KB |
| maplibre vendor | 273 KB (디테일 페이지에선 미로딩) |
| turf vendor | 1.9 KB |
| index/runtime/vendor | ~3 KB |
| MapPage | 7.8 KB |
| DetailPage | 1.6 KB |
| CSS | index 4 KB + maplibre 10 KB |

### Phase 2: Vector tile 파이프라인 (PMTiles-equivalent)

- `scripts/build-vector-tiles.mjs`: `geojson-vt` + `vt-pbf`로 9개 GeoJSON → 733개 `.pbf` (총 6.74 MB)
- 출력 경로: `public/tiles/{z}/{x}/{y}.pbf`, z=6..14
- 각 source layer가 자체 zoom 범위를 가짐 (예: buildings z13-14만, parks z10-14)
- `geojson-vt`는 zoom별 자동 simplify (tolerance=3px) — 별도 simplify 스크립트 불필요
- MapLibreLayerStack을 단일 `type: 'vector'` source로 재작성
- 클라이언트 viewport 필터링 로직 모두 제거 (MapLibre가 LOD/타일 fetch 처리)

### 함께 제거된 것

| 항목 | 이유 |
|---|---|
| `tileChunkManager.ts` | Vector tile pyramid가 청크 역할 대체 |
| `useViewportChunks.ts` | 동일 |
| `useTileCacheEviction.ts` | MapLibre가 자체 tile cache 관리 |
| `MapLibreFeatureLayer.tsx` | LayerStack이 직접 addLayer 호출 |
| MapPage의 `featureBounds`, `boundsOverlap`, `padViewport`, `limitFeatureCollection`, `limitBuildingFootprints` | 클라이언트 viewport 필터 불필요 |
| `usePerfLogger`의 tile/canvas 메트릭 | tile cache hits/fetched/visibleTiles 추적 사라짐 |

### Bundle 영향

번들 자체 크기는 변화 없음 (maplibre 자체가 1MB 차지). 영향은 **데이터 페이로드**:

| 메트릭 | Before (GeoJSON chunk) | After (vector tiles) |
|---|---|---|
| z11 viewport | ~250-500 KB JSON | ~100-200 KB MVT |
| z14 viewport | 1.5-3 MB JSON (clipped) | ~300-600 KB MVT |
| 효율 | 클라이언트 필터링 필요 | maplibre 자동 LOD |

### 검증

- [x] `tsc -b` + `vite build` 통과
- [x] `eslint src/` 0 error
- [x] Preview: z11 초기 화면, z13 줌인 (건물·도로·공원 자동 노출), 구 클릭, 동 라벨, 가격 칩 — 모두 정상, console 에러 0건
- [x] `npm run build:tiles` (or `node scripts/build-vector-tiles.mjs`) — 733개 tile 정상 생성

## 6. QA 체크리스트

- [x] z10~11에서 구 라벨만 보이고 아파트 칩은 보이지 않는다.
- [x] z12~13에서 선택된 구 안에 소수의 아파트 가격 칩이 보인다.
- [x] z12~13에서 광역 교통성 선형 레이어가 보이지 않는다.
- [x] z14+에서 동 경계와 동 라벨이 보인다.
- [x] 구 선택 후 보조도로와 건물 footprint가 보인다.
- [x] pan/zoom 중 배경이 흰색으로 비었다가 돌아오지 않는다.
- [x] `npm run lint`, `npm run build`, `npm run smoke:search-filter`가 통과한다.
