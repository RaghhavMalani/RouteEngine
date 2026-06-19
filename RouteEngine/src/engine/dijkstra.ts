import { Graph } from "./graph";
import { MinHeap } from "./heap";
import type {
  ExplorationLog,
  ExploreStep,
  PathResult,
  Pathfinder,
} from "./types";

/**
 * Dijkstra's shortest-path algorithm.
 *
 * THE IDEA IN ONE SENTENCE: grow a set of nodes whose shortest distance from the
 * source is known for certain, always expanding next from the closest unfinished
 * node — because once that closest node is reached, no later, longer route could
 * ever beat it (this is what requires non-negative weights, which road lengths
 * always are).
 *
 * WHY THIS SHAPE OF CODE: the algorithm is written to produce a replayable
 * `ExplorationLog` as a first-class output, not as a debugging afterthought. The
 * UI animates by stepping through that log; it never calls this function again to
 * draw frames. That separation (compute once, render many times) is the core
 * architectural decision of Phase 0.
 */
export class DijkstraPathfinder implements Pathfinder {
  readonly name = "Dijkstra";

  findPath(graph: Graph, sourceId: number, targetId: number): PathResult {
    const start = performance.now();
    const n = graph.nodeCount;

    // dist[v]   = best known distance from source to v (Infinity = unknown).
    // prev[v]   = the node we arrived from on that best path (-1 = none), used
    //             to reconstruct the route by walking backwards from the target.
    // settled[v]= true once v has been popped with its final distance.
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const settled = new Uint8Array(n); // 0 / 1

    const log: ExplorationLog = [];
    let edgesRelaxed = 0;

    dist[sourceId] = 0;
    const pq = new MinHeap<number>();
    pq.push(sourceId, 0);

    while (!pq.isEmpty()) {
      const { value: u, priority: d } = pq.pop()!;

      // Lazy-deletion guard: skip stale heap entries (see heap.ts). If we've
      // already settled u, or this entry's distance is worse than the best we
      // now know, it's a leftover — ignore it.
      if (settled[u]) continue;
      if (d > dist[u]) continue;

      settled[u] = 1;

      // Record this settle step together with the edges it relaxes, so the UI
      // can light up the frontier exactly as it expanded. `cost` is g(u), the
      // node's final cost-from-source, used as its 3D height.
      const step: ExploreStep = { node: u, cost: dist[u], edges: [] };

      // Early exit: the moment we settle the target, its distance is final and
      // no further exploration can improve the answer. Stopping here is a big
      // real-world speed-up versus exploring the whole reachable graph.
      if (u === targetId) {
        log.push(step);
        break;
      }

      for (const edge of graph.adj[u]) {
        const v = edge.to;
        if (settled[v]) continue; // its distance is already final
        const candidate = dist[u] + edge.length;
        if (candidate < dist[v]) {
          // Relaxation: we found a shorter way to reach v.
          dist[v] = candidate;
          prev[v] = u;
          edgesRelaxed++;
          step.edges.push({ from: u, to: v, toCost: candidate });
          // Lazy decrease-key: push a fresh, better entry rather than mutating.
          pq.push(v, candidate);
        }
      }

      log.push(step);
    }

    const computeTimeMs = performance.now() - start;
    const path = reconstructPath(prev, sourceId, targetId);
    const pathLengthMeters = path.length > 0 ? dist[targetId] : 0;

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

/**
 * Walk the `prev` chain backwards from target to source, then reverse it.
 * Returns [] if the target was never reached (disconnected / unreachable).
 */
function reconstructPath(
  prev: Int32Array,
  sourceId: number,
  targetId: number,
): number[] {
  if (sourceId === targetId) return [sourceId];
  if (prev[targetId] === -1) return []; // target never reached

  const path: number[] = [];
  let at = targetId;
  while (at !== -1) {
    path.push(at);
    if (at === sourceId) break;
    at = prev[at];
  }
  // If we walked off the chain without hitting the source, there is no path.
  if (path[path.length - 1] !== sourceId) return [];
  path.reverse();
  return path;
}
