import type { Edge, GraphJSON, LngLat } from "./types";

/**
 * The road network as an adjacency list.
 *
 * Why an adjacency list (and not a matrix)? Road networks are extremely sparse —
 * a junction connects to a handful of roads, not to thousands. An adjacency list
 * stores O(V + E) instead of O(V^2), which for Bengaluru is the difference
 * between a few megabytes and many gigabytes.
 */
export class Graph {
  /** coords[i] = [lng, lat] of node i. Parallel array, indexed by node id. */
  readonly coords: LngLat[];
  /** adj[i] = outgoing edges from node i. */
  readonly adj: Edge[][];

  constructor(coords: LngLat[], adj: Edge[][]) {
    this.coords = coords;
    this.adj = adj;
  }

  get nodeCount(): number {
    return this.coords.length;
  }

  /**
   * Rehydrate a Graph from the compact JSON shipped in /public.
   *
   * PHASE 0 SIMPLIFICATION: every edge is added in BOTH directions, regardless of
   * its `oneway` flag, so the graph is effectively undirected. This keeps Phase 0
   * about the algorithm rather than turn restrictions; the oneway flag is still
   * stored on each Edge so a later phase can switch to a true directed graph.
   */
  static fromJSON(data: GraphJSON): Graph {
    const coords: LngLat[] = data.nodes.map(([lng, lat]) => [lng, lat]);
    const adj: Edge[][] = Array.from({ length: coords.length }, () => []);

    for (const [u, v, length, highwayIdx, oneway] of data.edges) {
      const highway = data.meta.highwayTypes[highwayIdx] ?? "unknown";
      const ow = oneway === 1;
      // Forward and reverse — see the simplification note above.
      adj[u].push({ to: v, length, highway, oneway: ow });
      adj[v].push({ to: u, length, highway, oneway: ow });
    }

    return new Graph(coords, adj);
  }

  /** Convenience: the [lng, lat] of a node id. */
  position(id: number): LngLat {
    return this.coords[id];
  }
}
