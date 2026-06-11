// Map screen — split out of App.tsx so it can be lazy-loaded.

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { booleanPointInPolygon, point } from "@turf/turf";
import { ChevronLeft, ChevronRight, Mail, Search, X } from "lucide-react";
import { LeafletMap } from "./map/leaflet/LeafletMap";
import { mapComplexCollectionToApartments } from "./map/apartmentMapper";
import type { MapViewport } from "./map/viewport";
import { usePanZoomPhaseCounters } from "./map/interactions/usePanZoomPhaseCounters";
import {
  type BoundaryFeature,
  type BoundarySelection,
  centerOf,
} from "./data/boundaries";
import {
  MAX_VISIBLE_APARTMENT_LABELS,
  ZOOM_APARTMENT_DETAIL,
  ZOOM_DETAIL,
  ZOOM_DISTRICT,
  ZOOM_DONG,
  getZoomLayerVisibility,
} from "./map/constants";
import { useMapData } from "./map/data/useMapData";
import { withBase } from "./lib/base";
import { usePerfLogger } from "./map/perf/usePerfLogger";
import type { ApartmentMapItem } from "./map/types";

const SEOUL_CENTER: [number, number] = [37.5532, 126.99];

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.66.5 12.02c0 5.09 3.29 9.4 7.86 10.93.58.11.79-.25.79-.55v-1.93c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.25 3.34.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.71 0-1.26.45-2.3 1.18-3.11-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.19a11 11 0 0 1 2.89-.39c.98 0 1.97.13 2.89.39 2.2-1.5 3.17-1.19 3.17-1.19.62 1.59.23 2.76.11 3.05.74.81 1.18 1.85 1.18 3.11 0 4.44-2.7 5.41-5.27 5.7.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55C20.21 21.41 23.5 17.1 23.5 12.02 23.5 5.66 18.35.5 12 .5z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function complexRankBudget(zoom: number) {
  if (zoom < ZOOM_DISTRICT) return 0;
  if (zoom < 13) return 6;
  if (zoom < ZOOM_DONG) return 10;
  if (zoom < 15) return 14;
  if (zoom < ZOOM_DETAIL) return 20;
  if (zoom < ZOOM_APARTMENT_DETAIL) return 32;
  if (zoom < 17.5) return 55;
  return Math.min(80, MAX_VISIBLE_APARTMENT_LABELS);
}

