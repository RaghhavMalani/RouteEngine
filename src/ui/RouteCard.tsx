interface RouteCardProps {
  fromLabel: string;
  toLabel: string;
  minutes: number;
  distanceKm: number;
  via: string;
  onShowReal: () => void;
}

/**
 * Stage 4's consumer-app route sheet: the clean ETA / distance / "via" the way a
 * maps app shows it — none of the search machinery. The ETA is a free-flow
 * estimate (see engine/eta.ts), labelled as such.
 */
export default function RouteCard({
  fromLabel,
  toLabel,
  minutes,
  distanceKm,
  via,
  onShowReal,
}: RouteCardProps) {
  const mins = Math.max(1, Math.round(minutes));
  const eta = mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
  const arrival = new Date(Date.now() + mins * 60000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="route-card">
      <div className="route-card-top">
        <div className="route-card-eta">{eta}</div>
        <div className="route-card-dist">{distanceKm.toFixed(1)} km</div>
      </div>
      <div className="route-card-sub">
        via {via} · arrive {arrival}
      </div>
      <div className="route-card-ends">
        {fromLabel || "Source"} <span>→</span> {toLabel || "Destination"}
      </div>
      <div className="route-card-note">Free-flow ETA estimate</div>
      <button className="route-card-btn" onClick={onShowReal}>
        Show what really happened
      </button>
    </div>
  );
}
