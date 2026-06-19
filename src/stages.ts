import {
  DijkstraPathfinder,
  AStarPathfinder,
  type Pathfinder,
} from "./engine/pathfinder";

/**
 * The "construction sequence": the SAME route, solved by escalating methods.
 *
 * Each stage is a different routing METHOD shown as a refinement of the previous
 * one — like a building going foundation → skeleton → finished. Stages 1–2 are
 * real and runnable now; 3–4 are deliberately locked to show viewers the roadmap
 * without overpromising. A stage with `pathfinder: null` is locked.
 */
export interface Stage {
  /** "Model 1", "Model 2", … shown on the timeline. */
  model: string;
  /** Short human name, e.g. "Brute Force". */
  name: string;
  /** The algorithm/technique, e.g. "Dijkstra". */
  algo: string;
  /** One-line description for the timeline tooltip / subtitle. */
  blurb: string;
  /** The engine that plays this stage, or null if it's locked/coming. */
  pathfinder: Pathfinder | null;
  /** Frontier accent colour (RGB 0–255) — Dijkstra's flood vs A*'s beam differ. */
  accent: [number, number, number];
}

export const STAGES: Stage[] = [
  {
    model: "Model 1",
    name: "Brute Force",
    algo: "Dijkstra",
    blurb: "Explore outward in every direction until the destination is reached.",
    pathfinder: new DijkstraPathfinder(),
    accent: [56, 232, 255], // cyan flood
  },
  {
    model: "Model 2",
    name: "Guided Search",
    algo: "A*",
    blurb: "Add a straight-line heuristic to aim the search at the goal.",
    pathfinder: new AStarPathfinder(),
    accent: [120, 245, 150], // green beam
  },
  {
    model: "Model 3",
    name: "Production",
    algo: "Contraction Hierarchies",
    blurb: "Precompute shortcuts for near-instant queries. (Coming next.)",
    pathfinder: null, // locked
    accent: [180, 160, 255],
  },
  {
    model: "Model 4",
    name: "What You Actually See",
    algo: "Clean route + ETA",
    blurb: "The polished result a rider sees — just the line and the time. (Coming.)",
    pathfinder: null, // locked
    accent: [255, 205, 120],
  },
];

export const isLocked = (s: Stage): boolean => s.pathfinder === null;
