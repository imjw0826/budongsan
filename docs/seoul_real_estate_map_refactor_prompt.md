# Seoul Real Estate Map Refactor Prompt

## Master Prompt for Coding AI

너는 대용량 지도 렌더링, WebGL, vector tile, Canvas, MapLibre GL JS, GeoJSON 최적화에 능숙한 시니어 프론트엔드/지도 개발자다.

나는 “서울 부동산 가격 지도 웹사이트”를 만들고 있다. 현재 문제는 지도 렌더링이 너무 느리다는 것이다. 기존 구조는 서울의 GeoJSON 데이터를 SVG DOM path로 직접 렌더링하는 방식이다. 행정구역, 도로, 건물, 녹지, 아파트 단지 같은 feature가 많아질수록 SVG path DOM 수가 폭발해서 브라우저가 느려진다.

이번 리팩토링의 핵심 목표는 기존 SVG DOM 중심 구조를 버리고, 네이버지도나 MapLibre 같은 지도 서비스에 가까운 구조로 바꾸는 것이다.

즉, 다음 구조를 목표로 한다.

- 전체 GeoJSON을 한 번에 SVG DOM으로 그리지 않는다.
- 현재 화면과 줌 레벨에 필요한 지도 조각만 로드한다.
- 가능하면 map tile / vector tile / PMTiles / MVT 구조를 사용한다.
- 팬/줌 중에는 데이터를 매번 다시 계산하지 말고, 기존 렌더링 레이어를 transform으로 먼저 움직인다.
- 이동/줌이 끝난 뒤 필요한 타일과 데이터를 갱신한다.
- tile preload, tile transition, tile duration 개념을 적용한다.
- 무거운 지도 레이어는 Canvas 또는 WebGL로 렌더링한다.
- 아파트 이름/가격 같은 오버레이는 줌 레벨과 viewport 기준으로 제한적으로 표시한다.

---

## 최종 목표

웹사이트에서 서울 지도를 보여준다.

초기 화면에서는:

- 서울 전체 지도
- 행정구역 경계
- 행정구역 이름
- 빠른 초기 렌더링
- 부드러운 줌/팬

사용자가 특정 행정구역을 클릭하거나 확대하면:

- 해당 구역으로 부드럽게 이동/확대
- 도로, 건물, 녹지 같은 세부 정보 표시
- 아파트 단지 또는 아파트 위치 표시
- 아파트 이름과 가격 표시

아파트 정보는 우선 다음 두 가지만 필요하다.

- 아파트 이름
- 가격

아파트 이름과 가격에 대한 데이터베이스는 이미 존재한다. 다만, 아파트 위치를 지도 위에 매핑하는 방식은 다시 설계해야 한다.

---

## 가장 중요한 구조 변경 요구사항

현재 구조처럼 서울 전체 GeoJSON을 한 번에 불러와서 SVG path로 전부 그리는 방식은 피하라.

대신 다음 중 하나를 선택하거나, 현재 코드 상황에 맞게 단계적으로 적용하라.

### 권장 최종 구조

가능하다면 다음 구조를 최우선으로 고려하라.

```text
MapLibre GL JS
+ WebGL 렌더링
+ Vector Tile / MVT / PMTiles
+ zoom-based layer visibility
+ viewport-based apartment overlay filtering
```

이 구조가 최종적으로 가장 적합하다.

### 현실적인 중간 구조

현재 코드를 바로 MapLibre로 전환하기 어렵다면, 다음 구조로 리팩토링하라.

```text
D3 projection 유지
+ Canvas 렌더링
+ tile-like chunk loading
+ transform-based pan/zoom
+ lazy loading
+ SVG/HTML overlay 최소화
```

단, 이 경우에도 코드 구조는 나중에 MapLibre/vector tile로 옮기기 쉽게 설계하라.

---

## Map Tile / Tile-like 구조 요구사항

지도 데이터를 전체 파일 하나로 다루지 말고, tile 또는 chunk 단위로 나누어 관리하라.

목표 구조:

```text
/data/tiles/{z}/{x}/{y}.json
/data/tiles/{z}/{x}/{y}.pbf
/data/pmtiles/seoul.pmtiles
```

중 하나를 고려하라.

현재 프로젝트에서 당장 MVT나 PMTiles를 만들기 어렵다면, 임시로 GeoJSON을 다음처럼 나누어도 된다.

