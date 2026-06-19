/** Geographic helpers shared by the engine and the build-graph pipeline. */

const EARTH_RADIUS_M = 6_371_008.8; // mean Earth radius (meters)

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two [lng, lat] points, in meters.
 *
 * We use the haversine formula because over city distances the Earth's curvature
 * matters enough that naive planar distance on raw lng/lat degrees would be wrong
 * (a degree of longitude in Bengaluru is shorter than a degree of latitude). This
 * is the weight we put on every road segment in Phase 0: pure physical length.
 */
export function haversine(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const lat1r = toRad(lat1);
  const lat2r = toRad(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
