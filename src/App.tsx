// App-level router. Both pages are lazy-imported so:
//   - DetailPage (/complex/:id) loads ~100 KB without the map runtime
//   - MapPage (/) loads the leaflet chunk only when the map is needed
//
// Vite's automatic code-splitting on dynamic import() puts each into its
// own chunk; the explicit vendor-chunk strategy lives in vite.config.ts.

import { lazy, Suspense } from "react";
import { BASE } from "./lib/base";

const MapPage = lazy(() => import("./MapPage"));
const DetailPage = lazy(() => import("./DetailPage"));

function PageFallback() {
  return (
    <main className="map-page" aria-busy="true">
      <section className="map-canvas">
        <div className="region-hint">불러오는 중…</div>
      </section>
    </main>
  );
}

export function App() {
  // GitHub Pages 프로젝트 사이트(/budongsan/complex/:id)와 로컬(/complex/:id)
  // 모두에서 매칭되도록 base 를 떼고 라우팅한다.
  const route = window.location.pathname.startsWith(BASE)
    ? window.location.pathname.slice(BASE.length)
    : window.location.pathname.replace(/^\//, "");
  const detailMatch = route.match(/^complex\/([^/]+)\/?$/);

  return (
    <Suspense fallback={<PageFallback />}>
      {detailMatch ? (
        <DetailPage id={decodeURIComponent(detailMatch[1])} />
      ) : (
        <MapPage />
      )}
    </Suspense>
  );
}