```text
/data/seoul/districts.geojson
/data/seoul/districts-labels.json

/data/seoul/chunks/gangnam/roads.geojson
/data/seoul/chunks/gangnam/green.geojson
/data/seoul/chunks/gangnam/buildings.geojson
/data/seoul/chunks/gangnam/apartments.geojson

/data/seoul/chunks/seocho/roads.geojson
/data/seoul/chunks/seocho/green.geojson
/data/seoul/chunks/seocho/buildings.geojson
/data/seoul/chunks/seocho/apartments.geojson
```

하지만 최종적으로는 다음 구조를 목표로 하라.

```text
서울 전체 행정구역: low zoom vector tile
도로/녹지/건물: zoom별 vector tile
아파트 단지: vector tile 또는 별도 API
아파트 이름/가격: viewport + zoom 기준 API
```

---

## Tile 계산 구조

지도는 현재 viewport와 zoom level을 기준으로 필요한 tile만 계산해야 한다.

필요한 로직:

1. 현재 지도 중심 좌표 확인
2. 현재 zoom level 확인
3. 현재 viewport bounds 계산
4. bounds와 zoom에 해당하는 tile index 계산
5. 필요한 tile만 로드
6. 이미 로드된 tile은 cache에서 재사용
7. 화면 밖으로 너무 멀어진 tile은 제거하거나 cache에 보관
8. 현재 zoom level에서 불필요한 detail layer는 로드하지 않음

타일 인덱스 구조 예시:

```ts
type TileId = `${number}/${number}/${number}`;

type TileCoord = {
  z: number;
  x: number;
  y: number;
};

type TileData = {
  id: TileId;
  coord: TileCoord;
  layers: {
    roads?: GeoJSON.FeatureCollection;
    green?: GeoJSON.FeatureCollection;
    buildings?: GeoJSON.FeatureCollection;
    apartments?: GeoJSON.FeatureCollection;
  };
  loadedAt: number;
};
```

---

## Transform 기반 pan/zoom 처리 요구사항

팬/줌 중에 매번 모든 GeoJSON을 다시 projection하고 다시 렌더링하지 말 것.

다음 방식으로 처리하라.

### Pan 중

사용자가 지도를 드래그하는 동안:

```text
1. 기존에 그려진 canvas/webgl layer를 transform으로 이동
2. 매 프레임마다 모든 feature를 다시 계산하지 않음
3. 필요한 경우 requestAnimationFrame 사용
4. pan이 끝나거나 idle 상태가 되면 새 viewport 기준으로 필요한 tile을 로드
5. 로드된 tile만 다시 렌더링
```

### Zoom 중

사용자가 확대/축소하는 동안:

```text
1. 현재 렌더링된 layer를 scale transform으로 먼저 확대/축소
2. 마우스 위치 또는 zoom origin을 기준으로 자연스럽게 확대
3. 줌 중에는 무거운 데이터를 계속 다시 렌더링하지 않음
4. zoom end 또는 idle 상태에서 해당 zoom level의 tile/layer를 다시 로드
5. 새 detail level의 데이터로 자연스럽게 교체
```

이 구조를 코드로 분리하라.

예시 상태:

```ts
type ViewState = {
  center: [number, number];
  zoom: number;
  scale: number;
  translateX: number;
  translateY: number;
  isPanning: boolean;
  isZooming: boolean;
  isIdle: boolean;
};
```

필요 이벤트:

```ts
onPanStart
onPanMove
onPanEnd
onZoomStart
onZoomMove
onZoomEnd
onIdle
```

---

## Tile Spare / Tile Preload 요구사항

네이버지도의 tileSpare와 비슷한 개념을 구현하라.

즉, 현재 화면에 딱 맞는 tile만 불러오지 말고, 화면 주변의 여분 tile도 미리 로드하라.

예시:

```ts
const TILE_SPARE = 1;
```

현재 viewport에 필요한 tile이 다음과 같다면:

```text
x: 10~12
y: 20~22
```

실제로는 주변 1칸까지 포함해서 로드한다.

```text
x: 9~13
y: 19~23
```

장점:

- 사용자가 조금만 이동해도 빈 화면이 덜 보임
- 팬이 더 부드러워짐
- tile loading이 눈에 덜 띔

