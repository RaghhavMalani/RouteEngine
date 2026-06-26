/**
 * Cinematic intro title card — a brief, dissolving overlay shown on load that
 * sets the "designed model" tone before the user touches anything. Purely
 * presentational; App unmounts it after the animation. Non-interactive so it
 * never blocks a click.
 */
export default function Intro() {
  return (
    <div className="intro">
      <div className="eyebrow">Bengaluru · 220,723 nodes</div>
      <div className="title">
        Route<em>Engine</em>
      </div>
      <div className="rule" />
      <div className="sub">A construction sequence</div>
    </div>
  );
}
