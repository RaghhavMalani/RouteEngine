/**
 * Public entry point for the routing engine.
 *
 * The UI imports everything it needs from here, so it never has to know which
 * concrete algorithm it's using — only that it has *a* `Pathfinder`. When A* and
 * Contraction Hierarchies arrive in later phases they'll be added to this file as
 * additional entries; the UI code won't have to change.
 */
export { Graph } from "./graph";
export { nearestNode } from "./nearest";
export { DijkstraPathfinder } from "./dijkstra";
export { AStarPathfinder } from "./astar";
export type {
  Pathfinder,
  PathResult,
  PathStats,
  ExplorationLog,
  ExploreStep,
  RelaxedEdge,
  Edge,
  GraphJSON,
  LngLat,
} from "./types";

import { DijkstraPathfinder } from "./dijkstra";
import type { Pathfinder } from "./types";

/**
 * The brute-force baseline (Stage 1). A* (Stage 2) is a second implementation of
 * the same `Pathfinder` interface — see stages.ts for the staged sequence.
 */
export const defaultPathfinder: Pathfinder = new DijkstraPathfinder();