구현 요구사항:

- TILE_SPARE 값을 상수로 관리
- 네트워크/메모리 상황에 따라 조절 가능하게 설계
- 낮은 zoom에서는 spare를 크게, 높은 zoom에서는 적절히 제한하는 것도 고려
- 이미 로드된 tile은 다시 요청하지 말 것
- tile cache를 구현할 것

예시:

```ts
const TILE_SPARE_BY_ZOOM = {
  low: 2,
  medium: 1,
  high: 1,
};
```

---

## Tile Transition 요구사항

새 tile이 로드되었을 때 갑자기 화면에 나타나지 않게 하라.

새 tile은 fade-in 또는 opacity transition으로 자연스럽게 등장해야 한다.

예시 상태:

```ts
type RenderTile = {
  id: TileId;
  data: TileData;
  opacity: number;
  status: "loading" | "fading-in" | "visible" | "error";
};
```

구현 요구사항:

1. tile이 로드되면 바로 opacity 1로 만들지 않는다.
2. 처음에는 opacity 0에서 시작한다.
3. requestAnimationFrame 또는 CSS transition으로 opacity를 증가시킨다.
4. 기존 tile과 새 tile이 자연스럽게 교체되도록 한다.
5. tile loading 중에도 이전 화면을 최대한 유지한다.

예시:

```ts
const TILE_TRANSITION_ENABLED = true;
const TILE_DURATION = 200;
```

---

## Tile Duration 요구사항

타일 전환 시간은 상수로 관리하라.

예시:

```ts
const TILE_DURATION_MS = 200;
```

이 값은 다음에 사용한다.

- 새 tile fade-in 시간
- zoom 후 detail layer 교체 시간
- 구역 클릭 후 layer transition 시간

너무 길면 지도 반응이 느리게 느껴지고, 너무 짧으면 깜빡이는 느낌이 날 수 있다. 기본값은 150~250ms 사이로 설정하라.

---

## WebGL 사용 요구사항

가능하다면 WebGL 렌더링을 사용하라.

우선순위:

1. MapLibre GL JS를 사용할 수 있으면 MapLibre 기반으로 전환하라.
2. MapLibre 전환이 너무 크면, deck.gl 또는 직접 WebGL layer를 고려하라.
3. 당장 WebGL이 어렵다면 Canvas로 먼저 바꾸되, 코드 구조는 WebGL renderer로 교체 가능하게 만들라.

렌더러 인터페이스를 분리하라.

예시:

```ts
interface MapRenderer {
  initialize(container: HTMLElement): void;
  setViewState(viewState: ViewState): void;
  renderTiles(tiles: RenderTile[]): void;
  renderOverlay(data: OverlayData): void;
  destroy(): void;
}
```

가능한 구현체:

```ts
class CanvasMapRenderer implements MapRenderer {}
class WebGLMapRenderer implements MapRenderer {}
class MapLibreRenderer implements MapRenderer {}
```

처음부터 모두 구현할 필요는 없지만, 구조는 이렇게 교체 가능하게 만들어라.

---

## 레이어 표시 정책

지도 레이어는 zoom level에 따라 다르게 표시한다.

### Level 1: 서울 전체 보기

표시:

- 서울 행정구역 경계
- 구 이름
- 선택 hover

숨김:

- 도로
- 건물
- 세부 녹지
- 아파트 이름
- 아파트 가격

목표:

- 초기 렌더링이 매우 빨라야 함

### Level 2: 구 단위 보기

조건:

- 사용자가 구를 클릭했거나 일정 수준 이상 zoom in 했을 때

표시:

- 선택된 구 경계 강조
- 큰 녹지/공원
- 아파트 단지 위치 또는 간단한 footprint
- 일부 대표 아파트

숨김:

- 모든 작은 도로
- 모든 건물
- 과도한 label

목표:

- 구 단위에서 가격 분포를 볼 수 있게 함

### Level 3: 동네/아파트 단지 보기

표시:

- 아파트 단지 footprint
- 아파트 이름
- 가격
- 간단한 도로
- 공원/녹지
- 선택한 아파트 popup

목표:

- 사용자가 실제 아파트 단지별 가격을 비교할 수 있게 함

---

## 아파트 위치 매핑 설계

