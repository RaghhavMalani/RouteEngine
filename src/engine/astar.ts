import { Graph } from "./graph";
import { MinHeap } from "./heap";
import { haversine } from "./geo";
import type { ExplorationLog, ExploreStep, PathResult, Pathfinder } from "./types";

/**
 * A* shortest-path search.
 *
 * A* is Dijkstra with a sense of direction. Dijkstra expands the node with the
 * smallest cost-so-far g(n); A* expands the node with the smallest *estimated
 * total* f(n) = g(n) + h(n), where h(n) is a guess of the remaining distance to
 * the goal. That pull toward the goal is why A* explores a narrow beam instead of
 * a full circular flood — far fewer nodes for the same answer.
 *
 * THE HEURISTIC: h(n) = haversine straight-line distance from n to the
 * destination. This is **admissible** (it never overestimates) because a
 * straight line is the shortest possible distance between two points, so it can
 * only be ≤ the real road distance. Admissibility guarantees A* still returns the
 * provably *optimal* path — identical to Dijkstra's. The heuristic is also
 * **consistent** (h(n) ≤ edge(n,m) + h(m), by the triangle inequality and the
 * fact that an edge's length ≥ the straight line across it), so a node never
 * needs to be re-expanded once settled — the same clean settled-set loop as
 * Dijkstra works correctly.
 *
 * Same `Pathfinder` interface, same exploration-log + stats shape as Dijkstra, so
 * the entire animation/UI pipeline is reused unchanged.
 */
export class AStarPathfinder implements Pathfinder {
  readonly name = "A*";

  findPath(graph: Graph, sourceId: number, targetId: number): PathResult {
    const start = performance.now();
    const n = graph.nodeCount;

    // g[v] = best known cost-from-source (this is what we elevate in 3D, exactly
    // like Dijkstra — so the two stages are visually comparable).
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const settled = new Uint8Array(n);

    const goal = graph.coords[targetId];
    // Admissible, consistent heuristic: straight-line distance to the goal.
    const h = (id: number): number => haversine(graph.coords[id], goal);

    const log: ExplorationLog = [];
    let edgesRelaxed = 0;

    g[sourceId] = 0;
    const pq = new MinHeap<number>();
    pq.push(sourceId, h(sourceId)); // priority f = g + h, and g(source) = 0

    while (!pq.isEmpty()) {
      const { value: u } = pq.pop()!;

      // With a consistent heuristic, the first time we pop a node its g is final,
      // so a simple settled-set guard is enough to skip stale duplicate entries.
      if (settled[u]) continue;
      settled[u] = 1;

      // Record the settle step. `cost` is g(u) — the true cost-from-source, NOT
      // f — so heights stay directly comparable to Dijkstra's cost surface.
      const step: ExploreStep = { node: u, cost: g[u], edges: [] };

      if (u === targetId) {
        log.push(step);
        break; // goal settled ⇒ its cost is final; stop.
      }

      for (const edge of graph.adj[u]) {
        const v = edge.to;
        if (settled[v]) continue;
        const candidate = g[u] + edge.length;
        if (candidate < g[v]) {
          g[v] = candidate;
          prev[v] = u;
          edgesRelaxed++;
          step.edges.push({ from: u, to: v, toCost: candidate });
          // The ONLY difference from Dijkstra: priority is f = g + h, not just g.
          pq.push(v, candidate + h(v));
        }
      }

      log.push(step);
    }

    const computeTimeMs = performance.now() - start;
    const path = reconstructPath(prev, sourceId, targetId);
    const pathLengthMeters = path.length > 0 ? g[targetId] : 0;

    return {
      path,
      log,
      stats: {
        nodesExplored: log.length,
        edgesRelaxed,
        pathLengthMeters,
        computeTimeMs,
      },
    };
  }
}

/** Identical reconstruction to Dijkstra: walk `prev` back from target, reverse. */
function reconstructPath(
  prev: Int32Array,
  sourceId: number,
  targetId: number,
): number[] {
  if (sourceId === targetId) return [sourceId];
  if (prev[targetId] === -1) return [];

  const path: number[] = [];
  let at = targetId;
  while (at !== -1) {
    path.push(at);
    if (at === sourceId) break;
    at = prev[at];
  }
  if (path[path.length - 1] !== sourceId) return [];
  path.reverse();
  return path;
}
