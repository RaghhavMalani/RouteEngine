import {
  LineLayer,
  ScatterplotLayer,
  PathLayer,
  PolygonLayer,
  TextLayer,
  ArcLayer,
} from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import type { Layer } from "@deck.gl/core";

/**
 * Layer construction for the "designed 3D model" view.
 *
 * The scene has tiers drawn back-to-front:
 *   1. WATER (optional) — faint dark shapes for geographic context.
 *   2. ROAD MODEL — Bengaluru's full real road network as thin lines on the ground.
 *   3. THE SEARCH — the current stage's exploration frontier, lifted off the ground.
 *      For Dijkstra/A* height = cost-from-source g(n); for CH height = node LEVEL,
 *      and the search is two-coloured (forward vs backward) with sampled shortcut
 *      ARCS for the hierarchy-assembly beat.
 *   4. THE ROUTE — the final/unpacked path ribbon, + the only two labels.
 *
 * PERFORMANCE: every `data` array is built once (in App) and never rebuilt while
 * animating. The reveal grows by moving a DataFilterExtension's upper bound (one
 * uniform) — so 100k+ edges stay at ~60fps with zero per-frame buffer churn.
 */

export const HEIGHT_M = 2200;
/**
 * The hero route is drawn ON the road plane (a hair above it to avoid z-fighting)
 * — NOT at cost height — so it traces the real Bengaluru roads and lines up with
 * the source/destination markers instead of floating off in space.
 */
const ROUTE_LIFT = 6;

export interface RoadEdge {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export interface EdgeDatum {
  sx: number;
  sy: number;
  sCost: number;
  tx: number;
  ty: number;
  tCost: number;
  step: number;
  dir?: number; // 0 fwd / 1 bwd (CH); undefined for single-colour stages
}

export interface NodeDatum {
  x: number;
  y: number;
  cost: number;
  step: number;
  dir?: number; // 0 fwd / 1 bwd / 2 hierarchy landmark
}

/** A sampled shortcut arc for the CH hierarchy-assembly beat. */
export interface ArcDatum {
  sx: number;
  sy: number;
  sCost: number;
  tx: number;
  ty: number;
  tCost: number;
  step: number;
}

export interface PathPt {
  x: number;
  y: number;
  cost: number;
}

export type RGB = readonly [number, number, number];
type RGBA = [number, number, number, number];

export interface StageRender {
  edgeData: EdgeDatum[];
  nodeData: NodeDatum[];
  arcData: ArcDatum[]; // CH hierarchy arcs (empty for other stages)
  pathPts: PathPt[];
  maxCost: number;
  revealStep: number;
  pathReveal: number;
  opacity: number;
  accent: RGB;
  chMode: boolean; // true on Stage 3 → two-colour search + arcs
  pulse: number; // 0..1 looping position of the flowing light once the route is drawn
  meetPoint: [number, number] | null; // CH: where the two searches met (pulsing marker)
}

export interface LayerInput {
  roadEdges: RoadEdge[];
  render: StageRender | null;
  water: number[][][];
  source: [number, number] | null;
  destination: [number, number] | null;
  sourceLabel: string;
  destLabel: string;
}

const rgba = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];

const ROAD_COLOR: RGBA = [78, 104, 130, 95];
const WATER_COLOR: RGBA = [18, 32, 48, 160];
const PATH_COLOR: RGB = [205, 255, 215];
const GREEN: RGB = [70, 240, 140];
const PINK: RGB = [255, 95, 140];

// CH two-colour search + hierarchy palette.
const CH_FWD: RGB = [90, 200, 255]; // forward (from source) — cool
const CH_BWD: RGB = [255, 160, 90]; // backward (from target) — warm
const CH_ARC: RGB = [180, 150, 255]; // shortcut arcs / landmarks — violet

const DATA_FILTER = new DataFilterExtension({ filterSize: 1 });
const FILTER_EXT = [DATA_FILTER];

function reveal(filterRange: [number, number]) {
  return {
    getFilterValue: (d: { step: number }) => d.step,
    filterRange,
    extensions: FILTER_EXT,
  } as Record<string, unknown>;
}