아파트 데이터베이스에는 이미 이름과 가격이 있다. 하지만 위치 정보 매핑이 아직 완성되지 않았다.

다음 구조를 고려하라.

### 1. 주소 기반 geocoding

아파트 DB에 주소가 있다면:

- 주소를 좌표로 변환
- latitude, longitude 컬럼 추가
- 한 번 변환한 좌표는 DB에 저장
- 프론트에서 매번 geocoding하지 말 것

필요 컬럼:

```ts
type Apartment = {
  id: string;
  name: string;
  price: number;
  districtName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
};
```

### 2. 아파트 단지 polygon 매칭

아파트 단지 footprint 또는 polygon 데이터가 있다면:

- 아파트 이름 또는 주소로 polygon과 매칭
- polygon centroid를 label 위치로 사용
- polygon 자체를 단지 구분 영역으로 표시

확장 타입:

```ts
type Apartment = {
  id: string;
  name: string;
  price: number;
  districtName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  polygonId?: string;
  centroid?: [number, number];
};
```

추천:

- 최종적으로는 아파트 단지 polygon 기반이 가장 좋다.
- 단순 마커보다 단지 footprint가 있으면 아파트 단지들이 서로 구분되어 보인다.
- 위치가 없는 아파트는 임시 fallback을 쓰되, 추후 실제 좌표/polygon으로 쉽게 교체할 수 있게 만들어라.

---

## 아파트 label / popup 최적화

아파트 이름과 가격을 처음부터 전부 표시하지 말 것.

규칙:

```text
서울 전체 zoom:
- 아파트 label 표시 안 함

구 단위 zoom:
- 대표 아파트 또는 가격 cluster만 표시

상세 zoom:
- viewport 안의 아파트만 표시
- label collision을 고려
- 너무 겹치면 일부 label 숨김
- 클릭 시 popup으로 이름과 가격 표시
```

아파트 label은 DOM이 너무 많아지면 느려질 수 있으므로 다음 중 하나로 구현하라.

1. WebGL symbol layer
2. Canvas text rendering
3. 제한된 HTML overlay
4. MapLibre symbol layer

가능하면 MapLibre symbol layer 또는 Canvas text를 우선 고려하라.

---

## 데이터 최적화 요구사항

GeoJSON을 그대로 크게 불러오지 말고 다음 작업을 적용하라.

1. unused properties 제거
2. coordinate precision 축소
3. geometry simplify
4. zoom별 데이터 분리
5. 구 단위 또는 tile 단위 chunking
6. viewport filtering
7. lazy loading
8. tile cache
9. request deduplication
10. abortable fetch

예시:

```ts
const abortController = new AbortController();

fetch(tileUrl, {
  signal: abortController.signal,
});
```

사용자가 빠르게 지도를 움직이면 더 이상 필요 없는 tile 요청은 취소하라.

---

## 캐싱 요구사항

타일과 구역 데이터를 캐싱하라.

```ts
class TileCache {
  get(tileId: TileId): TileData | undefined;
  set(tileId: TileId, data: TileData): void;
  has(tileId: TileId): boolean;
  evictUnusedTiles(currentTileIds: Set<TileId>): void;
}
```

요구사항:

- 이미 로드한 tile은 재사용
- 현재 화면 주변 tile은 유지
- 너무 오래 안 쓰는 tile은 제거
- 메모리 사용량이 너무 커지지 않게 관리
- 요청 중인 tile은 중복 요청하지 않음

---

## 팬/줌 성능 요구사항

팬/줌 중에는 다음을 피하라.

금지:

- 모든 GeoJSON feature 재계산
- 모든 SVG path d 속성 재생성
- 모든 label DOM 재배치
- 전체 데이터 fetch 반복
- zoom move 이벤트마다 heavy render

허용:

- transform translate/scale
- requestAnimationFrame 기반 lightweight update
- idle 상태에서 tile update
- 현재 viewport에 필요한 데이터만 갱신

---

## UI 동작 요구사항

1. 첫 화면
   - 서울 전체가 보인다.
   - 구 경계와 구 이름만 보인다.
   - 렉 없이 빠르게 떠야 한다.

2. 구 hover
   - 마우스를 올리면 해당 구역이 살짝 강조된다.
   - hover 때문에 전체 지도를 다시 렌더링하지 않는다.

