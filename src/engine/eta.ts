import type { Graph } from "./graph";

/**
 * Travel-time estimate for the displayed route (Stage 4), with a MODELLED traffic
 * condition.
 *
 * Each OSM highway class has a typical free-flow speed (km/h). On top of that we
 * apply a congestion factor that depends on the selected condition and whether the
 * road is a major artery (arteries clog far worse at peak than quiet residential
 * streets). The ETA is the sum of each segment's length / its adjusted speed.
 *
 * HONEST FRAMING: this is a *model*, not a live feed. "Peak / rush hour" multiplies
 * arterial speeds down to ~40% of free-flow, etc. — realistic shapes, not measured
 * data. Wiring a real provider (TomTom/Mapbox) would replace `speedFactor` with
 * live/historical per-edge speeds; the rest of the summation is unchanged. The
 * route is still distance-optimal (from CH), not time-optimal.
 */

export type TrafficCondition = "free" | "light" | "moderate" | "heavy";

export const CONDITION_LABEL: Record<TrafficCondition, string> = {
  free: "Free-flow",
  light: "Light traffic",
  moderate: "Moderate traffic",
  heavy: "Peak / rush hour",
};

/** Short chip label. */
export const CONDITION_SHORT: Record<TrafficCondition, string> = {
  free: "Free-flow",
  light: "Light",
  moderate: "Moderate",
  heavy: "Peak",
};

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

const CLASS_LABEL: Record<string, string> = {
  motorway: "the motorway",
  trunk: "trunk roads",
  primary: "primary roads",
  secondary: "secondary roads",
  tertiary: "tertiary roads",
  unclassified: "local roads",
  residential: "residential streets",
};

/** Fraction of free-flow speed retained, by condition × road type. */
const CONGESTION: Record<TrafficCondition, { art: number; loc: number }> = {
  free: { art: 1.0, loc: 1.0 },
  light: { art: 0.85, loc: 0.95 },
  moderate: { art: 0.6, loc: 0.8 },
  heavy: { art: 0.42, loc: 0.62 },
};

function isArterial(base: string): boolean {
  return (
    base === "motorway" || base === "trunk" || base === "primary" || base === "secondary"
  );
}

/**
 * Effective speed (km/h) of one road segment under a condition — free-flow speed
 * for its class × the congestion factor. This is the weight basis for *time*-
 * optimal routing (length / speed = seconds), as opposed to distance-optimal.
 */
export function segmentSpeedKmh(highway: string, condition: TrafficCondition): number {
  const base = highway.replace(/_link$/, "");
  const free = FREE_FLOW_KMH[highway] ?? DEFAULT_KMH;
  const cong = CONGESTION[condition];
  return free * (isArterial(base) ? cong.art : cong.loc);
}

/** Fastest plausible road speed (km/h) — used as an admissible time heuristic. */
export const MAX_KMH = 85;

/** Pick a plausible current condition from the local clock. */
export function conditionNow(d: Date = new Date()): TrafficCondition {
  const h = d.getHours();
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return "heavy"; // morning / evening peaks
  if (h >= 11 && h < 17) return "moderate"; // daytime
  if (h >= 21 || h < 6) return "free"; // night
  return "light"; // early-morning / shoulder
}

export interface RouteEstimate {
  distanceKm: number;
  minutes: number;
  via: string;
  condition: TrafficCondition;
  freeMinutes: number; // free-flow time, for an "X min added by traffic" comparison
}

/**
 * Walk the route's consecutive node pairs, look each segment's class + length up
 * in the graph, and accumulate distance + travel time under the given condition.
 */
export function estimateRoute(
  graph: Graph,
  path: number[],
  condition: TrafficCondition = "free",
): RouteEstimate {
  const cong = CONGESTION[condition];
  let meters = 0;
  let seconds = 0;
  let freeSeconds = 0;
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
    const base = hw.replace(/_link$/, "");
    const freeKmh = FREE_FLOW_KMH[hw] ?? DEFAULT_KMH;
    const factor = isArterial(base) ? cong.art : cong.loc;
    const kmh = freeKmh * factor;

    meters += len;
    seconds += len / ((kmh * 1000) / 3600);
    freeSeconds += len / ((freeKmh * 1000) / 3600);
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
    freeMinutes: freeSeconds / 60,
    via: CLASS_LABEL[topClass] ?? "local roads",
    condition,
  };
}
