import { useEffect, useMemo, useState } from "react";
import MapView from "./map/MapView";
import {
  buildLayers,
  type RoadEdge,
  type EdgeDatum,
  type NodeDatum,
  type ArcDatum,
  type PathPt,
} from "./map/layers";
import ControlPanel, { type Mode } from "./ui/ControlPanel";
import Metrics from "./ui/Metrics";
import StageTimeline, { type StageStatus } from "./ui/StageTimeline";
import CompareCard from "./ui/CompareCard";
import Intro from "./ui/Intro";
import { STAGES, isLocked } from "./stages";
import { type QuickRoute } from "./places";
import {
  Graph,
  nearestNode,
  CHData,
  CHPathfinder,
  type GraphJSON,
  type CHGraphJSON,
  type LngLat,
  type PathResult,
  type Pathfinder,
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
const CH_STAGE = 2; // Stage 3 index

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [water, setWater] = useState<number[][][]>([]);
  const [chPathfinder, setChPathfinder] = useState<CHPathfinder | null>(null);

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
  const [focus, setFocus] = useState<{ coord: [number, number]; token: number } | null>(null);
  const [framePath, setFramePath] = useState<
    { min: [number, number]; max: [number, number]; token: number } | null
  >(null);
  const [showCompare, setShowCompare] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [pulse, setPulse] = useState(0);

  // Dissolve the intro title card after its animation finishes.
  useEffect(() => {
    const t = window.setTimeout(() => setShowIntro(false), 3000);
    return () => window.clearTimeout(t);
  }, []);

  const chReady = chPathfinder !== null;

  /** Stage 3's engine is supplied at runtime; others are static in STAGES. */
  function pathfinderFor(stageIndex: number): Pathfinder | null {
    if (stageIndex === CH_STAGE) return chPathfinder;
    return STAGES[stageIndex].pathfinder;
  }

  // --- Load graph + optional water + CH cache --------------------------------
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    fetch(base + "bengaluru-graph.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GraphJSON>;
      })
      .then((json) => setGraph(Graph.fromJSON(json)))
      .catch((e) => setLoadError(String(e)));

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

    // CH cache is optional: Stage 3 unlocks only once it has loaded.
    fetch(base + "bengaluru-ch.json")
      .then((r) => (r.ok ? (r.json() as Promise<CHGraphJSON>) : null))
      .then((json) => {
        if (json?.level && json.edges) {
          setChPathfinder(new CHPathfinder(CHData.fromJSON(json)));
        }
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
  const isCH = currentStage === CH_STAGE;
  const precomp = useMemo(() => {
    if (!result || !graph) return null;
    const edgeData: EdgeDatum[] = [];
    const nodeData: NodeDatum[] = [];
    const arcData: ArcDatum[] = [];
    // cumulative counters that exclude the CH hierarchy beat (dir === 2), so the
    // HUD reports genuine search work in every stage.
    const searchNodesCum: number[] = [0];
    const searchEdgesCum: number[] = [0];
    let maxCost = 0;

    result.log.forEach((s, stepIndex) => {
      const [nx, ny] = graph.coords[s.node];
      nodeData.push({ x: nx, y: ny, cost: s.cost, step: stepIndex, dir: s.dir });
      if (s.cost > maxCost) maxCost = s.cost;

      let frontierAdded = 0;
      for (const e of s.edges) {
        if (e.toCost > maxCost) maxCost = e.toCost;
        const [sx, sy] = graph.coords[e.from];
        const [tx, ty] = graph.coords[e.to];
        if (s.dir === 2) {
          if (e.from !== e.to)
            arcData.push({ sx, sy, sCost: s.cost, tx, ty, tCost: e.toCost, step: stepIndex });
        } else {
          edgeData.push({ sx, sy, sCost: s.cost, tx, ty, tCost: e.toCost, step: stepIndex, dir: s.dir });
          frontierAdded++;
        }
      }
      const nNodes = searchNodesCum[searchNodesCum.length - 1] + (s.dir === 2 ? 0 : 1);
      searchNodesCum.push(nNodes);
      searchEdgesCum.push(searchEdgesCum[searchEdgesCum.length - 1] + frontierAdded);
    });

    const costByNode = new Map<number, number>();
    for (const s of result.log) costByNode.set(s.node, s.cost);
    const pathPts: PathPt[] = result.path.map((id) => {
      const [x, y] = graph.coords[id];
      return { x, y, cost: costByNode.get(id) ?? 0 };
    });

    return { edgeData, nodeData, arcData, pathPts, searchNodesCum, searchEdgesCum, maxCost };
  }, [result, graph]);

  const logLen = result?.log.length ?? 0;
  const pathLen = precomp?.pathPts.length ?? 0;

  // --- Animation loop --------------------------------------------------------
  useEffect(() => {
    if (!result || (phase !== "playing" && phase !== "in" && phase !== "out")) return;
    let raf = 0;
    const retractStep = Math.max(2000, Math.ceil(logLen / 30));
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

  // Flowing pulse of light travelling along the finished route (loops).
  useEffect(() => {
    if (phase !== "done" || pathLen < 2) return;
    let raf = 0;
    const tick = () => {
      setPulse((p) => (p + 0.004) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, pathLen]);

  // Phase transitions driven by the clock.
  useEffect(() => {
    if (phase === "out" && anim.revealStep <= 0) {
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
      // Compare card: after A* (2-up) and again after CH (3-up).
      if (currentStage === 1 && results[0] && results[1]) setShowCompare(true);
      if (currentStage === CH_STAGE && results[0] && results[1] && results[2])
        setShowCompare(true);
      // Zoom into the finished route so it reads clearly.
      const rr = results[currentStage];
      if (rr && rr.path.length >= 2 && graph) {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const id of rr.path) {
          const [lng, lat] = graph.coords[id];
          if (lng < a) a = lng;
          if (lat < b) b = lat;
          if (lng > c) c = lng;
          if (lat > d) d = lat;
        }
        setFramePath({ min: [a, b], max: [c, d], token: Date.now() });
      }
    }
  }, [phase, anim, logLen, pathLen, currentStage, results, graph]);

  // --- Actions ---------------------------------------------------------------
  function resetBuild() {
    setResults({});
    setCurrentStage(0);
    setPhase("idle");
    setAnim({ revealStep: 0, pathReveal: 0 });
    setShowCompare(false);
  }

  function play(stageIndex: number, s: number, d: number, prev: Record<number, PathResult>) {
    const pf = pathfinderFor(stageIndex);
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
    if (STAGES[next].needsCH && !chReady) return;
    if (sourceId == null || destId == null) return;
    const pf = pathfinderFor(next);
    if (!pf) return;
    const res = pf.findPath(graph, sourceId, destId);
    setResults((r) => ({ ...r, [next]: res }));
    setShowCompare(false);
    setPhase("out");
    // Cinematic: re-frame the route as the model reforms into the next stage.
    setFrameRoute({
      source: graph.coords[sourceId],
      dest: graph.coords[destId],
      token: Date.now(),
    });
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
    // Cinematic punch-in to the point just chosen.
    setFocus({ coord: graph.coords[id] as [number, number], token: Date.now() });
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
    play(0, s, d, {});
  }

  function handleReset() {
    resetBuild();
    setSourceId(null);
    setDestId(null);
    setSourceLabel("");
    setDestLabel("");
    setMode("source");
    setFrameRoute(null);
    setFocus(null);
    setFramePath(null);
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
            arcData: precomp.arcData,
            pathPts: precomp.pathPts,
            maxCost: precomp.maxCost,
            revealStep: Math.min(Math.max(0, anim.revealStep), logLen),
            pathReveal: anim.pathReveal,
            opacity: 1,
            accent: stage.accent,
            chMode: isCH,
            pulse,
            meetPoint:
              isCH && result.meetNode != null
                ? (graph.coords[result.meetNode] as [number, number])
                : null,
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
    isCH,
    pulse,
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
    if (s.needsCH && !chReady) return "locked"; // Stage 3 before the cache loads
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

  const shortAlgo = (a: string) => (a === "Contraction Hierarchies" ? "CH" : a);

  if (busy) {
    primaryLabel = phase === "out" || phase === "in" ? "Reforming…" : "Building…";
    primaryEnabled = false;
    onPrimary = () => {};
  } else if (phase === "done") {
    const next = currentStage + 1;
    const nextAvailable =
      next < STAGES.length &&
      !isLocked(STAGES[next]) &&
      (!STAGES[next].needsCH || chReady);
    if (nextAvailable) {
      primaryLabel = `Next → ${shortAlgo(STAGES[next].algo)}`;
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
      <MapView
        layers={layers}
        frameRoute={frameRoute}
        focus={focus}
        framePath={framePath}
        onMapClick={handleMapClick}
      />
      <div className="stage-vignette" />

      {phase === "idle" && (
        <div
          className="select-hint"
          style={{ ["--sel-color" as string]: mode === "source" ? "#46f08c" : "#ff5f8c" }}
        >
          <span className="sel-dot" /> Click the model to place{" "}
          <b>{mode === "source" ? "source" : "destination"}</b> · scroll to zoom
        </div>
      )}

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
        nodesExplored={precomp ? precomp.searchNodesCum[k] : 0}
        edgesRelaxed={precomp ? precomp.searchEdgesCum[k] : 0}
        distanceKm={distanceKm}
        computeTimeMs={result ? result.stats.computeTimeMs : null}
        totalNodes={graph.nodeCount}
      />

      {showCompare && results[0] && results[1] && (
        <CompareCard
          dijkstra={results[0].stats}
          astar={results[1].stats}
          ch={results[2]?.stats ?? null}
          onClose={() => setShowCompare(false)}
        />
      )}

      {showIntro && <Intro />}
    </>
  );
}
