// Dev-only counter that tracks how often each pan/zoom phase fires.
// Exposed via a ref so perfLogger can read the snapshot every frame
// without forcing a re-render.

import { useRef } from "react";
import type { PanZoomPhase } from "../types";

export type PanZoomPhaseCounts = Record<PanZoomPhase, number>;

const ZERO: PanZoomPhaseCounts = {
  panStart: 0,
  panMove: 0,
  panEnd: 0,
  zoomStart: 0,
  zoomMove: 0,
  zoomEnd: 0,
  idle: 0,
};

export function usePanZoomPhaseCounters() {
  const ref = useRef<PanZoomPhaseCounts>({ ...ZERO });
  return {
    /** Mutable counts; read in render via `{ ...counts }` snapshot. */
    counts: ref,
    increment(phase: PanZoomPhase) {
      ref.current[phase] += 1;
    },
    snapshot(): PanZoomPhaseCounts {
      return { ...ref.current };
    },
  };
}
