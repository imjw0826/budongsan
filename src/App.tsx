// App-level router. Both pages are lazy-imported so:
//   - DetailPage (/complex/:id) loads ~100 KB without maplibre-gl
//   - MapPage (/) loads the maplibre chunk only when the map is needed
//
// Vite's automatic code-splitting on dynamic import() puts each into its
// own chunk; the explicit vendor-chunk strategy lives in vite.config.ts.

import { lazy, Suspense } from "react";

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
  const detailMatch = window.location.pathname.match(/^\/complex\/([^/]+)$/);

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
