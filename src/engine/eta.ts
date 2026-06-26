import type { Graph } from "./graph";

/**
 * Free-flow travel-time estimate for the displayed route (Stage 4).
 *
 * Each OSM highway class gets a typical free-flow speed (km/h); the ETA is the
 * sum of each segment's length / its class speed. This is intentionally simple
 * and honest: it is FREE-FLOW time (empty roads), not traffic-aware, and the
 * route itself is distance-optimal (from CH), not yet time-optimal.
 *
 * NOTE (next phase): this per-class speed table is exactly the hook for the
 * upcoming traffic arc — swap these constants for live/historical speeds per
 * edge and the same summation becomes a traffic-aware ETA, and feeding the
 * speeds back as edge weights makes the route time-optimal.
 */
const FREE_FLOW_KMH: Record<string, number> = {
  motorway: 85,
  motorway_link: 45,
  trunk: 60,
  trunk_link: 40,
  primary: 45,
  primary_link: 35,
  secondary: 38,
  secondary_link: 30,
  tertiary: 30,
  tertiary_link: 25,
  unclassified: 25,
  residential: 20,
};
const DEFAULT_KMH = 25;

/** Human label for the dominant road class on the route ("via …"). */
const CLASS_LABEL: Record<string, string> = {
  motorway: "the motorway",
  trunk: "trunk roads",
  primary: "primary roads",
  secondary: "secondary roads",
  tertiary: "tertiary roads",
  unclassified: "local roads",
  residential: "residential streets",
};

export interface RouteEstimate {
  distanceKm: number;
  minutes: number;
  via: string;
}

/**
 * Walk the route's consecutive node pairs, looking each segment's class + length
 * up in the graph, and accumulate distance, free-flow time, and per-class length
 * (to pick the dominant "via" road).
 */
export function estimateRoute(graph: Graph, path: number[]): RouteEstimate {
  let meters = 0;
  let seconds = 0;
  const byClass = new Map<string, number>();

  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    let len = 0;
    let hw = "unknown";
    for (const e of graph.adj[a]) {
      if (e.to === b) {
        len = e.length;
        hw = e.highway;
        break;
      }
    }
    const kmh = FREE_FLOW_KMH[hw] ?? DEFAULT_KMH;
    meters += len;
    seconds += len / ((kmh * 1000) / 3600);
    // collapse *_link into the parent class for the "via" tally
    const base = hw.replace(/_link$/, "");
    byClass.set(base, (byClass.get(base) ?? 0) + len);
  }

  let topClass = "unclassified";
  let topLen = -1;
  for (const [cls, l] of byClass) {
    if (l > topLen) {
      topLen = l;
      topClass = cls;
    }
  }

  return {
    distanceKm: meters / 1000,
    minutes: seconds / 60,
    via: CLASS_LABEL[topClass] ?? "local roads",
  };
}
