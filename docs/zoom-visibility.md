# 줌 레벨별 가시성 규칙

서울 부동산 지도에서 줌 단계별로 어떤 레이어가 보이는지 정리한 문서입니다. 기준은 [`src/map/constants.ts`](../src/map/constants.ts)의 `getZoomLayerVisibility(zoom)`와 [`src/App.tsx`](../src/App.tsx)의 선택 상태 게이팅입니다.

## 1. 줌 스케일

내부 줌은 Leaflet 호환 단위 `10..18`을 유지합니다. MapLibre GL JS에는 `zoom - 1`을 전달하고, MapLibre 이벤트에서 읽은 값은 `+ 1` 해서 기존 제품 로직과 맞춥니다.

| 상수 | 값 | 의미 |
|---|---:|---|
| `MAP_MIN_ZOOM` | 10 | 서울 전체와 인접 행정구역 |
| `MAP_MAX_ZOOM` | 18 | 단지 주변 상세 |
| `ZOOM_CITY` | 10 | 시 단위 |
| `ZOOM_DISTRICT` | 12 | 구 단위, level2 |
| `ZOOM_DONG` | 14 | 동 단위 |
| `ZOOM_DETAIL` | 16 | 상세 단지 |
| `ZOOM_APARTMENT_DETAIL` | 17 | 단지 클로즈업 |

## 2. 레이어 표

| 레이어 / 라벨 | 조건 | z10 | z11 | z12 | z13 | z14 | z15 | z16 | z17 | z18 |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 자치구 외곽선 | 항상 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 자치구 라벨 | `< 14` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 행정동 외곽선 | `>= 14` + 구 선택 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 행정동 라벨 | `14..16` + 구 선택 + 동 미선택 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 한강 / 큰 공원 | 항상 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 보조도로 | `>= 14` + 구 선택 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 개별 건물 footprint | `>= 14` + 구 선택 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 아파트 가격 칩 | `>= 12` + 구 또는 동 선택 | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

광역 교통성 선형 레이어는 지도에서 제외했습니다. level2에서 아파트는 점형 위치 표시가 아니라 제한된 개수의 가격 칩으로 표시합니다.

## 3. 단계별 화면

### z10 ~ z11: 시 단위

- 서울과 인접 행정구역 경계
- 자치구 라벨
- 한강과 큰 공원
- 아파트, 건물, 도로 디테일 없음

### z12 ~ z13: 구 단위

- 선택된 구 경계 강조
- 구 안의 대표 아파트 가격 칩을 소수만 표시
- 광역 교통성 선형 레이어는 표시하지 않음
- 작은 도로와 건물은 아직 표시하지 않음

`complexRankBudget(zoom)` 기준으로 z12에서는 최대 6개, z13에서는 최대 10개 수준만 노출합니다.

### z14 ~ z15: 동 단위

- 행정동 경계와 동 라벨
- 선택된 구 또는 동 안의 아파트 가격 칩 추가 표시
- 선택된 구부터 보조도로와 건물 footprint 표시

### z16 ~ z18: 단지 상세

- 아파트 가격 칩 노출 수 확대
- z17 이상에서는 동 라벨을 숨겨 가격 칩과 충돌을 줄임
- 선택된 구 또는 동에서는 건물 footprint와 보조도로를 유지

## 4. 선택 상태 게이트

| 레이어 | 줌 조건 | 추가 조건 |
|---|---|---|
| 자치구 라벨 | `< 14` | 자치구 미선택일 때 기본 노출 |
| 자치구 강조 | 항상 | `selectedDistrict` |
| 행정동 경계 | `>= 14` | `selectedDistrict` |
| 행정동 라벨 | `14..16` | `selectedDistrict && !selectedDong` |
| 보조도로 | `>= 14` | `selectedDistrict` |
| 건물 footprint | `>= 14` | `selectedDistrict` |
| 아파트 가격 칩 | `>= 12` | `selectedDistrict || selectedDong` |

아파트 칩은 선택된 구 또는 동 polygon 안에 있는 단지만 필터링해서 표시합니다.

## 5. 클릭 시 카메라 이동

| 클릭 대상 | 도착 줌 | 설명 |
|---|---:|---|
| 자치구 라벨 | `ZOOM_DONG = 14` | 동 단위 진입 |
| 행정동 라벨 | `ZOOM_DETAIL - 1 = 15` | 동 선택 후 가격 칩 확대 |
| 브레드크럼 서울특별시 | `11` | 시 전체 뷰 |
| 브레드크럼 자치구 | `ZOOM_DONG = 14` | 구 단위로 복귀 |

## 6. Vector tile 로딩

정적 지도 레이어는 더 이상 `/api/map/chunks`를 호출하지 않습니다. [`scripts/build-vector-tiles.mjs`](../scripts/build-vector-tiles.mjs)가 `public/boundaries/*.geojson`을 `public/tiles/{z}/{x}/{y}.pbf` MVT 타일로 빌드하고, [`src/map/maplibre/MapLibreLayerStack.tsx`](../src/map/maplibre/MapLibreLayerStack.tsx)가 단일 MapLibre vector source로 로드합니다.

| Source layer | 데이터 | MVT zoom |
|---|---|---:|
| `city` | 서울 외곽 | 6..14 |
| `neighbors` | 서울 인접 시군구 | 6..14 |
| `districts` | 자치구 | 6..14 |
| `dongs` | 행정동 | 11..14 |
| `hanRiver` | 한강 | 8..14 |
| `parks` | 공원 / 녹지 | 10..14 |
| `roadsMinor` | 보조도로 | 12..14 |
| `buildings` | 건물 footprint | 13..14 |
| `complexes` | 단지 anchor | 11..14 |

MapLibre가 현재 viewport와 zoom에 필요한 `.pbf` 타일만 요청하고 자체 tile cache/LOD를 관리합니다. React 쪽은 경계 hit-test, mask, 가격 칩 필터링에 필요한 최소 GeoJSON만 한 번 로드합니다.

## 7. 요약

```text
zoom  10 -- 11 -- 12 -- 13 -- 14 -- 15 -- 16 -- 17 -- 18
      | city          | district      | dong          | detail
      | district labels --------|
      | han river / parks -------------------------------------|
      |               | apartment price chips -----------------|
      |                               | minor roads / buildings --|
      |                               | dong labels ----|
```

임계값을 바꾸면 `src/map/constants.ts`, `src/App.tsx`의 `complexRankBudget()`, 이 문서를 함께 갱신해야 합니다.