const lerp = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Wavefront colour for Dijkstra/A*: a dim indigo core near the source rising
 * through the stage accent to a bright leading edge at the highest cost. The
 * interior is also faded (low alpha) so the search reads as an expanding wave /
 * dome, not one flat saturated blob.
 */
const WAVE_CORE: RGB = [20, 40, 104];
const WAVE_EDGE: RGB = [240, 252, 255];
function wavefront(accent: RGB, t: number): RGBA {
  const x = Math.min(1, Math.max(0, t));
  const c = x < 0.6 ? lerp(WAVE_CORE, accent, x / 0.6) : lerp(accent, WAVE_EDGE, (x - 0.6) / 0.4);
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(38 + 130 * x)];
}

export function buildLayers(input: LayerInput): Layer[] {
  const layers: Layer[] = [];

  // 1. WATER
  if (input.water.length > 0) {
    layers.push(
      new PolygonLayer<number[][]>({
        id: "water",
        data: input.water,
        getPolygon: (d) => d,
        getFillColor: WATER_COLOR,
        stroked: false,
        getElevation: 0,
        pickable: false,
      }),
    );
  }

  // 2. ROAD MODEL
  layers.push(
    new LineLayer<RoadEdge>({
      id: "road-model",
      data: input.roadEdges,
      getSourcePosition: (d) => [d.sx, d.sy, 0],
      getTargetPosition: (d) => [d.tx, d.ty, 0],
      getColor: ROAD_COLOR,
      getWidth: 0.7,
      widthUnits: "pixels",
    }),
  );

  // 3. THE SEARCH
  const r = input.render;
  if (r) {
    // The search is drawn FLAT on the road plane — cost/level is shown by COLOUR,
    // not height — so the visited nodes, the route, and the real roads all sit on
    // the same plane and line up (no floating dome vs. grounded route mismatch).
    const zFactor = 0;
    const filterRange: [number, number] = [-1, r.revealStep];
    const op = r.opacity;
    const ch = r.chMode;

    // For CH the search tree is drawn in SOLID forward/backward colour (no
    // whiten-by-height — that turned the funnels into white noise). Dijkstra/A*
    // keep the cost-surface tint that makes the dome/ridge read.
    const edgeColor = (d: EdgeDatum): RGBA =>
      ch
        ? rgba(d.dir === 1 ? CH_BWD : CH_FWD, 135)
        : wavefront(r.accent, d.tCost / r.maxCost);

    // CH hierarchy beat: a SMALL, faint set of shortcut arcs sweeping high over
    // the network — a backdrop that suggests the precomputed structure, not a web.
    if (ch && r.arcData.length > 0) {
      layers.push(
        new ArcLayer<ArcDatum>({
          id: "ch-arcs",
          data: r.arcData,
          opacity: op * 0.5,
          getSourcePosition: (d) => [d.sx, d.sy, d.sCost * zFactor],
          getTargetPosition: (d) => [d.tx, d.ty, d.tCost * zFactor],
          getSourceColor: rgba(CH_ARC, 22),
          getTargetColor: rgba(CH_ARC, 80),
          getHeight: 0.4,
          getWidth: 0.8,
          widthUnits: "pixels",
          updateTriggers: { getSourcePosition: zFactor, getTargetPosition: zFactor },
          ...reveal(filterRange),
        }),
      );
    }

    // Frontier lines: Dijkstra/A* fan-out along real road segments (this is the
    // glowing flood). For CH we DON'T draw search edges — a node's parent is often
    // reached via a long shortcut, so those edges become meaningless city-spanning
    // lasers. CH's search reads instead as two converging clouds of dots (below).
    if (!ch) {
      layers.push(
        new LineLayer<EdgeDatum>({
          id: "frontier",
          data: r.edgeData,
          opacity: op,
          getSourcePosition: (d) => [d.sx, d.sy, d.sCost * zFactor],
          getTargetPosition: (d) => [d.tx, d.ty, d.tCost * zFactor],
          getColor: edgeColor,
          getWidth: 1.1,
          widthUnits: "pixels",
          updateTriggers: {
            getSourcePosition: zFactor,
            getTargetPosition: zFactor,
            getColor: [r.accent, r.maxCost],
          },
          ...reveal(filterRange),
        }),
      );
    }

    // Settled / landmark dots resting on the surface.
    const nodeColor = (d: NodeDatum): RGBA => {
      if (!ch) return wavefront(r.accent, d.cost / r.maxCost);
      if (d.dir === 2) return rgba(CH_ARC, 30); // faint layered-hierarchy dots
      return rgba(d.dir === 1 ? CH_BWD : CH_FWD, 230); // two converging search clouds
    };
    // CH: soft glow halo behind the two converging search clouds.
    if (ch) {
      layers.push(
        new ScatterplotLayer<NodeDatum>({
          id: "ch-glow",
          data: r.nodeData,
          opacity: op,
          getPosition: (d) => [d.x, d.y, d.cost * zFactor],
          getFillColor: (d) =>
            d.dir === 2 ? [0, 0, 0, 0] : rgba(d.dir === 1 ? CH_BWD : CH_FWD, 45),
          getRadius: (d) => (d.dir === 2 ? 0 : 7),
          radiusUnits: "pixels",
          updateTriggers: { getPosition: zFactor },
          ...reveal(filterRange),
        }),
      );
    }
    layers.push(
      new ScatterplotLayer<NodeDatum>({
        id: "settled",
        data: r.nodeData,
        opacity: op,
        getPosition: (d) => [d.x, d.y, d.cost * zFactor],
        getFillColor: nodeColor,
        getRadius: (d) => (ch ? (d.dir === 2 ? 0.8 : 2.6) : 1.3),
        radiusUnits: "pixels",
        updateTriggers: {
          getPosition: zFactor,
          getFillColor: [r.accent, ch, r.maxCost],
          getRadius: ch,
        },
        ...reveal(filterRange),
      }),
    );

    // Final / unpacked route ribbon.
    // CH: a pulsing ring at the node where the two searches met.
    if (ch && r.meetPoint && r.revealStep >= 0) {
      const pr = 9 + 7 * (0.5 + 0.5 * Math.sin(r.pulse * Math.PI * 2));
      layers.push(
        new ScatterplotLayer<{ p: [number, number] }>({
          id: "ch-meet",
          data: [{ p: r.meetPoint }],
          opacity: op,
          getPosition: (d) => [d.p[0], d.p[1], 0],
          getFillColor: [255, 255, 255, 0],
          stroked: true,
          getLineColor: [225, 236, 255, 210],
          lineWidthUnits: "pixels",
          getLineWidth: 1.6,
          getRadius: pr,
          radiusUnits: "pixels",
          updateTriggers: { getRadius: r.pulse },
        }),
      );
    }

    if (r.pathPts.length >= 2 && r.pathReveal > 0) {
      const count = Math.max(2, Math.ceil(r.pathReveal * r.pathPts.length));
      // Draw the route ON the road plane (flat), so it traces the real roads and
      // lines up with the endpoint markers — not floating at cost height.
      const coords = r.pathPts
        .slice(0, count)
        .map((p) => [p.x, p.y, ROUTE_LIFT] as [number, number, number]);
      const pathData = [{ path: coords }];
      const trig = { getPath: count };
      layers.push(
        // soft outer bloom
        new PathLayer<{ path: [number, number, number][] }>({
          id: "route-bloom",
          data: pathData,
          opacity: op,
          getPath: (d) => d.path,
          getColor: rgba(PATH_COLOR, 34),
          getWidth: 26,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          updateTriggers: trig,
        }),
        // mid glow
        new PathLayer<{ path: [number, number, number][] }>({
          id: "route-glow",
          data: pathData,
          opacity: op,
          getPath: (d) => d.path,
          getColor: rgba(PATH_COLOR, 95),
          getWidth: 12,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          updateTriggers: trig,
        }),
        // bright core
        new PathLayer<{ path: [number, number, number][] }>({
          id: "route-core",
          data: pathData,
          opacity: op,
          getPath: (d) => d.path,
          getColor: [236, 255, 242, 255],
          getWidth: 4.5,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          updateTriggers: trig,
        }),
      );

      // Comet head: a bright pulse at the drawing tip while the route grows.
      if (r.pathReveal < 0.999 && coords.length > 0) {
        const head = coords[coords.length - 1];
        layers.push(
          new ScatterplotLayer<{ p: [number, number, number] }>({
            id: "route-head",
            data: [{ p: head }],
            opacity: op,
            getPosition: (d) => d.p,
            getFillColor: [255, 255, 255, 255],
            getRadius: 5,
            radiusUnits: "pixels",
            stroked: true,
            getLineColor: rgba(PATH_COLOR, 120),
            lineWidthUnits: "pixels",
            getLineWidth: 6,
            updateTriggers: { getPosition: count },
          }),
        );
      }

      // Flowing pulse: once the route is fully drawn, a bright comet of light
      // travels along it on a loop — the "live route" beat.
      if (r.pathReveal >= 0.999 && coords.length > 2) {
        const last = coords.length - 1;
        const headIdx = Math.min(last, Math.max(0, Math.floor(r.pulse * last)));
        const trailLen = Math.max(2, Math.ceil(coords.length * 0.1));
        const trail = coords.slice(Math.max(0, headIdx - trailLen), headIdx + 1);
        if (trail.length >= 2) {
          layers.push(
            new PathLayer<{ path: [number, number, number][] }>({
              id: "route-pulse-trail",
              data: [{ path: trail }],
              getPath: (d) => d.path,
              getColor: [255, 255, 255, 235],
              getWidth: 6,
              widthUnits: "pixels",
              capRounded: true,
              jointRounded: true,
              updateTriggers: { getPath: headIdx },
            }),
          );
        }
        layers.push(
          new ScatterplotLayer<{ p: [number, number, number] }>({
            id: "route-pulse-head",
            data: [{ p: coords[headIdx] }],
            getPosition: (d) => d.p,
            getFillColor: [255, 255, 255, 255],
            getRadius: 5.5,
            radiusUnits: "pixels",
            stroked: true,
            getLineColor: rgba(PATH_COLOR, 130),
            lineWidthUnits: "pixels",
            getLineWidth: 7,
            updateTriggers: { getPosition: headIdx },
          }),
        );
      }
    }
  }

  // 4. ENDPOINTS + labels
  const markers: { coord: [number, number]; color: RGB }[] = [];
  if (input.source) markers.push({ coord: input.source, color: GREEN });
  if (input.destination) markers.push({ coord: input.destination, color: PINK });
  if (markers.length) {
    layers.push(
      new ScatterplotLayer<{ coord: [number, number]; color: RGB }>({
        id: "endpoints",
        data: markers,
        getPosition: (d) => [d.coord[0], d.coord[1], 0],
        getFillColor: (d) => rgba(d.color, 255),
        getLineColor: [4, 7, 11, 255],
        getRadius: 7,
        radiusUnits: "pixels",
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        updateTriggers: { getPosition: markers.map((m) => m.coord) },
      }),
    );
  }

  const labels: { coord: [number, number]; text: string }[] = [];
  if (input.source && input.sourceLabel)
    labels.push({ coord: input.source, text: input.sourceLabel });
  if (input.destination && input.destLabel)
    labels.push({ coord: input.destination, text: input.destLabel });
  if (labels.length) {
    layers.push(
      new TextLayer<{ coord: [number, number]; text: string }>({
        id: "endpoint-labels",
        data: labels,
        getPosition: (d) => [d.coord[0], d.coord[1], 0],
        getText: (d) => d.text,
        getSize: 13,
        getColor: [235, 242, 248, 255],
        getPixelOffset: [0, -16],
        background: true,
        getBackgroundColor: [10, 14, 20, 190],
        backgroundPadding: [6, 3],
        fontWeight: 600,
        billboard: true,
        updateTriggers: { getText: labels.map((l) => l.text) },
      }),
    );
  }

  return layers;
}
