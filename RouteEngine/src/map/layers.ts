import {
  LineLayer,
  ScatterplotLayer,
  PathLayer,
  PolygonLayer,
  TextLayer,
} from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import type { Layer } from "@deck.gl/core";

/**
 * Layer construction for the "designed 3D model" view.
 *
 * The scene has three conceptual tiers, drawn back-to-front:
 *   1. WATER (optional) — faint dark shapes for geographic context.
 *   2. ROAD MODEL — Bengaluru's full real road network as thin, refined lines on
 *      the ground plane. This is the static "building"; it never changes.
 *   3. THE SEARCH — the current stage's exploration frontier, lifted off the
 *      ground by cost-from-source g(n), plus the final route ribbon on top.
 *
 * PERFORMANCE: every `data` array is built once (in App) and never rebuilt while
 * animating. The reveal grows by moving a DataFilterExtension's upper bound (one
 * uniform), and stage cross-fades use the `opacity` uniform — so 100k+ edges stay
 * at ~60fps with zero per-frame buffer churn.
 */

/** Fixed mapping of the tallest cost → this height in meters. No live slider. */
export const HEIGHT_M = 2200;

/** A static road-model segment (ground plane). */
export interface RoadEdge {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** A frontier edge of the current search, with cost (g) at each endpoint. */
export interface EdgeDatum {
  sx: number;
  sy: number;
  sCost: number;
  tx: number;
  ty: number;
  tCost: number;
  step: number; // exploration order — the GPU reveal attribute
}

export interface NodeDatum {
  x: number;
  y: number;
  cost: number;
  step: number;
}

export interface PathPt {
  x: number;
  y: number;
  cost: number;
}

export type RGB = readonly [number, number, number];
type RGBA = [number, number, number, number];

/** Everything needed to draw ONE stage's search at a moment in time. */
export interface StageRender {
  edgeData: EdgeDatum[];
  nodeData: NodeDatum[];
  pathPts: PathPt[];
  maxCost: number;
  revealStep: number; // upper bound of the reveal filter (the animation clock)
  pathReveal: number; // 0…1 draw-on of the final route
  opacity: number; // 0…1 — used to dissolve between stages
  accent: RGB; // frontier colour for this stage
}

export interface LayerInput {
  roadEdges: RoadEdge[];
  /** The active stage's search to draw, or null before any Build. */
  render: StageRender | null;
  /** Optional water polygons: each an outer ring of [lng, lat]. */
  water: number[][][];
  source: [number, number] | null;
  destination: [number, number] | null;
  sourceLabel: string;
  destLabel: string;
}

const rgba = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];

const ROAD_COLOR: RGBA = [78, 104, 130, 95]; // faint cool grey-blue model lines
const WATER_COLOR: RGBA = [18, 32, 48, 160]; // dark, barely-there water
const PATH_COLOR: RGB = [205, 255, 215]; // bright near-white route ribbon
const GREEN: RGB = [70, 240, 140];
const PINK: RGB = [255, 95, 140];

const DATA_FILTER = new DataFilterExtension({ filterSize: 1 });
const FILTER_EXT = [DATA_FILTER];

/** Extension props (getFilterValue/filterRange) via spread — see notes in app. */
function reveal(filterRange: [number, number]) {
  return {
    getFilterValue: (d: { step: number }) => d.step,
    filterRange,
    extensions: FILTER_EXT,
  } as Record<string, unknown>;
}

/** Lighten a colour toward white as normalized height t∈[0,1] rises. */
function tintByHeight(c: RGB, t: number, alpha: number): RGBA {
  const k = Math.min(1, Math.max(0, t)) * 0.65;
  return [
    Math.round(c[0] + (255 - c[0]) * k),
    Math.round(c[1] + (255 - c[1]) * k),
    Math.round(c[2] + (255 - c[2]) * k),
    alpha,
  ];
}

export function buildLayers(input: LayerInput): Layer[] {
  const layers: Layer[] = [];

  // 1. WATER — optional faint polygons, drawn first so everything sits above it.
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

  // 2. ROAD MODEL — the static city. Thin, refined, on the ground plane.
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

  // 3. THE SEARCH — only when a stage is active.
  const r = input.render;
  if (r) {
    const zFactor = r.maxCost > 0 ? HEIGHT_M / r.maxCost : 0;
    const filterRange: [number, number] = [-1, r.revealStep];
    const op = r.opacity;

    // Frontier: glowing elevated lines, tinted by height, this stage's accent.
    layers.push(
      new LineLayer<EdgeDatum>({
        id: "frontier",
        data: r.edgeData,
        opacity: op,
        getSourcePosition: (d) => [d.sx, d.sy, d.sCost * zFactor],
        getTargetPosition: (d) => [d.tx, d.ty, d.tCost * zFactor],
        getColor: (d) => tintByHeight(r.accent, d.tCost / r.maxCost, 150),
        getWidth: 1.5,
        widthUnits: "pixels",
        updateTriggers: {
          getSourcePosition: zFactor,
          getTargetPosition: zFactor,
          getColor: [r.accent, r.maxCost],
        },
        ...reveal(filterRange),
      }),
    );

    // Settled nodes: faint dots resting on the cost surface.
    layers.push(
      new ScatterplotLayer<NodeDatum>({
        id: "settled",
        data: r.nodeData,
        opacity: op,
        getPosition: (d) => [d.x, d.y, d.cost * zFactor],
        getFillColor: rgba(r.accent, 60),
        getRadius: 1.5,
        radiusUnits: "pixels",
        updateTriggers: { getPosition: zFactor, getFillColor: r.accent },
        ...reveal(filterRange),
      }),
    );

    // Final route ribbon: bright, elevated, drawn on top of the surface.
    if (r.pathPts.length >= 2 && r.pathReveal > 0) {
      const count = Math.max(2, Math.ceil(r.pathReveal * r.pathPts.length));
      const coords = r.pathPts
        .slice(0, count)
        .map((p) => [p.x, p.y, p.cost * zFactor] as [number, number, number]);
      const pathData = [{ path: coords }];
      layers.push(
        new PathLayer<{ path: [number, number, number][] }>({
          id: "route-glow",
          data: pathData,
          opacity: op,
          getPath: (d) => d.path,
          getColor: rgba(PATH_COLOR, 60),
          getWidth: 8,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getPath: [count, zFactor] },
        }),
        new PathLayer<{ path: [number, number, number][] }>({
          id: "route-core",
          data: pathData,
          opacity: op,
          getPath: (d) => d.path,
          getColor: rgba(PATH_COLOR, 255),
          getWidth: 3,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getPath: [count, zFactor] },
        }),
      );
    }
  }

  // 4. ENDPOINTS — markers + the only two labels in the whole scene.
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
