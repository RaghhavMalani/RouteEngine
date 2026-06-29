interface ModeSwitchProps {
  mode: "sequence" | "traffic";
  onMode: (m: "sequence" | "traffic") => void;
}

/**
 * Floating, top-centre mode switch — a glass segmented control with a sliding
 * thumb that shifts colour by mode (cool blue for the algorithmic Sequence, warm
 * amber/red for live Traffic). Lives above the map, separate from the panels, so
 * switching feels like a first-class product control rather than a buried toggle.
 */
export default function ModeSwitch({ mode, onMode }: ModeSwitchProps) {
  return (
    <div className={`mode-switch ${mode}`}>
      <span className="ms-thumb" />
      <button
        className={mode === "sequence" ? "active" : ""}
        onClick={() => onMode("sequence")}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
            opacity="0.7"
          />
        </svg>
        Sequence
      </button>
      <button
        className={mode === "traffic" ? "active" : ""}
        onClick={() => onMode("traffic")}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M3 14h3l2.5-7 4 14 3-9 1.8 2h3.7"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Traffic
        {mode === "traffic" && <span className="ms-live" />}
      </button>
    </div>
  );
}
