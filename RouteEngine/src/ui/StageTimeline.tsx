import { STAGES, isLocked } from "../stages";

export type StageStatus = "done" | "active" | "available" | "locked";

interface StageTimelineProps {
  statuses: StageStatus[];
}

const rgb = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * The "construction phases" indicator. It doubles as the roadmap: locked stages
 * are greyed with a small lock so a viewer immediately sees where the project is
 * going (CH, then a production presentation), without us overpromising.
 */
export default function StageTimeline({ statuses }: StageTimelineProps) {
  return (
    <div className="timeline">
      <div className="section-label">Construction sequence</div>
      {STAGES.map((stage, i) => {
        const status = statuses[i];
        const locked = isLocked(stage);
        return (
          <div key={stage.model} className={`stage-row ${status}`}>
            <div
              className="stage-dot"
              style={{
                background:
                  status === "active" || status === "done"
                    ? rgb(stage.accent)
                    : "transparent",
                borderColor: rgb(stage.accent),
              }}
            >
              {status === "done" ? "✓" : locked ? "🔒" : ""}
            </div>
            <div className="stage-text">
              <div className="stage-title">
                <span className="stage-model">{stage.model}</span> · {stage.name}
                {status === "active" && <span className="stage-live">live</span>}
              </div>
              <div className="stage-algo">{stage.algo}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
