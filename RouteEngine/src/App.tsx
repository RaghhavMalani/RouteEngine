import { useEffect, useMemo, useState } from "react";
import MapView from "./map/MapView";
import {
  buildLayers,
  type RoadEdge,
  type EdgeDatum,
  type NodeDatum,
  type PathPt,
} from "./map/layers";
import ControlPanel, { type Mode } from "./ui/ControlPanel";
import Metrics from "./ui/Metrics";
import StageTimeline, { type StageStatus } from "./ui/StageTimeline";
import CompareCard from "./ui/CompareCard";
import { STAGES, isLocked } from "./stages";
import { type QuickRoute } from "./places";
import {
  Graph,
  nearestNode,
  type GraphJSON,
  type LngLat,
  type PathResult,
} from "./engine/pathfinder";

/** Phase of the staged build. */
type Phase = "idle" | "playing" | "out" | "in" | "done";

interface AnimState {
  revealStep: number;
  pathReveal: number;
}

interface FrameRoute {
  source: [number, number];
  dest: [number, number];
  token: number;
}

const fmtCoord = (c: LngLat) => `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`;

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [water, setWater] = useState<number[][][]>([]);

  const [mode, setMode] = useState<Mode>("source");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [destId, setDestId] = useState<number | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [destLabel, setDestLabel] = useState("");

  const [speed, setSpeed] = useState(60);
  const [currentStage, setCurrentStage] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<Record<number, PathResult>>({});
  const [anim, setAnim] = useState<AnimState>({ revealStep: 0, pathReveal: 0 });
  const [frameRoute, setFrameRoute] = useState<FrameRoute | null>(null);
  const [showCompare, setShowCompare] = useState(false);

  // --- Load graph + optional water ------------------------------------------
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    fetch(base + "bengaluru-graph.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GraphJSON>;
      })
      .then((json) => setGraph(Graph.fromJSON(json)))
      .catch((e) => setLoadError(String(e)));

    // Water is optional context; the app works without it (run scripts/build-water).
    fetch(base + "bengaluru-water.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((gj) => {
        if (!gj?.features) return;
        const polys: number[][][] = [];
        for (const f of gj.features) {
          const g = f.geometry;
          if (!g) continue;
          if (g.type === "Polygon") polys.push(g.coordinates[0]);
          else if (g.type === "MultiPolygon")
            for (const p of g.coordinates) polys.push(p[0]);
        }
        setWater(polys);
      })
      .catch(() => {});
  }, []);

  // --- Static road model (built once) ----------------------------------------
  const roadEdges = useMemo<RoadEdge[]>(() => {
    if (!graph) return [];
    const out: RoadEdge[] = [];
    for (let u = 0; u < graph.nodeCount; u++) {
      for (const e of graph.adj[u]) {
        if (u < e.to) {
          const [sx, sy] = graph.coords[u];
          const [tx, ty] = graph.coords[e.to];
          out.push({ sx, sy, tx, ty });
        }
      }
    }
    return out;
  }, [graph]);

  // --- Precompute the active stage's drawable geometry (once per stage) -------
  const result = results[currentStage] ?? null;
  const precomp = useMemo(() => {
    if (!result || !graph) return null;
    const edgeData: EdgeDatum[] = [];
    const nodeData: NodeDatum[] = [];
    const cumulative: number[] = [0];
    let maxCost = 0;

    result.log.forEach((s, stepIndex) => {
      const [nx, ny] = graph.coords[s.node];
      nodeData.push({ x: nx, y: ny, cost: s.cost, step: stepIndex });
      if (s.cost > maxCost) maxCost = s.cost;
      for (const e of s.edges) {
        const [sx, sy] = graph.coords[e.from];
        const [tx, ty] = graph.coords[e.to];
        edgeData.push({ sx, sy, sCost: s.cost, tx, ty, tCost: e.toCost, step: stepIndex });
        if (e.toCost > maxCost) maxCost = e.toCost;
      }
      cumulative.push(edgeData.length);
    });

    const costByNode = new Map<number, number>();
    for (const s of result.log) costByNode.set(s.node, s.cost);
    const pathPts: PathPt[] = result.path.map((id) => {
      const [x, y] = graph.coords[id];
      return { x, y, cost: costByNode.get(id) ?? 0 };
    });

    return { edgeData, nodeData, pathPts, cumulative, maxCost };
  }, [result, graph]);

  const logLen = result?.log.length ?? 0;
  const pathLen = precomp?.pathPts.length ?? 0;

  // --- Animation loop --------------------------------------------------------
  // playing / in  → grow the reveal; out → retract it. The transition (out→in)
  // is what makes the model "reform" from Dijkstra's flood into A*'s beam.
  useEffect(() => {
    if (!result || (phase !== "playing" && phase !== "in" && phase !== "out")) return;
    let raf = 0;
    const retractStep = Math.max(2000, Math.ceil(logLen / 30)); // ~0.5s retract
    const growStep = phase === "in" ? Math.max(speed, Math.ceil(logLen / 42)) : speed;
    const pathInc = phase === "in" ? 0.12 : 0.04 * (0.5 + speed / 120);

    const tick = () => {
      setAnim((prev) => {
        if (phase === "out") {
          return {
            revealStep: Math.max(0, prev.revealStep - retractStep),
            pathReveal: Math.max(0, prev.pathReveal - 0.12),
          };
        }
        if (prev.revealStep < logLen) {
          return { ...prev, revealStep: Math.min(logLen, prev.revealStep + growStep) };
        }
        if (pathLen >= 2 && prev.pathReveal < 1) {
          return { ...prev, pathReveal: Math.min(1, prev.pathReveal + pathInc) };
        }
        return prev;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, result, speed, logLen, pathLen]);

  // Phase transitions driven by the clock.
  useEffect(() => {
    if (phase === "out" && anim.revealStep <= 0) {
      // Retract complete → swap to the next stage and regrow it.
      setCurrentStage((c) => c + 1);
      setAnim({ revealStep: 0, pathReveal: 0 });
      setPhase("in");
      return;
    }
    if (
      (phase === "playing" || phase === "in") &&
      anim.revealStep >= logLen &&
      (pathLen < 2 || anim.pathReveal >= 1)
    ) {
      setPhase("done");
      // Compare card appears once A* (stage index 1) has finished playing.
      if (currentStage === 1 && results[0] && results[1]) setShowCompare(true);
    }
  }, [phase, anim, logLen, pathLen, currentStage, results]);

  // --- Actions ---------------------------------------------------------------
  function resetBuild() {
    setResults({});
    setCurrentStage(0);
    setPhase("idle");
    setAnim({ revealStep: 0, pathReveal: 0 });
    setShowCompare(false);
  }

  function play(stageIndex: number, s: number, d: number, prev: Record<number, PathResult>) {
    const pf = STAGES[stageIndex].pathfinder;
    if (!pf || !graph) return;
    const res = pf.findPath(graph, s, d);
    setResults({ ...prev, [stageIndex]: res });
    setCurrentStage(stageIndex);
    setAnim({ revealStep: 0, pathReveal: 0 });
    setShowCompare(false);
    setPhase("playing");
    setFrameRoute({ source: graph.coords[s], dest: graph.coords[d], token: Date.now() });
  }

  function handleBuild() {
    if (sourceId == null || destId == null || !graph) return;
    play(0, sourceId, destId, {});
  }

  function handleNext() {
    const next = currentStage + 1;
    if (next >= STAGES.length || isLocked(STAGES[next]) || !graph) return;
    if (sourceId == null || destId == null) return;
    // Compute the next stage now (same route), then retract → swap → regrow.
    const res = STAGES[next].pathfinder!.findPath(graph, sourceId, destId);
    setResults((r) => ({ ...r, [next]: res }));
    setShowCompare(false);
    setPhase("out");
  }

  function handleReplay() {
    if (!result) return;
    setAnim({ revealStep: 0, pathReveal: 0 });
    setShowCompare(false);
    setPhase("playing");
  }

  function handleMapClick(lng: number, lat: number) {
    if (!graph) return;
    const id = nearestNode(graph, lng, lat);
    const label = fmtCoord(graph.coords[id]);
    resetBuild();
    if (mode === "source") {
      setSourceId(id);
      setSourceLabel(label);
      setMode("destination");
    } else {
      setDestId(id);
      setDestLabel(label);
    }
  }

  function handleQuickRoute(route: QuickRoute) {
    if (!graph) return;
    const s = nearestNode(graph, route.from.coord[0], route.from.coord[1]);
    const d = nearestNode(graph, route.to.coord[0], route.to.coord[1]);
    setSourceId(s);
    setDestId(d);
    setSourceLabel(route.from.name);
    setDestLabel(route.to.name);
    setMode("source");
    play(0, s, d, {}); // instant demo: set endpoints and build Stage 1
  }

  function handleReset() {
    resetBuild();
    setSourceId(null);
    setDestId(null);
    setSourceLabel("");
    setDestLabel("");
    setMode("source");
    setFrameRoute(null);
  }

  // --- Build layers ----------------------------------------------------------
  const layers = useMemo(() => {
    if (!graph) return [];
    const stage = STAGES[currentStage];
    const render =
      precomp && result
        ? {
            edgeData: precomp.edgeData,
            nodeData: precomp.nodeData,
            pathPts: precomp.pathPts,
            maxCost: precomp.maxCost,
            revealStep: Math.min(Math.max(0, anim.revealStep), logLen),
            pathReveal: anim.pathReveal,
            opacity: 1,
            accent: stage.accent,
          }
        : null;

    return buildLayers({
      roadEdges,
      render,
      water,
      source: sourceId != null ? graph.coords[sourceId] : null,
      destination: destId != null ? graph.coords[destId] : null,
      sourceLabel,
      destLabel,
    });
  }, [
    graph,
    roadEdges,
    water,
    precomp,
    result,
    anim,
    logLen,
    currentStage,
    sourceId,
    destId,
    sourceLabel,
    destLabel,
  ]);

  // --- Derived UI values -----------------------------------------------------
  const k = Math.min(Math.max(0, Math.round(anim.revealStep)), logLen);
  const stage = STAGES[currentStage];
  const distanceKm =
    result && result.path.length > 0 && phase === "done"
      ? result.stats.pathLengthMeters / 1000
      : null;

  const statuses: StageStatus[] = STAGES.map((s, i) => {
    if (isLocked(s)) return "locked";
    if (i < currentStage) return "done";
    if (i === currentStage)
      return phase === "done" ? "done" : phase === "idle" ? "available" : "active";
    return "available";
  });

  const busy = phase === "playing" || phase === "out" || phase === "in";
  let primaryLabel = "Build";
  let primaryEnabled = false;
  let onPrimary = handleBuild;
  let hint: string | null = null;

  if (busy) {
    primaryLabel = phase === "out" || phase === "in" ? "Reforming…" : "Building…";
    primaryEnabled = false;
    onPrimary = () => {};
  } else if (phase === "done") {
    const next = currentStage + 1;
    if (next < STAGES.length && !isLocked(STAGES[next])) {
      primaryLabel = `Next → ${STAGES[next].algo}`;
      primaryEnabled = true;
      onPrimary = handleNext;
    } else {
      primaryLabel = "Replay";
      primaryEnabled = true;
      onPrimary = handleReplay;
      if (next < STAGES.length)
        hint = `${STAGES[next].model} · ${STAGES[next].algo} — coming next`;
    }
  } else {
    // idle
    primaryLabel = "Build";
    primaryEnabled = sourceId != null && destId != null;
    onPrimary = handleBuild;
  }

  // --- Render ----------------------------------------------------------------
  if (loadError || !graph) {
    return (
      <div className="loading">
        {loadError ? (
          <div className="err">
            <p>Couldn't load <code>public/bengaluru-graph.json</code>.</p>
            <p>Build it with <code>npm run build-graph</code>, then refresh.</p>
            <p style={{ opacity: 0.6, fontSize: 12 }}>({loadError})</p>
          </div>
        ) : (
          <p>Loading Bengaluru road model…</p>
        )}
      </div>
    );
  }

  return (
    <>
      <MapView layers={layers} frameRoute={frameRoute} onMapClick={handleMapClick} />
      <div className="stage-vignette" />

      <ControlPanel
        mode={mode}
        onModeChange={setMode}
        sourceLabel={sourceLabel || "Not set"}
        destLabel={destLabel || "Not set"}
        speed={speed}
        onSpeedChange={setSpeed}
        onQuickRoute={handleQuickRoute}
        primaryLabel={primaryLabel}
        primaryEnabled={primaryEnabled}
        onPrimary={onPrimary}
        onReset={handleReset}
        hint={hint}
      />

      <StageTimeline statuses={statuses} />

      <Metrics
        stageModel={result ? stage.model : null}
        stageName={result ? stage.name : null}
        algo={result ? stage.algo : null}
        accent={stage.accent}
        nodesExplored={k}
        edgesRelaxed={precomp ? precomp.cumulative[k] : 0}
        distanceKm={distanceKm}
        computeTimeMs={result ? result.stats.computeTimeMs : null}
        totalNodes={graph.nodeCount}
      />

      {showCompare && results[0] && results[1] && (
        <CompareCard
          dijkstra={results[0].stats}
          astar={results[1].stats}
          onClose={() => setShowCompare(false)}
        />
      )}
    </>
  );
}
