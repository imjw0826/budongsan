// Per-complex detail page (/complex/:id) — split out of App.tsx so it can
// be lazy-loaded without dragging maplibre-gl into its bundle chunk.

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type ApartmentListItem = {
  id: string;
  name: string;
  district: string;
  neighborhood: string;
  lat: number;
  lng: number;
  avgPrice: number;
};

type PriceRow = {
  id: string;
  year: string;
  building: string;
  ho?: string | null;
  floor: number;
  area: number;
  price: number;
};

type ApartmentDetail = ApartmentListItem & {
  address: string;
  households: number;
  buildings: number;
  mainArea: string;
  minPrice: number;
  maxPrice: number;
  prices: PriceRow[];
};

function formatPrice(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}억`;
}

function closeDetailWindow() {
  window.close();
  window.setTimeout(() => {
    if (window.closed) return;
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.assign("/");
  }, 120);
}

function PublicPriceDetail({ complex }: { complex: ApartmentDetail }) {
  const [building, setBuilding] = useState("all");
  const [floor, setFloor] = useState("all");
  const [ho, setHo] = useState("all");
  const hasRows = complex.prices.length > 0;
  const hasHo = complex.prices.some((row) => row.ho);
  const buildings = Array.from(new Set(complex.prices.map((row) => row.building)));
  const floors = Array.from(new Set(complex.prices.map((row) => row.floor))).sort((a, b) => a - b);
  const hos = hasHo
    ? Array.from(new Set(complex.prices.map((row) => row.ho).filter(Boolean) as string[])).sort()
    : [];
  const filteredRows = complex.prices.filter((row) => {
    if (building !== "all" && row.building !== building) return false;
    if (floor !== "all" && row.floor !== Number(floor)) return false;
    if (hasHo && ho !== "all" && row.ho !== ho) return false;
    return true;
  });
  const representative = complex.prices[0];
  const sourceLabel = !hasRows ? "상세 가격 없음" : hasHo ? "가격 · 호별" : "실거래가";

  return (
    <main className="detail-page">
      <aside className="detail-window standalone" aria-label={`${complex.name} 가격 상세 정보`}>
        <div className="detail-head">
          <div>
            <p>
              {complex.district} {complex.neighborhood} · {sourceLabel}
            </p>
            <h2>{complex.name}</h2>
          </div>
          <button type="button" onClick={closeDetailWindow} aria-label="상세 창 닫기">
            <X size={18} />
          </button>
        </div>

        <div className="detail-summary">
          <div className="summary-price">
            <span>가격 범위</span>
            <strong>
              {formatPrice(complex.minPrice)} - {formatPrice(complex.maxPrice)}
            </strong>
          </div>
          <dl>
            <div>
              <dt>대표 전용면적</dt>
              <dd>{representative?.area.toFixed(1) ?? "-"}㎡</dd>
            </div>
            <div>
              <dt>표본 동</dt>
              <dd>{representative?.building ?? "-"}</dd>
            </div>
            <div>
              <dt>세대수</dt>
              <dd>{complex.households.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{hasHo ? "수집 호수" : "동수"}</dt>
              <dd>{hasRows ? (hasHo ? complex.prices.length.toLocaleString() : complex.buildings) : "-"}</dd>
            </div>
          </dl>
        </div>

        {hasRows ? (
          <>
            <div className="detail-controls">
              <label>
                동
                <select value={building} onChange={(event) => setBuilding(event.target.value)}>
                  <option value="all">전체</option>
                  {buildings.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              {hasHo && (
                <label>
                  호
                  <select value={ho} onChange={(event) => setHo(event.target.value)}>
                    <option value="all">전체</option>
                    {hos.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                층
                <select value={floor} onChange={(event) => setFloor(event.target.value)}>
                  <option value="all">전체</option>
                  {floors.map((item) => (
                    <option key={item} value={item}>
                      {item}층
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="detail-table-wrap">
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>{hasHo ? "기준일" : "거래월"}</th>
                    <th>동</th>
                    {hasHo && <th>호</th>}
                    <th>층</th>
                    <th>전용면적</th>
                    <th>가격</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.year}</td>
                      <td>{row.building}</td>
                      {hasHo && <td>{row.ho ?? "-"}</td>}
                      <td>{row.floor ? `${row.floor}층` : "-"}</td>
                      <td>{row.area != null ? `${row.area.toFixed(1)}㎡` : "-"}</td>
                      <td>{formatPrice(row.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <section className="detail-empty">
            <strong>동·층별 가격 데이터가 아직 연결되지 않았습니다.</strong>
            <p>지도 요약 가격은 표시할 수 있지만, 이 단지의 상세 행 데이터는 현재 데이터베이스에 없습니다.</p>
          </section>
        )}
      </aside>
    </main>
  );
}

export function DetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ApartmentDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/apartments/${encodeURIComponent(id)}`)
      .then((response) => {
        if (!response.ok) throw new Error("not_found");
        return response.json() as Promise<ApartmentDetail>;
      })
      .then(setDetail)
      .catch(() => setError(true));
  }, [id]);

  if (error) {
    return (
      <main className="detail-page">
        <section className="detail-window standalone">
          <h2>아파트 정보를 찾을 수 없습니다</h2>
        </section>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="detail-page">
        <section className="detail-window standalone">
          <h2>불러오는 중</h2>
        </section>
      </main>
    );
  }

  return <PublicPriceDetail complex={detail} />;
}

export default DetailPage;
