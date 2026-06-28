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
   * DIRECTED: the `oneway` flag is honoured — a one-way street is added only in its
   * legal direction, a two-way street in both. This is what makes routing
   * *drivable* (no wrong-way travel, and divided roads/medians force the real
   * U-turn) instead of just geometrically shortest. (Explicit turn restrictions —
   * "no right turn" relations — are a further step that needs extra OSM data.)
   */
  static fromJSON(data: GraphJSON): Graph {
    const coords: LngLat[] = data.nodes.map(([lng, lat]) => [lng, lat]);
    const adj: Edge[][] = Array.from({ length: coords.length }, () => []);

    for (const [u, v, length, highwayIdx, oneway] of data.edges) {
      const highway = data.meta.highwayTypes[highwayIdx] ?? "unknown";
      const ow = oneway === 1;
      adj[u].push({ to: v, length, highway, oneway: ow });
      if (!ow) adj[v].push({ to: u, length, highway, oneway: ow });
    }

    return new Graph(coords, adj);
  }

  /** Convenience: the [lng, lat] of a node id. */
  position(id: number): LngLat {
    return this.coords[id];
  }
}
