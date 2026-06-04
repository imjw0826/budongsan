// Lightweight performance logger for the map renderer.
//
// Dev-only and opt-in. Add `?perf=1` to the URL or set
// `localStorage.mapPerf = "1"` to dump a `console.table` row every
// `intervalMs` summarizing:
//   * current zoom (10..18 leaflet-equivalent)
//   * count of HTML apartment-price markers
//   * FPS estimate (EWMA over recent rAF frames)
//   * last long-task duration in ms (PerformanceObserver) — captures jank
//   * pan/zoom phase counts
//
// Visual output is unchanged. In production builds, `import.meta.env.DEV`
// is statically `false` so Vite/Rollup tree-shakes the entire effect away.

import { useEffect, useRef } from "react";

export type PerfSample = {
  zoom: number;
  markerCount?: number;
  panZoomCounts?: Record<
    | "panStart"
    | "panMove"
    | "panEnd"
    | "zoomStart"
    | "zoomMove"
    | "zoomEnd"
    | "idle",
    number
  >;
};

type Sampler = () => PerfSample;

const MAP_HOST = ".map-libre-stage";
const MARKER_SELECTOR = ".price-marker";

export function usePerfLogger(sampler: Sampler, intervalMs = 2000): void {
  const samplerRef = useRef(sampler);
  samplerRef.current = sampler;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    const enabled = params.get("perf") === "1" || window.localStorage.getItem("mapPerf") === "1";
    if (!enabled) return;

    // rAF FPS tracker (EWMA).
    let lastTick = performance.now();
    let fpsEwma = 60;
    let rafId = requestAnimationFrame(function tick(now) {
      const dt = now - lastTick;
      if (dt > 0 && dt < 250) {
        const instant = 1000 / dt;
        fpsEwma = fpsEwma * 0.9 + instant * 0.1;
      }
      lastTick = now;
      rafId = requestAnimationFrame(tick);
    });

    // Long-task observer — proxy for "render time" / jank.
    let lastLongTaskMs = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "longtask") {
            lastLongTaskMs = Math.round(entry.duration);
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask not supported (Safari < 16) — silently skip.
    }

    const intervalId = window.setInterval(() => {
      const host = document.querySelector(MAP_HOST);
      if (!host) return;
      const provided = samplerRef.current();
      const markers = document.querySelectorAll(MARKER_SELECTOR).length;
      const pzc = provided.panZoomCounts;
       
      console.table([
        {
          zoom: Number(provided.zoom.toFixed(2)),
          markersDom: markers,
          markersProp: provided.markerCount ?? "-",
          fps: Math.round(fpsEwma),
          lastLongTaskMs,
          panStarts: pzc?.panStart ?? "-",
          panMoves: pzc?.panMove ?? "-",
          panEnds: pzc?.panEnd ?? "-",
          zoomStarts: pzc?.zoomStart ?? "-",
          zoomMoves: pzc?.zoomMove ?? "-",
          zoomEnds: pzc?.zoomEnd ?? "-",
          idles: pzc?.idle ?? "-",
        },
      ]);
    }, intervalMs);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      observer?.disconnect();
    };
  }, [intervalMs]);
}
