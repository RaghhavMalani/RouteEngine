/**
 * Shared types for the routing engine.
 *
 * These types are deliberately framework-agnostic: nothing here imports React,
 * deck.gl, or MapLibre. The engine is pure TypeScript so it can be unit-tested
 * in plain Node and, later, ported to Rust/WASM without touching the UI.
 */

/** A node's geographic position, stored as [longitude, latitude] (GeoJSON order). */
export type LngLat = [number, number];

/**
 * The on-disk format produced by `scripts/build-graph.ts` and shipped in
 * /public/bengaluru-graph.json. It is intentionally compact (arrays of numbers,
 * not objects) so the file stays small and parses fast in the browser.
 *
 *  - nodes[i]            -> [lng, lat] for internal node id `i`
 *  - edges[k]           -> [u, v, lengthMeters, highwayTypeIndex, oneway]
 *  - meta.highwayTypes  -> lookup table that turns highwayTypeIndex back into a
 *                          string (e.g. "primary"), so we don't repeat strings.
 */
export interface GraphJSON {
  meta: {
    bbox: [number, number, number, number]; // [south, west, north, east]
    generated: string; // ISO timestamp
    nodeCount: number;
    edgeCount: number;
    highwayTypes: string[];
  };
  nodes: number[][];
  edges: [number, number, number, number, number][];
}

/** One directed entry in a node's adjacency list. */
export interface Edge {
  /** Destination node id. */
  to: number;
  /** Edge weight in meters (haversine length of the road segment). */
  length: number;
  /** OSM highway class (e.g. "primary"). Kept for later phases (speed limits). */
  highway: string;
  /**
   * Whether the original OSM way was one-way. PHASE 0 IGNORES THIS — we add both
   * directions to the adjacency list and route as if every road is bidirectional.
   * The flag is preserved so a later phase can honour it without rebuilding data.
   */
  oneway: boolean;
}

/**
 * One step of the search, captured for animation.
 *
 * The whole point of recording this is the separation of concerns: Dijkstra runs
 * once, to completion, and writes down what it did. The UI then "replays" that
 * recording at any speed. We never re-run the algorithm just to animate.
 *
 * One step = the moment a single node is settled (popped from the priority queue
 * with its final shortest distance), together with the edges that were relaxed
 * (i.e. improved a neighbour's tentative distance) from that node.
 */
export interface RelaxedEdge {
  /** Source node (the node being settled this step). */
  from: number;
  /** Neighbour whose tentative distance just improved. */
  to: number;
  /**
   * The tentative cost-from-source of `to` at the moment of relaxation
   * (= g(from) + edge length). The 3D view uses this as the edge's far-end
   * HEIGHT, so the frontier literally rises with cost.
   */
  toCost: number;
}

export interface ExploreStep {
  /** The node settled at this step. */
  node: number;
  /**
   * g(node) — the final shortest cost-from-source of the settled node. This is
   * the height signal for the 3D cost surface. (Recording it is a presentation
   * concern; the algorithm already computes it as dist[u], so adding it here
   * does not change how Dijkstra works.)
   */
  cost: number;
  /** Edges relaxed from `node` this step, used to draw the expanding frontier. */
  edges: RelaxedEdge[];
}

/** The full, ordered recording of a search — replayed by the UI frame by frame. */
export type ExplorationLog = ExploreStep[];

/** Headline numbers shown in the live metrics readout. */
export interface PathStats {
  /** Nodes popped from the priority queue (the "work" Dijkstra did). */
  nodesExplored: number;
  /** Edge relaxations that improved a tentative distance. */
  edgesRelaxed: number;
  /** Length of the shortest path in meters (0 if no path was found). */
  pathLengthMeters: number;
  /** Wall-clock time spent inside findPath(), in milliseconds. */
  computeTimeMs: number;
}

/** What every pathfinder returns. */
export interface PathResult {
  /** Ordered node ids from source to target. Empty array if unreachable. */
  path: number[];
  /** The replayable exploration recording. */
  log: ExplorationLog;
  /** Performance + result metrics. */
  stats: PathStats;
}

/**
 * The strategy interface every algorithm implements.
 *
 * Phase 0 ships DijkstraPathfinder. Because A*, Contraction Hierarchies, etc.
 * will be *new implementations of this same interface*, the entire UI can stay
 * unchanged when we add them — it just receives a different Pathfinder.
 */
export interface Pathfinder {
  /** Human-readable name, shown in the UI (e.g. "Dijkstra"). */
  readonly name: string;
  findPath(graph: import("./graph").Graph, sourceId: number, targetId: number): PathResult;
}