function pickDistributedApartments(
  items: ApartmentMapItem[],
  viewport: MapViewport,
  zoom: number,
  limit: number,
) {
  if (items.length <= limit) return items;
  const columns = zoom < 15 ? 4 : zoom < ZOOM_DETAIL ? 5 : zoom < ZOOM_APARTMENT_DETAIL ? 7 : 9;
  const rows = zoom < 15 ? 3 : zoom < ZOOM_DETAIL ? 4 : zoom < ZOOM_APARTMENT_DETAIL ? 5 : 7;
  const lngSpan = Math.max(viewport.east - viewport.west, 0.000001);
  const latSpan = Math.max(viewport.north - viewport.south, 0.000001);
  const buckets = new Map<string, ApartmentMapItem[]>();
  for (const item of items) {
    const x = Math.max(0, Math.min(columns - 1, Math.floor(((item.lng - viewport.west) / lngSpan) * columns)));
    const y = Math.max(0, Math.min(rows - 1, Math.floor(((viewport.north - item.lat) / latSpan) * rows)));
    const key = `${x}:${y}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const sortedBuckets = [...buckets.values()]
    .map((bucket) => bucket.sort((a, b) => (b.avgPrice ?? 0) - (a.avgPrice ?? 0)))
    .sort((a, b) => (b[0]?.avgPrice ?? 0) - (a[0]?.avgPrice ?? 0));
  const selected: ApartmentMapItem[] = [];
  while (selected.length < limit && sortedBuckets.some((bucket) => bucket.length > 0)) {
    for (const bucket of sortedBuckets) {
      const next = bucket.shift();
      if (!next) continue;
      selected.push(next);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------
// MapPage
// ---------------------------------------------------------------------------

export function MapPage() {
  const [query, setQuery] = useState("");
  /**
   * Inclusive lower/upper price bounds in 억 units (0..100). The upper handle
   * value 100 is treated as "no upper limit" so 100억+ apartments stay in.
   */
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(100);
  const PRICE_MAX_TOTAL = 100;
  const [zoom, setZoom] = useState(11);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [selectedDistrict, setSelectedDistrict] = useState<BoundaryFeature | null>(null);
  const [selectedDong, setSelectedDong] = useState<BoundaryFeature | null>(null);
  const [flyTarget, setFlyTarget] = useState<{ center: [number, number]; zoom: number } | null>(null);
  const layerVisibility = useMemo(() => getZoomLayerVisibility(zoom), [zoom]);
  const { boundaries, complexes, boundaryError } = useMapData();
  const [hoveredRegionName, setHoveredRegionName] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactMessage, setContactMessage] = useState("");
  const [contactSent, setContactSent] = useState(false);
  const phaseCounters = usePanZoomPhaseCounters();

  const selectedRegion: BoundarySelection | null = useMemo(() => {
    if (selectedDong) {
      return { id: selectedDong.properties.id, name: selectedDong.properties.name, type: "dong" };
    }
    if (selectedDistrict) {
      return { id: selectedDistrict.properties.id, name: selectedDistrict.properties.name, type: "district" };
    }
    return null;
  }, [selectedDistrict, selectedDong]);

  const visibleDongs = useMemo(() => {
    if (!boundaries) return [];
    if (!selectedDistrict) return [];
    return boundaries.dongs.filter(
      (feature) => feature.properties.district === selectedDistrict.properties.name,
    );
  }, [boundaries, selectedDistrict]);

  const districtCenters = useMemo(() => {
    const centers = new Map<string, [number, number]>();
    if (!boundaries) return centers;
    boundaries.districts.forEach((feature) => {
      centers.set(feature.properties.name, centerOf(feature));
    });
    return centers;
  }, [boundaries]);

  const rankedComplexes = useMemo(() => {
    return mapComplexCollectionToApartments(complexes, districtCenters);
  }, [districtCenters, complexes]);

  const apartmentRegion = selectedDong ?? selectedDistrict;

  const apartments = useMemo(() => {
    if (!apartmentRegion || !layerVisibility.showApartmentLabels || !viewport) return [];
    const displayLimit = complexRankBudget(zoom);
    if (displayLimit === 0) return [];
    const lower = query.trim().toLowerCase();
    const candidates: ApartmentMapItem[] = [];
    for (const c of rankedComplexes) {
      if (c.lat < viewport.south || c.lat > viewport.north) continue;
      if (c.lng < viewport.west || c.lng > viewport.east) continue;
      if (!booleanPointInPolygon(point([c.lng, c.lat]), apartmentRegion)) continue;
      if (lower) {
        const hay = `${c.name} ${c.district} ${c.neighborhood}`.toLowerCase();
        if (!hay.includes(lower)) continue;
      }
      const avg = c.avgPrice ?? 0;
      if (avg < priceMin) continue;
      // priceMax === PRICE_MAX_TOTAL acts as "no upper limit" so super-prime
      // complexes (50억+) still render at the top of the slider.
      if (priceMax < PRICE_MAX_TOTAL && avg > priceMax) continue;
      candidates.push({ ...c, avgPrice: avg });
    }
    return pickDistributedApartments(candidates, viewport, zoom, displayLimit);
  }, [apartmentRegion, layerVisibility.showApartmentLabels, rankedComplexes, viewport, zoom, query, priceMin, priceMax]);

  // 검색창 아래 드롭다운: 지역 선택과 무관하게 전체 단지에서 이름·구·동 매칭
  const searchResults = useMemo(() => {
    const lower = query.trim().toLowerCase();
    if (lower.length < 2) return [];
    const hits: ApartmentMapItem[] = [];
    for (const c of rankedComplexes) {
      const hay = `${c.name} ${c.district} ${c.neighborhood}`.toLowerCase();
      if (!hay.includes(lower)) continue;
      hits.push(c);
      if (hits.length >= 8) break;
    }
    return hits;
  }, [query, rankedComplexes]);

  usePerfLogger(() => ({
    zoom,
    markerCount: apartments.length,
    panZoomCounts: phaseCounters.snapshot(),
  }));

  const onDistrictClick = useCallback((feature: BoundaryFeature) => {
    setSelectedDistrict(feature);
    setSelectedDong(null);
    setFlyTarget({ center: feature.properties.center, zoom: ZOOM_DONG });
  }, []);

  const onDongClick = useCallback((feature: BoundaryFeature) => {
    setSelectedDong(feature);
    setFlyTarget({ center: feature.properties.center, zoom: ZOOM_DETAIL - 1 });
  }, []);

  const onBackToDistricts = () => {
    setSelectedDistrict(null);
    setSelectedDong(null);
    setFlyTarget({ center: SEOUL_CENTER, zoom: 11 });
  };

  const onBackToDongs = () => {
    setSelectedDong(null);
    if (selectedDistrict) {
      setFlyTarget({ center: selectedDistrict.properties.center, zoom: ZOOM_DONG });
    }
  };

  return (
    <main className="map-page">
      <section className="map-canvas" aria-label="아파트 가격 지도">
        <LeafletMap
          districts={boundaries?.districts ?? null}
          dongs={visibleDongs}
          selectedDistrictId={selectedDistrict?.properties.id ?? null}
          selectedDongId={selectedDong?.properties.id ?? null}
          apartments={apartments}
          flyTarget={flyTarget}
          onDistrictClick={onDistrictClick}
          onDongClick={onDongClick}
          onRegionHover={setHoveredRegionName}
          onApartmentSelect={(complex) => {
            const detailUrl = withBase(`complex/${encodeURIComponent(complex.id)}`);
            const detailWindow = window.open(detailUrl, "_blank");
            if (!detailWindow) window.location.assign(detailUrl);
          }}
          onViewportChange={(vp) => {
            setViewport(vp);
            phaseCounters.increment("idle");
          }}
          onZoomChange={setZoom}
        />

        <header className="top-bar">
          <a
            href={withBase("")}
            className="brand-title"
            onClick={(event) => {
              event.preventDefault();
              window.location.assign(withBase(""));
            }}
          >
            budongsan <em>in seoul</em>
          </a>
          <div className="search-box">
          <label className={`search-control${query ? " search-control--filled" : ""}`}>
            <Search size={13} className="search-control-icon" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label="단지명, 구, 동 검색"
            />
            {query ? (
              <button
                type="button"
                className="search-control-clear"
                aria-label="검색어 지우기"
                onClick={() => setQuery("")}
              >
                <X size={9} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {searchResults.length > 0 && (
            <ul className="search-results" role="listbox" aria-label="검색된 아파트">
              {searchResults.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const detailUrl = withBase(`complex/${encodeURIComponent(c.id)}`);
                      const detailWindow = window.open(detailUrl, "_blank");
                      if (!detailWindow) window.location.assign(detailUrl);
                    }}
                  >
                    <strong>{c.name}</strong>
                    <span>
                      {c.district} {c.neighborhood}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          </div>
          <div className="price-range" aria-label="가격 필터">
            <div className="price-range-readout">
              <span>가격</span>
              <strong>
                {priceMin}억
                <em>~</em>
                {priceMax >= PRICE_MAX_TOTAL ? `${PRICE_MAX_TOTAL}억+` : `${priceMax}억`}
              </strong>
            </div>
            <div
              className="price-range-track"
              style={
                {
                  "--price-min-pct": `${(priceMin / PRICE_MAX_TOTAL) * 100}%`,
                  "--price-max-pct": `${(priceMax / PRICE_MAX_TOTAL) * 100}%`,
                } as CSSProperties
              }
            >
              <div className="price-range-fill" />
              <input
                className="price-range-input price-range-input-min"
                type="range"
                min={0}
                max={PRICE_MAX_TOTAL}
                step={1}
                value={priceMin}
                aria-label="최저 가격"
                onChange={(event) => {
                  const v = Number(event.target.value);
                  setPriceMin(Math.min(v, priceMax - 1));
                }}
              />
              <input
                className="price-range-input price-range-input-max"
                type="range"
                min={0}
                max={PRICE_MAX_TOTAL}
                step={1}
                value={priceMax}
                aria-label="최고 가격"
                onChange={(event) => {
                  const v = Number(event.target.value);
                  setPriceMax(Math.max(v, priceMin + 1));
                }}
              />
            </div>
          </div>
        </header>

        {(() => {
          // macOS Settings-style navigation header: back / forward chevrons +
          // current location title. Back goes one level up the
          // district → dong drill; forward is reserved for future history.
          const canGoBack = !!selectedDistrict;
          const handleBack = () => {
            if (selectedDong) onBackToDongs();
            else if (selectedDistrict) onBackToDistricts();
          };
          const title = hoveredRegionName
            ?? selectedDong?.properties.name
            ?? selectedDistrict?.properties.name
            ?? "서울특별시";
          return (
            <nav className="nav-bar" aria-label="현재 위치">
              <div className="nav-bar-arrows" role="group" aria-label="이동">
                <button
                  type="button"
                  className="nav-bar-arrow"
                  onClick={handleBack}
                  disabled={!canGoBack}
                  aria-label="뒤로"
                >
                  <ChevronLeft size={16} strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  className="nav-bar-arrow"
                  disabled
                  aria-label="앞으로"
                >
                  <ChevronRight size={16} strokeWidth={2.4} />
                </button>
              </div>
              <strong className="nav-bar-title">{title}</strong>
            </nav>
          );
        })()}

        <div className="region-hint">
          {boundaryError
            ? `행정구역 데이터를 불러오지 못했습니다: ${boundaryError}`
            : !boundaries
              ? "행정구역 정보를 불러오는 중…"
              : !selectedDistrict
                ? "구를 클릭하면 동이 표시됩니다"
                : !selectedDong
                  ? `${selectedDistrict.properties.name}: 동을 선택하면 아파트가 표시됩니다`
                  : `${selectedRegion?.name} 부근 · 화면 내 ${apartments.length}개 단지`}
        </div>

        <aside className="credits-card" aria-label="제작자 정보">
          <a
            href="https://imjw0826.github.io"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="개발자 깃헙"
            className="credits-link"
          >
            <GithubIcon size={16} />
          </a>
          <span className="credits-license">MIT License</span>
          <button
            type="button"
            className="credits-contact"
            onClick={() => {
              setContactOpen(true);
              setContactSent(false);
            }}
            aria-label="개발자에게 문의"
          >
            <Mail size={14} />
            문의하기
          </button>
        </aside>

        {contactOpen && (
          <div
            className="contact-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="개발자에게 문의"
            onClick={() => setContactOpen(false)}
          >
            <form
              className="contact-modal"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                setContactSent(true);
              }}
            >
              <header>
                <h3>개발자에게 문의</h3>
                <button type="button" onClick={() => setContactOpen(false)} aria-label="닫기">
                  <X size={18} />
                </button>
              </header>
              {contactSent ? (
                <p className="contact-pending">
                  접수 기능은 곧 추가됩니다. 그동안은{" "}
                  <a href="https://imjw0826.github.io" target="_blank" rel="noopener noreferrer">
                    imjw0826.github.io
                  </a>{" "}
                  로 직접 연락 부탁드립니다.
                </p>
              ) : (
                <>
                  <label>
                    문의 내용
                    <textarea
                      value={contactMessage}
                      onChange={(event) => setContactMessage(event.target.value)}
                      rows={5}
                      placeholder="버그 제보, 기능 요청 등 자유롭게 적어주세요"
                    />
                  </label>
                  <div className="contact-actions">
                    <button type="button" onClick={() => setContactOpen(false)}>
                      취소
                    </button>
                    <button type="submit" className="primary">
                      보내기
                    </button>
                  </div>
                </>
              )}
            </form>
          </div>
        )}
      </section>
    </main>
  );
}

export default MapPage;
