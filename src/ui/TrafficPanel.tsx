import { CONGESTION_RGB, CONGESTION_LABEL, type Congestion } from "../engine/traffic";

export interface RouteSummary {
  km: number;
  minutes: number;
}

interface TrafficPanelProps {
  hour: number;
  onHour: (h: number) => void;
  metric: "time" | "distance";
  onMetric: (m: "time" | "distance") => void;
  /** Both candidate routes under the current model (null until endpoints are set). */
  timeRoute: RouteSummary | null;
  distRoute: RouteSummary | null;
  hasEndpoints: boolean;
  // Slice B — live drive + rerouting.
  driving: boolean;
  hasJourney: boolean;
  onToggleDrive: () => void;
  onInject: () => void;
  onClear: () => void;
  rerouteMs: number | null;
  closuresCount: number;
  onScenario: () => void;
}

const LEVELS: Congestion[] = [0, 1, 2, 3];

function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const disp = h % 12 === 0 ? 12 : h % 12;
  let tag = "";
  if (h >= 8 && h <= 10) tag = " · morning peak";
  else if (h >= 17 && h <= 20) tag = " · evening peak";
  else if (h >= 23 || h <= 5) tag = " · overnight";
  else if (h >= 11 && h <= 16) tag = " · daytime";
  return `${disp}:00 ${ampm}${tag}`;
}

const rgbCss = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * Phase-5 Traffic panel (Slice A): time-of-day slider, congestion legend, and the
 * distance-vs-time metric toggle, with a live comparison of the two candidate
 * routes so the "shorter-but-slower vs longer-but-faster" contrast is visible.
 */
export default function TrafficPanel({
  hour,
  onHour,
  metric,
  onMetric,
  timeRoute,
  distRoute,
  hasEndpoints,
  driving,
  hasJourney,
  onToggleDrive,
  onInject,
  onClear,
  rerouteMs,
  closuresCount,
  onScenario,
}: TrafficPanelProps) {
  const saved =
    timeRoute && distRoute ? Math.round(distRoute.minutes - timeRoute.minutes) : 0;
  const driveLabel = driving ? "Pause" : hasJourney ? "Resume" : "Start drive";

  return (
    <div className="traffic-panel">
      <div className="tp-head">Traffic · simulated</div>
      <div className="tp-intro">
        Routes now minimise <b>travel time</b>, not distance. Congestion is modelled
        from the time of day — drag the slider, or try the scenario.
      </div>

      <button className="tp-scenario" onClick={onScenario}>
        ✦ Show me a rush-hour detour
      </button>
      <div className="tp-help">
        Loads a 9am peak trip where the shortest road is jammed and a longer route is
        actually faster.
      </div>

      <div className="section-label">Time of day</div>
      <div className="slider-row">
        <input
          type="range"
          min={0}
          max={23}
          step={1}
          value={hour}
          onChange={(e) => onHour(Number(e.target.value))}
        />
      </div>
      <div className="tp-hour">{hourLabel(hour)}</div>

      <div className="section-label">Congestion</div>
      <div className="tp-legend">
        {LEVELS.map((l) => (
          <span key={l} className="tp-leg">
            <span className="tp-swatch" style={{ background: rgbCss(CONGESTION_RGB[l]) }} />
            {CONGESTION_LABEL[l]}
          </span>
        ))}
      </div>

      <div className="section-label">Route by</div>
      <div className="mode-row">
        <button
          className={metric === "time" ? "active" : ""}
          onClick={() => onMetric("time")}
        >
          Fastest (time)
        </button>
        <button
          className={metric === "distance" ? "active" : ""}
          onClick={() => onMetric("distance")}
        >
          Shortest (distance)
        </button>
      </div>

      {!hasEndpoints && (
        <div className="tp-note">Set a source and destination to route.</div>
      )}

      {hasEndpoints && timeRoute && distRoute && (
        <div className="tp-compare">
          <div className={`tp-cmp-row ${metric === "distance" ? "win" : ""}`}>
            <span>Shortest</span>
            <span>
              {distRoute.km.toFixed(1)} km · <b>{Math.round(distRoute.minutes)} min</b>
            </span>
          </div>
          <div className={`tp-cmp-row ${metric === "time" ? "win" : ""}`}>
            <span>Fastest</span>
            <span>
              {timeRoute.km.toFixed(1)} km · <b>{Math.round(timeRoute.minutes)} min</b>
            </span>
          </div>
          {saved > 0 ? (
            <div className="tp-verdict">
              Fastest is <b>{saved} min</b> quicker despite{" "}
              {(timeRoute.km - distRoute.km).toFixed(1)} km extra — traffic makes the
              longer road win.
            </div>
          ) : (
            <div className="tp-verdict dim">
              At this hour the shortest road is also the fastest.
            </div>
          )}
        </div>
      )}

      <div className="section-label">Live drive</div>
      <div className="tp-drive">
        <button className="tp-btn primary" onClick={onToggleDrive} disabled={!hasEndpoints}>
          ▶ {driveLabel}
        </button>
        <div className="tp-drive-row">
          <button className="tp-btn" onClick={onInject} disabled={!hasJourney}>
            ⚠ Inject incident
          </button>
          <button className="tp-btn" onClick={onClear} disabled={closuresCount === 0}>
            Clear
          </button>
        </div>
        <div className="tp-help">
          Drives a car along the route. <b>Inject incident</b> closes a road just ahead
          and reroutes live from the car's position.
        </div>
        {rerouteMs != null && (
          <div className="tp-reroute">
            Rerouted in <b>{rerouteMs.toFixed(1)} ms</b> · {closuresCount} closure
            {closuresCount === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </div>
  );
}
