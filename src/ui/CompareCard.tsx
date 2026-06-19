import type { PathStats } from "../engine/pathfinder";

interface CompareCardProps {
  dijkstra: PathStats;
  astar: PathStats;
  onClose: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

/**
 * The payoff card: same route, same distance, far less work.
 *
 * This is the line the demo is built around — it makes the refinement legible by
 * putting Dijkstra and A* side by side on identical numbers, proving A* found the
 * SAME optimal route while exploring a fraction of the nodes.
 */
export default function CompareCard({ dijkstra, astar, onClose }: CompareCardProps) {
  const nodePct = Math.round((astar.nodesExplored / dijkstra.nodesExplored) * 100);
  const saved = 100 - nodePct;
  const sameDistance =
    Math.abs(dijkstra.pathLengthMeters - astar.pathLengthMeters) < 1;

  return (
    <div className="compare-card">
      <button className="compare-close" onClick={onClose} aria-label="close">
        ×
      </button>
      <div className="compare-head">
        <h2>Same route, {saved}% less work</h2>
        <p>
          A* found the {sameDistance ? "identical" : "same-length"} optimal path —{" "}
          {(astar.pathLengthMeters / 1000).toFixed(2)} km — while exploring far fewer
          nodes.
        </p>
      </div>

      <table className="compare-table">
        <thead>
          <tr>
            <th></th>
            <th>Dijkstra</th>
            <th>A*</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Nodes explored</td>
            <td>{fmt(dijkstra.nodesExplored)}</td>
            <td className="win">{fmt(astar.nodesExplored)}</td>
          </tr>
          <tr>
            <td>Edges relaxed</td>
            <td>{fmt(dijkstra.edgesRelaxed)}</td>
            <td className="win">{fmt(astar.edgesRelaxed)}</td>
          </tr>
          <tr>
            <td>Compute time</td>
            <td>{dijkstra.computeTimeMs.toFixed(1)} ms</td>
            <td className="win">{astar.computeTimeMs.toFixed(1)} ms</td>
          </tr>
          <tr>
            <td>Route distance</td>
            <td>{(dijkstra.pathLengthMeters / 1000).toFixed(2)} km</td>
            <td>{(astar.pathLengthMeters / 1000).toFixed(2)} km</td>
          </tr>
        </tbody>
      </table>
      <p className="compare-foot">
        Both are provably optimal — A* just adds a straight-line heuristic to avoid
        exploring in the wrong direction.
      </p>
    </div>
  );
}