3. 구 click
   - 해당 구역으로 부드럽게 zoom in 한다.
   - 선택된 구역 경계가 강조된다.
   - zoom transition 중에는 기존 레이어를 transform으로 먼저 확대한다.
   - zoom이 끝난 뒤 해당 구역의 세부 tile/chunk를 로드한다.

4. 확대 상태
   - 녹지와 일부 대표 아파트 가격 정보가 표시된다.
   - 아파트 단지들이 서로 구분되어 보여야 한다.
   - 아파트 이름/가격은 viewport와 zoom 기준으로 제한적으로 표시한다.
   - 아파트를 클릭하면 popup으로 이름과 가격이 표시된다.

5. 다시 축소
   - 세부 레이어가 자연스럽게 사라진다.
   - 다시 행정구역 중심 화면으로 돌아간다.

---

## 코드 품질 요구사항

- 지도 렌더링 코드와 데이터 로딩 코드를 분리하라.
- tile manager, cache manager, renderer, interaction controller를 분리하라.
- zoom threshold 값은 상수로 관리하라.
- TILE_SPARE, TILE_DURATION, TILE_TRANSITION_ENABLED도 상수로 관리하라.
- 추후 MapLibre/vector tile 구조로 이전하기 쉽게 데이터 source와 renderer를 분리하라.
- 아파트 데이터 타입을 명확히 정의하라.
- 위치가 없는 아파트는 fallback 처리하되, 임시 코드라는 것을 명확히 표시하라.
- 성능 측정을 위해 렌더링 feature 수, loaded tile 수, cache hit rate, render time, FPS를 console에서 확인할 수 있게 하라.

예시 상수:

```ts
const ZOOM_DISTRICT = 1;
const ZOOM_DISTRICT_DETAIL = 2;
const ZOOM_APARTMENT_DETAIL = 3;

const TILE_SPARE = 1;
const TILE_DURATION_MS = 200;
const TILE_TRANSITION_ENABLED = true;

const MAX_VISIBLE_APARTMENT_LABELS = 200;
```

---

## 추천 파일 구조

가능하면 다음 구조를 참고해서 리팩토링하라.

```text
src/
  map/
    constants.ts
    types.ts

    renderer/
      MapRenderer.ts
      CanvasMapRenderer.ts
      WebGLMapRenderer.ts
      MapLibreRenderer.ts

    tiles/
      tileUtils.ts
      TileManager.ts
      TileCache.ts
      tileLoader.ts

    layers/
      districtLayer.ts
      roadLayer.ts
      greenLayer.ts
      buildingLayer.ts
      apartmentLayer.ts
      labelLayer.ts

    interactions/
      panZoomController.ts
      districtClickController.ts
      tooltipController.ts

    data/
      apartmentMapper.ts
      apartmentRepository.ts
      geojsonOptimizer.ts
```

---

## 성능 측정 요구사항

리팩토링 후 다음을 로그로 확인할 수 있게 하라.

```ts
console.table({
  zoom,
  visibleTiles,
  loadedTiles,
  renderedFeatures,
  visibleApartmentLabels,
  renderTimeMs,
  cacheHitRate,
  fps,
});
```

목표:

- 첫 화면에서 SVG path 수를 최소화
- 도로/건물/녹지 때문에 DOM이 폭발하지 않게 하기
- 팬/줌 중 heavy render 방지
- idle 이후 필요한 tile만 갱신
- 아파트 label 수 제한
- 지도 이동 시 빈 화면 최소화

---

## 최종 결과

최종 결과는 다음과 같아야 한다.

- 서울 전체 지도 초기 렌더링이 빠르다.
- 처음에는 행정구역과 구 이름만 표시된다.
- 지도를 움직일 때 기존 레이어가 transform으로 부드럽게 움직인다.
- 줌 중에는 기존 레이어를 scale transform으로 먼저 처리한다.
- 이동/줌이 끝난 뒤 필요한 tile/chunk만 로드한다.
- tile spare 개념으로 주변 데이터가 미리 로드된다.
- 새 tile은 tile transition과 tile duration을 통해 자연스럽게 등장한다.
- 무거운 지도 레이어는 SVG DOM이 아니라 Canvas/WebGL/MapLibre 기반으로 렌더링된다.
- 도로는 간단하게 표시된다.
- 아파트 단지들은 서로 구분되어 보인다.
- 아파트를 클릭하면 이름과 가격이 표시된다.
- 아파트 label은 zoom과 viewport 기준으로 제한적으로 표시된다.
- 전체 GeoJSON을 한 번에 SVG DOM으로 렌더링하지 않는다.
- 향후 MapLibre GL JS + vector tile + PMTiles 구조로 확장하기 쉽다.

