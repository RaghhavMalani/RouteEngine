import type { PathStats } from "../engine/pathfinder";

interface CompareCardProps {
  dijkstra: PathStats;
  astar: PathStats;
  ch?: PathStats | null;
  onClose: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const km = (m: number) => (m / 1000).toFixed(2);

/**
 * The payoff card. Two columns (Dijkstra vs A*) after Stage 2, three (… vs CH)
 * after Stage 3. The "win" highlight is computed per row — whichever method
 * actually did the least work is bolded — so it's always truthful (on short
 * routes A* can beat CH; on long cross-city routes CH dominates).
 */
export default function CompareCard({ dijkstra, astar, ch, onClose }: CompareCardProps) {
  const cols = ch
    ? [
        { name: "Dijkstra", s: dijkstra },
        { name: "A*", s: astar },
        { name: "CH", s: ch },
      ]
    : [
        { name: "Dijkstra", s: dijkstra },
        { name: "A*", s: astar },
      ];

  const minNodes = Math.min(...cols.map((c) => c.s.nodesExplored));
  const minEdges = Math.min(...cols.map((c) => c.s.edgesRelaxed));
  const minTime = Math.min(...cols.map((c) => c.s.computeTimeMs));

  // Headline references the method that actually explored the fewest nodes.
  const winner = cols.reduce((a, b) => (b.s.nodesExplored < a.s.nodesExplored ? b : a));
  const pct = Math.round((winner.s.nodesExplored / dijkstra.nodesExplored) * 100);
  const saved = 100 - pct;
  const sameDistance = cols.every(
    (c) => Math.abs(c.s.pathLengthMeters - dijkstra.pathLengthMeters) < 1,
  );
  const winnerName = winner.name === "CH" ? "Contraction Hierarchies" : winner.name;

  return (
    <div className="compare-card">
      <button className="compare-close" onClick={onClose} aria-label="close">
        ×
      </button>
      <div className="compare-head">
        <h2>Same route, {saved}% less work</h2>
        <p>
          {winnerName} found the {sameDistance ? "identical" : "same-length"} optimal
          path — {km(winner.s.pathLengthMeters)} km — while exploring{" "}
          {pct < 1 ? "<1" : pct}% of Dijkstra's nodes.
        </p>
      </div>

      <table className="compare-table">
        <thead>
          <tr>
            <th></th>
            {cols.map((c) => (
              <th key={c.name}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Nodes explored</td>
            {cols.map((c) => (
              <td key={c.name} className={c.s.nodesExplored === minNodes ? "win" : ""}>
                {fmt(c.s.nodesExplored)}
              </td>
            ))}
          </tr>
          <tr>
            <td>Edges relaxed</td>
            {cols.map((c) => (
              <td key={c.name} className={c.s.edgesRelaxed === minEdges ? "win" : ""}>
                {fmt(c.s.edgesRelaxed)}
              </td>
            ))}
          </tr>
          <tr>
            <td>Compute time</td>
            {cols.map((c) => (
              <td key={c.name} className={c.s.computeTimeMs === minTime ? "win" : ""}>
                {c.s.computeTimeMs.toFixed(1)} ms
              </td>
            ))}
          </tr>
          <tr>
            <td>Route distance</td>
            {cols.map((c) => (
              <td key={c.name}>{km(c.s.pathLengthMeters)} km</td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="compare-foot">
        {ch
          ? "All three return the same provably optimal route. CH precomputes shortcuts offline so its live query barely searches — its edge grows the longer the trip."
          : "Both are provably optimal — A* just adds a straight-line heuristic to avoid exploring in the wrong direction."}
      </p>
    </div>
  );
}
