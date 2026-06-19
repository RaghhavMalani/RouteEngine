import { Graph } from "./graph";
import { haversine } from "./geo";

/**
 * Snap an arbitrary clicked [lng, lat] to the nearest graph node.
 *
 * The user clicks somewhere on the map — almost never exactly on a junction — so
 * we need the closest node to use as a routing endpoint.
 *
 * PHASE 0: a linear scan over every node. For Bengaluru (tens of thousands of
 * nodes) this is a fraction of a millisecond and runs only on click, so it's
 * fine. TODO (later phase): replace with a k-d tree (or grid index) to get
 * O(log n) nearest-neighbour queries once we scale to larger regions.
 */
export function nearestNode(graph: Graph, lng: number, lat: number): number {
  let bestId = -1;
  let bestDist = Infinity;
  const target: [number, number] = [lng, lat];

  for (let i = 0; i < graph.nodeCount; i++) {
    const d = haversine(graph.coords[i], target);
    if (d < bestDist) {
      bestDist = d;
      bestId = i;
    }
  }
  return bestId;
}