현재 코드베이스를 먼저 분석한 뒤, 위 목표에 맞게 가장 안전한 리팩토링 계획을 세우고 코드를 수정하라.

중요: 단순히 기존 SVG path 코드를 조금 고치는 수준이 아니라, 지도 렌더링 구조 자체를 tile-based, transform-based, Canvas/WebGL-ready 구조로 재설계하라.

단, 한 번에 전체 프로젝트를 망가뜨리지 말고 단계적으로 리팩토링하라. 먼저 현재 동작을 유지한 상태에서 렌더링 구조를 분리하고, 그 다음 Canvas/tile/cache/transition/WebGL 구조를 순서대로 적용하라.

---

# How to Split This Work for an AI Coding Agent

## Recommended Workflow

Do not give the master prompt and ask the agent to implement everything at once. Use the master prompt as the project direction document, then split implementation into small tickets.

A good AI coding workflow is:

1. Ask the AI to inspect the codebase and make an implementation plan only.
2. Ask it to implement one small structural change.
3. Run the app and tests.
4. Commit the working state.
5. Move to the next ticket.
6. Start a fresh AI chat/session when the context gets too long.

## Ticket 0 — Codebase Audit Only

Prompt:

```text
Read the current codebase and do not modify files yet.

I am building a Seoul real estate price map. The current map is slow because it likely renders many GeoJSON features as SVG DOM paths.

Your task:
1. Identify where the map is rendered.
2. Identify where GeoJSON is loaded.
3. Count or estimate where many SVG paths are created.
4. Identify current pan/zoom logic.
5. Identify current apartment data flow.
6. Propose a staged refactor plan.

Do not write code yet. Return:
- file map
- bottlenecks
- safest first refactor
- risks
- exact files that should change in step 1
```

## Ticket 1 — Add Map Types and Constants

Prompt:

```text
Implement only the foundational map types and constants.

Create or update:
- src/map/types.ts
- src/map/constants.ts

Add types for:
- ViewState
- TileCoord
- TileId
- TileData
- RenderTile
- Apartment
- MapLayerType

Add constants for:
- zoom thresholds
- TILE_SPARE
- TILE_DURATION_MS
- TILE_TRANSITION_ENABLED
- MAX_VISIBLE_APARTMENT_LABELS

Do not change rendering behavior yet.
Do not refactor the whole map yet.
After changes, make sure TypeScript builds.
```

## Ticket 2 — Separate Data Loading from Rendering

Prompt:

```text
Refactor the current map code so data loading is separated from rendering.

Goal:
- No visual behavior change.
- Move GeoJSON loading into a clear loader/repository module.
- Keep the current SVG rendering working.
- Prepare the code so later we can replace the renderer with Canvas or MapLibre.

Do not implement Canvas yet.
Do not implement tile loading yet.
Only separate concerns safely.
```

## Ticket 3 — Add Performance Logging

Prompt:

```text
Add lightweight performance logging to the map.

Track:
- current zoom
- number of rendered SVG paths or features
- render time in ms
- number of apartment labels
- FPS estimate if easy

Show logs with console.table in development mode only.

Do not change map visuals.
This step is for measuring before/after performance.
```

## Ticket 4 — Introduce Renderer Interface

Prompt:

```text
Create a renderer abstraction without changing the current visual output.

Add:
- MapRenderer interface
- SvgMapRenderer implementation wrapping the current behavior if needed
- placeholder CanvasMapRenderer class, but do not fully switch to Canvas yet

Goal:
- Current map still works.
- Rendering is now behind an interface.
- Later tickets can swap heavy layers to Canvas.
```

## Ticket 5 — Move Heavy Background Layers to Canvas

Prompt:

