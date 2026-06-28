import { Graph } from "./graph";
import { MinHeap } from "./heap";
import { haversine } from "./geo";
import { segmentSpeedKmh, MAX_KMH, type TrafficCondition } from "./eta";

/**
 * Time-optimal routing — A* minimising TRAVEL TIME instead of distance.
 *
 * Same directed graph and same A* machinery as Stage 2, but each edge's weight is
 * `length / speed(class, condition)` (seconds), not metres. The straight-line time
 * heuristic `haversine / MAX_KMH` never overestimates (nothing is faster than the
 * top free-flow speed), so the result is the provably fastest route — which, at
 * peak, deliberately avoids clogged arterials and differs from the shortest one.
 *
 * Run live per query (a single directed A* is a few ms–tens of ms on this graph);
 * no separate precomputation needed.
 */

export interface FastestResult {
  path: number[];
  seconds: number;
  meters: number;
}

const mPerS = (kmh: number) => (kmh * 1000) / 3600;

export function fastestRoute(
  graph: Graph,
  source: number,
  target: number,
  condition: TrafficCondition,
): FastestResult {
  const n = graph.nodeCount;
  const g = new Float64Array(n).fill(Infinity); // best time-from-source (seconds)
  const prev = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const goal = graph.coords[target];
  // admissible time heuristic: straight-line distance ÷ top speed
  const h = (id: number): number => haversine(graph.coords[id], goal) / mPerS(MAX_KMH);

  g[source] = 0;
  const pq = new MinHeap<number>();
  pq.push(source, h(source));

  while (!pq.isEmpty()) {
    const { value: u } = pq.pop()!;
    if (settled[u]) continue;
    settled[u] = 1;
    if (u === target) break;
    for (const e of graph.adj[u]) {
      const v = e.to;
      if (settled[v]) continue;
      const seconds = e.length / mPerS(segmentSpeedKmh(e.highway, condition));
      const cand = g[u] + seconds;
      if (cand < g[v]) {
        g[v] = cand;
        prev[v] = u;
        pq.push(v, cand + h(v));
      }
    }
  }

  if (prev[target] === -1 && source !== target) return { path: [], seconds: 0, meters: 0 };
  const path: number[] = [];
  let at = target;
  while (at !== -1) {
    path.push(at);
    if (at === source) break;
    at = prev[at];
  }
  if (path[path.length - 1] !== source) return { path: [], seconds: 0, meters: 0 };
  path.reverse();

  let meters = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    for (const e of graph.adj[path[i]]) {
      if (e.to === path[i + 1]) {
        meters += e.length;
        break;
      }
    }
  }
  return { path, seconds: g[target], meters };
}
