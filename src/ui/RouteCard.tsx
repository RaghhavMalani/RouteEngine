import {
  CONDITION_SHORT,
  CONDITION_LABEL,
  type TrafficCondition,
} from "../engine/eta";

interface RouteCardProps {
  fromLabel: string;
  toLabel: string;
  minutes: number;
  freeMinutes: number;
  distanceKm: number;
  via: string;
  condition: TrafficCondition;
  onCondition: (c: TrafficCondition) => void;
  routeMode: "shortest" | "fastest";
  onRouteMode: (m: "shortest" | "fastest") => void;
  shortMinutes: number | null;
  fastMinutes: number | null;
  onShowReal: () => void;
}

const CONDITIONS: TrafficCondition[] = ["free", "light", "moderate", "heavy"];

/**
 * Stage 4's consumer route sheet. Lets you switch between the SHORTEST-distance
 * route (from CH) and the FASTEST-time route (re-solved live for the chosen
 * traffic condition) — they genuinely differ — and pick a traffic condition. ETA
 * is modelled (free-flow speeds × congestion); see engine/eta.ts.
 */
export default function RouteCard({
  fromLabel,
  toLabel,
  minutes,
  distanceKm,
  via,
  condition,
  onCondition,
  routeMode,
  onRouteMode,
  shortMinutes,
  fastMinutes,
  onShowReal,
}: RouteCardProps) {
  const mins = Math.max(1, Math.round(minutes));
  const eta = mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
  const arrival = new Date(Date.now() + mins * 60000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const sMin = shortMinutes != null ? Math.round(shortMinutes) : null;
  const fMin = fastMinutes != null ? Math.round(fastMinutes) : null;
  const saves = sMin != null && fMin != null ? sMin - fMin : 0;

  return (
    <div className="route-card">
      <div className="mode-row">
        <button
          className={routeMode === "shortest" ? "active" : ""}
          onClick={() => onRouteMode("shortest")}
        >
          Shortest
        </button>
        <button
          className={routeMode === "fastest" ? "active" : ""}
          onClick={() => onRouteMode("fastest")}
        >
          Fastest
        </button>
      </div>

      <div className="route-card-top">
        <div className="route-card-eta">{eta}</div>
        <div className="route-card-dist">{distanceKm.toFixed(1)} km</div>
      </div>
      <div className="route-card-sub">
        via {via} · arrive {arrival}
      </div>

      {saves >= 1 && (
        <div className="route-card-compare">
          {routeMode === "fastest" ? (
            <>
              Fastest saves <b>{saves} min</b> vs shortest ({sMin} min)
            </>
          ) : (
            <>
              Fastest would be <b>{fMin} min</b> (−{saves} min) — tap Fastest
            </>
          )}
        </div>
      )}

      <div className="cond-row">
        {CONDITIONS.map((c) => (
          <button
            key={c}
            className={`cond-chip ${c === condition ? "active" : ""}`}
            onClick={() => onCondition(c)}
          >
            {CONDITION_SHORT[c]}
          </button>
        ))}
      </div>

      <div className="route-card-ends">
        {fromLabel || "Source"} <span>→</span> {toLabel || "Destination"}
      </div>
      <div className="route-card-note">
        {CONDITION_LABEL[condition]} · modelled
        <span className="info-dot" tabIndex={0}>
          i
          <span className="info-tip">
            ETA = per-road-class <b>free-flow speeds</b> × a <b>congestion factor</b>{" "}
            for the condition. <b>Shortest</b> minimises distance (from CH);{" "}
            <b>Fastest</b> re-solves to minimise time, so at peak it avoids clogged
            arterials. Modelled, not a live feed.
          </span>
        </span>
      </div>
      <button className="route-card-btn" onClick={onShowReal}>
        ↩ Show the search behind this route
      </button>
    </div>
  );
}
