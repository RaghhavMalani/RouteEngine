interface MetricsProps {
  /** Current stage name + algorithm, or null before Build. */
  stageModel: string | null;
  stageName: string | null;
  algo: string | null;
  accent: readonly [number, number, number];
  nodesExplored: number;
  edgesRelaxed: number;
  distanceKm: number | null;
  computeTimeMs: number | null;
  totalNodes: number;
}

const fmt = (n: number) => n.toLocaleString();
const rgb = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * Live, per-stage metrics HUD. Counts tick up as the current stage's search is
 * revealed (App recomputes them from the revealed prefix each frame).
 */
export default function Metrics({
  stageModel,
  stageName,
  algo,
  accent,
  nodesExplored,
  edgesRelaxed,
  distanceKm,
  computeTimeMs,
  totalNodes,
}: MetricsProps) {
  return (
    <div className="metrics">
      <div className="section-label" style={{ color: rgb(accent) }}>
        {stageModel ? `${stageModel} · ${algo}` : "Live metrics"}
      </div>
      {stageName && <div className="metrics-stage">{stageName}</div>}

      <div className="metric">
        <span className="label">Nodes explored</span>
        <span className="value" style={{ color: rgb(accent) }}>
          {fmt(nodesExplored)}
        </span>
      </div>
      <div className="metric">
        <span className="label">Edges relaxed</span>
        <span className="value" style={{ color: rgb(accent) }}>
          {fmt(edgesRelaxed)}
        </span>
      </div>
      <div className="metric">
        <span className="label">Distance</span>
        <span className="value" style={{ color: rgb(accent) }}>
          {distanceKm === null ? "—" : `${distanceKm.toFixed(2)} km`}
        </span>
      </div>
      <div className="metric">
        <span className="label">Compute time</span>
        <span className="value" style={{ color: rgb(accent) }}>
          {computeTimeMs === null ? "—" : `${computeTimeMs.toFixed(1)} ms`}
        </span>
      </div>

      <div className="legend">
        <div className="row" style={{ opacity: 0.7 }}>
          colour = cost-from-source · {fmt(totalNodes)} nodes in model
        </div>
      </div>
    </div>
  );
}
