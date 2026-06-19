import { QUICK_ROUTES, type QuickRoute } from "../places";

export type Mode = "source" | "destination";

interface ControlPanelProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  sourceLabel: string;
  destLabel: string;
  speed: number;
  onSpeedChange: (v: number) => void;
  onQuickRoute: (route: QuickRoute) => void;

  /** Contextual primary action: "Build", "Next stage → A*", "Replay", … */
  primaryLabel: string;
  primaryEnabled: boolean;
  onPrimary: () => void;
  onReset: () => void;
  /** Optional note under the buttons (e.g. a locked next stage). */
  hint: string | null;
}

/**
 * Floating glass control panel: pick endpoints, then drive the staged build.
 * Purely presentational — App owns the stage state machine and animation clock.
 */
export default function ControlPanel({
  mode,
  onModeChange,
  sourceLabel,
  destLabel,
  speed,
  onSpeedChange,
  onQuickRoute,
  primaryLabel,
  primaryEnabled,
  onPrimary,
  onReset,
  hint,
}: ControlPanelProps) {
  return (
    <div className="panel">
      <h1>RouteEngine</h1>
      <p className="subtitle">Bengaluru routing · a construction sequence</p>

      <div className="section-label">Set endpoints — click the model</div>
      <div className="mode-toggle">
        <button
          className={mode === "source" ? "active" : ""}
          onClick={() => onModeChange("source")}
        >
          <span className="dot" style={{ background: "#46f08c" }} />
          Source
        </button>
        <button
          className={mode === "destination" ? "active" : ""}
          onClick={() => onModeChange("destination")}
        >
          <span className="dot" style={{ background: "#ff5f8c" }} />
          Destination
        </button>
      </div>
      <div className="endpoint-readout">
        Source: <span>{sourceLabel}</span>
        <br />
        Destination: <span>{destLabel}</span>
      </div>

      <div className="section-label">Quick demo routes</div>
      <div className="quick-picks">
        {QUICK_ROUTES.map((route) => (
          <button key={route.label} onClick={() => onQuickRoute(route)}>
            {route.label}
          </button>
        ))}
      </div>

      <div className="section-label">Animation speed</div>
      <div className="slider-row">
        <input
          type="range"
          min={1}
          max={400}
          step={1}
          value={speed}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
        />
        <span className="val">{speed}×</span>
      </div>

      <div className="actions">
        <button className="btn btn-run" onClick={onPrimary} disabled={!primaryEnabled}>
          {primaryLabel}
        </button>
        <button className="btn btn-reset" onClick={onReset}>
          Reset
        </button>
      </div>
      {hint && <div className="panel-hint">{hint}</div>}
    </div>
  );
}
