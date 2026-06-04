// Shared viewport rectangle type. Lives outside the (deprecated) bounds.ts
// because it's the only piece of that file we still need post-MapLibre.

export type MapViewport = {
  north: number;
  south: number;
  east: number;
  west: number;
};
