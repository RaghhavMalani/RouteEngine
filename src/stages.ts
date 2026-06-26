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
  /**
   * True for Stage 3: its pathfinder isn't constructed statically because it
   * needs the cached CH artefact (public/bengaluru-ch.json) loaded at runtime.
   * App supplies the CHPathfinder once that file has loaded; until then the stage
   * shows as locked. (Stage 4 has neither a pathfinder nor this flag → it stays
   * permanently locked / "coming".)
   */
  needsCH?: boolean;
  /**
   * True for Stage 4: it runs no search of its own. It REUSES the Stage 3 (CH)
   * route and presents it the way a consumer maps app would — all the search
   * machinery stripped away. Not locked.
   */
  presentation?: boolean;
  /** One-line caption shown per stage during Demo Mode. */
  caption: string;
  /** Frontier accent colour (RGB 0–255) — Dijkstra's flood vs A*'s beam differ. */
  accent: [number, number, number];
}

export const STAGES: Stage[] = [
  {
    model: "Model 1",
    name: "Brute Force",
    algo: "Dijkstra",
    blurb: "Explore outward in every direction until the destination is reached.",
    caption: "Dijkstra — explores in every direction",
    pathfinder: new DijkstraPathfinder(),
    accent: [56, 232, 255], // cyan flood
  },
  {
    model: "Model 2",
    name: "Guided Search",
    algo: "A*",
    blurb: "Add a straight-line heuristic to aim the search at the goal.",
    caption: "A* — aims toward the goal",
    pathfinder: new AStarPathfinder(),
    accent: [120, 245, 150], // green beam
  },
  {
    model: "Model 3",
    name: "Production",
    algo: "Contraction Hierarchies",
    blurb: "Precomputed shortcuts let the query skip huge regions and barely search.",
    caption: "Contraction Hierarchies — barely searches",
    pathfinder: null, // supplied at runtime once the CH cache loads (needsCH)
    needsCH: true,
    accent: [180, 160, 255],
  },
  {
    model: "Model 4",
    name: "What You Actually See",
    algo: "Clean route + ETA",
    blurb: "The production route a rider sees — all the search hidden away.",
    caption: "What you actually see",
    pathfinder: null, // no search of its own — reuses the CH route (presentation)
    presentation: true,
    accent: [120, 200, 255], // calm consumer-maps blue
  },
];

/**
 * Permanently locked / "coming". Stage 3 (needsCH) unlocks once the CH cache
 * loads; Stage 4 (presentation) reuses the CH route, so it's never locked either.
 */
export const isLocked = (s: Stage): boolean =>
  s.pathfinder === null && !s.needsCH && !s.presentation;