```text
Move only the heavy non-interactive layers from SVG to Canvas.

Canvas layers:
- roads
- green areas
- general buildings or apartment footprints if currently too heavy

Keep SVG/HTML overlay for:
- district labels
- hover/click interaction
- selected district boundary
- popup/tooltip

Requirements:
- Do not create thousands of SVG paths for background layers.
- Use d3.geoPath().context(canvasContext) if the project uses D3.
- Preserve current projection and zoom behavior.
- Add before/after performance logs.
```

## Ticket 6 — Implement Zoom-Based Layer Visibility

Prompt:

```text
Implement zoom-based layer visibility.

Rules:
- Seoul-wide zoom: district boundaries and district names only.
- District zoom: large green areas and limited apartment price chips.
- Apartment detail zoom: apartment names, prices, popup interaction.

Do not load or render all details at low zoom.
Use constants from src/map/constants.ts.
Make sure labels do not flood the screen.
```

## Ticket 7 — Implement Tile-like Chunk Manager

Prompt:

```text
Implement a tile-like chunk manager.

Goal:
- Do not load all detailed GeoJSON at once.
- Load district or viewport-specific chunks only.
- Add TileCache.
- Add request deduplication.
- Add abortable fetch for outdated requests.
- Add TILE_SPARE-based preloading around the viewport.

If real MVT/PMTiles are not available yet, use district-based GeoJSON chunks as a temporary tile-like structure.
Do not change the visual design beyond loading data more efficiently.
```

## Ticket 8 — Implement Transform-Based Pan/Zoom Behavior

Prompt:

```text
Optimize pan/zoom behavior.

During pan/zoom:
- Do not re-project and re-render all GeoJSON features on every frame.
- Transform the existing rendered layer first.
- Use requestAnimationFrame for lightweight updates.
- After pan/zoom ends or idle state is reached, update required tiles/chunks and re-render.

Add clear event separation:
- pan start
- pan move
- pan end
- zoom start
- zoom move
- zoom end
- idle
```

## Ticket 9 — Add Tile Transition and Tile Duration

Prompt:

```text
Add tile transition behavior.

When new chunks/tiles load:
- Start opacity at 0.
- Fade to 1 over TILE_DURATION_MS.
- Keep old visible data until new data is ready when possible.
- Avoid blank flashes during map movement.

Use TILE_TRANSITION_ENABLED and TILE_DURATION_MS constants.
```

## Ticket 10 — Apartment Location Mapping Layer

Prompt:

```text
Implement the apartment location mapping layer.

Current DB has apartment name and price.
Design the mapping layer so it can support:
1. latitude/longitude from geocoded address
2. polygonId matched to apartment complex footprint
3. temporary district centroid fallback

Do not geocode on the frontend every render.
Create clear types and mapper functions.
Show apartment popup with name and price when clicked.
Limit visible apartment labels by zoom and viewport.
```

## Ticket 11 — Optional MapLibre / WebGL Migration Plan

Prompt:

```text
Do not implement yet. Create a migration plan for MapLibre GL JS + vector tile / PMTiles.

Include:
- what data must become vector tiles
- how layers map to MapLibre sources/layers
- how apartment price data should be connected
- what can remain as HTML overlay
- estimated migration steps
- risks
```

## Practical Rule

One ticket should usually satisfy all of these:

- Can be explained in one or two paragraphs.
- Touches a limited number of files.
- Has a clear before/after.
- Can be tested manually in 5–10 minutes.
- Can be committed separately.
- If it fails, you can revert it without losing the whole project.

## Suggested Git Workflow

Before every ticket:

```bash
git status
git add .
git commit -m "checkpoint before map refactor ticket X"
```

After a successful ticket:

```bash
npm run lint
npm run build
npm run test
git add .
git commit -m "map refactor: ticket X description"
```

If the AI breaks the project:

```bash
git reset --hard HEAD
```

or revert the specific commit.

## How Developers Commonly Work With AI Coding Agents

Common patterns:

1. Use the AI first as an architect, not a coder.
2. Ask for a plan before code when the change touches multiple files.
3. Keep each coding task small and testable.
4. Provide success criteria before implementation.
5. Use version control checkpoints.
6. Ask the AI to explain changed files after each step.
7. Run the app yourself after each step.
8. Start a new chat when the context gets too long.
9. Keep project rules in files like README.md, AGENTS.md, CLAUDE.md, or cursor rules.
10. Treat the AI like a junior developer who is fast but needs clear boundaries.
