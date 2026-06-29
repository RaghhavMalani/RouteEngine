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
import RouteCard from "./ui/RouteCard";
import { STAGES, isLocked } from "./stages";
import { QUICK_ROUTES, type QuickRoute } from "./places";
import { estimateRoute, conditionNow, isArterialClass, type TrafficCondition } from "./engine/eta";
import { fastestRoute } from "./engine/fastest";
import {
  TrafficModel,
  trafficRoute,
  congestionAt,
  edgeKey,
} from "./engine/traffic";
import { haversine } from "./engine/geo";
import TrafficPanel from "./ui/TrafficPanel";
import ModeSwitch from "./ui/ModeSwitch";
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

/** One arterial segment for the Phase-5 congestion overlay (with routing keys). */
interface Arterial {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  mx: number;
  my: number;
  u: number;
  v: number;
  hw: string;
}

/** The route the vehicle is currently driving, with cumulative distances. */
interface Journey {
  path: number[];
  coords: [number, number][];
  cum: number[]; // cum[i] = metres from start to vertex i
  total: number;
}

/** Interpolate the vehicle's position (and which segment it's on) at `m` metres. */
function posAt(j: Journey, m: number): { coord: [number, number]; segIndex: number } {
  const mm = Math.min(Math.max(0, m), j.total);
  let i = 0;
  while (i < j.cum.length - 2 && j.cum[i + 1] < mm) i++;
  const segLen = j.cum[i + 1] - j.cum[i] || 1;
  const t = (mm - j.cum[i]) / segLen;
  const a = j.coords[i];
  const b = j.coords[i + 1];
  return { coord: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], segIndex: i };
}

const fmtCoord = (c: LngLat) => `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`;
const CH_STAGE = 2; // Stage 3 index
const PRESENT_STAGE = 3; // Stage 4 index — the clean "what you actually see" view

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

  const [speed, setSpeed] = useState(22);
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
  const [demoMode, setDemoMode] = useState(false);
  const [punchToken, setPunchToken] = useState(0); // bump to (re)reveal the punchline
  const [condition, setCondition] = useState<TrafficCondition>(() => conditionNow());
  const [routeMode, setRouteMode] = useState<"shortest" | "fastest">("shortest");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  // --- Phase 5: Traffic mode (separate from the staged sequence) --------------
  const [appMode, setAppMode] = useState<"sequence" | "traffic">("sequence");
  const [hour, setHour] = useState(9); // time-of-day 0..23
  const [trafficMetric, setTrafficMetric] = useState<"time" | "distance">("time");
  const [closures, setClosures] = useState<string[]>([]); // blocked edge keys
  const trafficMode = appMode === "traffic";

  // Slice B — the driving vehicle + live rerouting.
  const [journey, setJourney] = useState<Journey | null>(null);
  const [progressM, setProgressM] = useState(0);
  const [driving, setDriving] = useState(false);
  const [rerouteMs, setRerouteMs] = useState<number | null>(null);
  const [oldRouteCoords, setOldRouteCoords] = useState<[number, number][] | null>(null);

  // Dissolve the intro title card after its animation finishes.
  useEffect(() => {
    const t = window.setTimeout(() => setShowIntro(false), 3000);
    return () => window.clearTimeout(t);
  }, []);

  // Tag <body> with the active mode so mobile CSS can lay out Traffic differently.
  useEffect(() => {
    document.body.classList.toggle("traffic-mode", appMode === "traffic");
    return () => document.body.classList.remove("traffic-mode");
  }, [appMode]);

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
    // Draw each physical road once. Two-way edges exist both ways → draw when
    // u < to. One-way edges have no reverse → draw regardless of node order.
    for (let u = 0; u < graph.nodeCount; u++) {
      for (const e of graph.adj[u]) {
        if (u < e.to || e.oneway) {
          const [sx, sy] = graph.coords[u];
          const [tx, ty] = graph.coords[e.to];
          out.push({ sx, sy, tx, ty });
        }
      }
    }
    return out;
  }, [graph]);

  // --- Phase 5: arterial overlay geometry (built once) -----------------------
  const arterials = useMemo<Arterial[]>(() => {
    if (!graph) return [];
    const out: Arterial[] = [];
    for (let u = 0; u < graph.nodeCount; u++) {
      for (const e of graph.adj[u]) {
        if (!isArterialClass(e.highway)) continue;
        if (!(u < e.to || e.oneway)) continue; // draw each physical road once
        const [sx, sy] = graph.coords[u];
        const [tx, ty] = graph.coords[e.to];
        out.push({ sx, sy, tx, ty, mx: (sx + tx) / 2, my: (sy + ty) / 2, u, v: e.to, hw: e.highway });
      }
    }
    return out;
  }, [graph]);

  const closureSet = useMemo(() => new Set(closures), [closures]);

  // Per-arterial congestion level for the current hour (recomputed on slider move).
  const congestionLevels = useMemo(() => {
    const lv = new Uint8Array(arterials.length);
    for (let i = 0; i < arterials.length; i++) {
      const a = arterials[i];
      lv[i] =
        closureSet.has(edgeKey(a.u, a.v)) || closureSet.has(edgeKey(a.v, a.u))
          ? 3
          : congestionAt(a.hw, hour, a.mx, a.my);
    }
    return lv;
  }, [arterials, hour, closureSet]);

  // Live traffic model + both candidate routes (time-optimal vs distance-optimal).
  const trafficModelObj = useMemo(() => new TrafficModel(hour, closures), [hour, closures]);
  const trafficRoutes = useMemo(() => {
    if (!graph || !trafficMode || sourceId == null || destId == null) return null;
    const byTime = trafficRoute(graph, sourceId, destId, trafficModelObj, true);
    const byDist = trafficRoute(graph, sourceId, destId, trafficModelObj, false);
    return { byTime, byDist };
  }, [graph, trafficMode, sourceId, destId, trafficModelObj]);

  // Build a drivable Journey (with cumulative distances) from a node path.
  const buildJourney = (path: number[]): Journey | null => {
    if (!graph || path.length < 2) return null;
    const coords = path.map((id) => graph.coords[id] as [number, number]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    return { path, coords, cum, total: cum[cum.length - 1] };
  };

  // The vehicle's live position along its current journey.
  const vehicle = useMemo(
    () => (journey ? posAt(journey, progressM) : null),
    [journey, progressM],
  );

  // Drive loop: advance the vehicle along the journey while "driving".
  useEffect(() => {
    if (!driving || !journey) return;
    let raf = 0;
    let last = performance.now();
    const SIM_MPS = 360; // simulated metres/second (a brisk fast-forward)
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setProgressM((p) => {
        const np = p + SIM_MPS * dt;
        if (np >= journey.total) {
          setDriving(false);
          return journey.total;
        }
        return np;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [driving, journey]);

  // Leaving Traffic mode or changing endpoints resets the drive.
  useEffect(() => {
    setJourney(null);
    setProgressM(0);
    setDriving(false);
    setClosures([]);
    setOldRouteCoords(null);
    setRerouteMs(null);
  }, [sourceId, destId, appMode]);

  function handleStartDrive() {
    if (!trafficRoutes) return;
    const r = trafficMetric === "time" ? trafficRoutes.byTime : trafficRoutes.byDist;
    const j = buildJourney(r.path);
    if (!j) return;
    setJourney(j);
    setProgressM(0);
    setOldRouteCoords(null);
    setRerouteMs(null);
    setDriving(true);
  }

  function handleToggleDrive() {
    if (!journey) handleStartDrive();
    else setDriving((d) => !d);
  }

  /** Close a road just ahead of the vehicle and reroute from its current position. */
  function handleInject() {
    if (!graph || !journey || destId == null) return;
    const { segIndex } = posAt(journey, progressM);
    const fromIdx = Math.min(journey.path.length - 1, segIndex + 1); // next vertex ahead
    const closeIdx = segIndex + 3; // an edge further down the road
    if (closeIdx >= journey.path.length - 1 || fromIdx >= journey.path.length - 1) return;
    const a = journey.path[closeIdx];
    const b = journey.path[closeIdx + 1];
    const fromNode = journey.path[fromIdx];
    const nextClosures = [...closures, edgeKey(a, b)];
    setClosures(nextClosures);

    const model = new TrafficModel(hour, nextClosures);
    const t0 = performance.now();
    const re = trafficRoute(graph, fromNode, destId, model, trafficMetric === "time");
    setRerouteMs(performance.now() - t0);
    if (re.path.length < 2) return;

    // Keep the already-driven prefix (through fromNode), then splice on the new route.
    const prefix = journey.path.slice(0, fromIdx + 1);
    const newPath = [...prefix, ...re.path.slice(1)];
    setOldRouteCoords(journey.coords);
    const nj = buildJourney(newPath);
    if (nj) setJourney(nj); // progressM stays valid — prefix distances are unchanged
    setDriving(true);
    window.setTimeout(() => setOldRouteCoords(null), 3200);
  }

  function handleClearIncidents() {
    setClosures([]);
    setOldRouteCoords(null);
    setRerouteMs(null);
  }

  // --- Precompute the active stage's drawable geometry (once per stage) -------
  const isCH = currentStage === CH_STAGE;
  const presentation = currentStage === PRESENT_STAGE;

  // Stage 4: the FASTEST (time-optimal) route for the current condition, computed
  // live. Distinct from the CH shortest-distance route — at peak it avoids clogged
  // arterials and is genuinely a different line.
  const fastestRes = useMemo(() => {
    if (!graph || !presentation || sourceId == null || destId == null) return null;
    return fastestRoute(graph, sourceId, destId, condition);
  }, [graph, presentation, sourceId, destId, condition]);

  // Stage 4 keeps NO result of its own — it derives the route from the CH result
  // (shortest) or the live fastest result, by mode, so the Stage-4 view and "Show
  // what really happened" can never disagree.
  const result = useMemo<PathResult | null>(() => {
    if (presentation) {
      const ch = results[CH_STAGE];
      if (!ch) return null;
      const path =
        routeMode === "fastest" && fastestRes && fastestRes.path.length > 1
          ? fastestRes.path
          : ch.path;
      return { path, log: [], stats: ch.stats, meetNode: ch.meetNode };
    }
    return results[currentStage] ?? null;
  }, [presentation, results, currentStage, routeMode, fastestRes]);
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

  // Stage 4 ETAs under the selected condition: the shortest-distance (CH) route
  // AND the fastest-time route, so the card shows both and the chosen one.
  const shortEst = useMemo(() => {
    const ch = results[CH_STAGE];
    if (!graph || !presentation || !ch || ch.path.length < 2) return null;
    return estimateRoute(graph, ch.path, condition);
  }, [graph, presentation, results, condition]);
  const fastEst = useMemo(() => {
    if (!graph || !presentation || !fastestRes || fastestRes.path.length < 2) return null;
    return estimateRoute(graph, fastestRes.path, condition);
  }, [graph, presentation, fastestRes, condition]);
  const routeEstimate = routeMode === "fastest" ? fastEst ?? shortEst : shortEst;

  // --- Animation loop --------------------------------------------------------
  useEffect(() => {
    if (!result || (phase !== "playing" && phase !== "in" && phase !== "out")) return;
    let raf = 0;
    const retractStep = Math.max(2000, Math.ceil(logLen / 30));
    // Dijkstra & co. use the flat deployed pacing: `speed` nodes/frame, so the
    // wide flood unrolls slowly and dramatically. A* (stage 1) visits so few nodes
    // that a flat rate empties its short log almost instantly — so instead we
    // stretch A*'s reveal across a fixed, deliberate DURATION (~5s at default
    // speed), making the guided beam crawl outward clearly.
    // NOTE on phases: the FIRST stage (Dijkstra) reveals during "playing"; every
    // later stage (A*, CH) advances out→in→done and reveals during "in". So a rate
    // that only touches "playing" never affects A*. A* is handled FIRST below, for
    // every phase, so its slow crawl always applies.
    // A* (stage 1) AND CH (stage 2) both advance via the "in" phase and visit far
    // fewer nodes than Dijkstra's flood, so any speed-tied rate empties their logs
    // in a blink. Lock BOTH to a fixed, deliberate crawl (~11s at 60fps), in every
    // phase, that the speed slider can NOT override. Dijkstra keeps its flat flood.
    const slowCrawl = currentStage === 1 || currentStage === CH_STAGE;
    const growStep = slowCrawl
      ? Math.max(1, Math.ceil(logLen / 540))
      : phase === "in"
        ? Math.max(speed, Math.ceil(logLen / 42))
        : speed;
    // Stage 4 draws its single clean route on gently (product-grade); the
    // technical stages reveal their path faster behind the search.
    const pathInc = presentation ? 0.02 : phase === "in" ? 0.12 : 0.04 * (0.5 + speed / 120);

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
  }, [phase, result, speed, logLen, pathLen, presentation, currentStage]);

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
      // Stage 4 settled → reveal the punchline once.
      if (currentStage === PRESENT_STAGE) setPunchToken(Date.now());
      // Zoom into the finished route so it reads clearly.
      const rr = result;
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
  }, [phase, anim, logLen, pathLen, currentStage, results, graph, result]);

  // Demo Mode: once a stage settles, pause to let the viewer read, then auto-
  // advance to the next stage — all the way to Stage 4. No manual clicks.
  useEffect(() => {
    if (!demoMode || phase !== "done") return;
    if (currentStage >= PRESENT_STAGE) return; // reached the clean view → stop
    const t = window.setTimeout(() => handleNext(), 2800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, phase, currentStage]);

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
    setDemoMode(false);
    play(0, sourceId, destId, {});
  }

  function handleNext() {
    const next = currentStage + 1;
    if (next >= STAGES.length || isLocked(STAGES[next]) || !graph) return;
    if (STAGES[next].needsCH && !chReady) return;
    if (sourceId == null || destId == null) return;
    // Stage 4 (presentation): no search of its own — the route is derived live
    // from the CH result (see `result` above), so we only drive the transition.
    if (STAGES[next].presentation) {
      if (!results[CH_STAGE]) return;
      setShowCompare(false);
      setPhase("out");
      setFrameRoute({
        source: graph.coords[sourceId],
        dest: graph.coords[destId],
        token: Date.now(),
      });
      return;
    }
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
    setDemoMode(false); // manual interaction exits Demo Mode
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
    setDemoMode(false);
    const s = nearestNode(graph, route.from.coord[0], route.from.coord[1]);
    const d = nearestNode(graph, route.to.coord[0], route.to.coord[1]);
    setSourceId(s);
    setDestId(d);
    setSourceLabel(route.from.name);
    setDestLabel(route.to.name);
    setMode("source");
    play(0, s, d, {});
  }

  /** Slice C: one-click "shorter-but-slower" teaching scenario at the morning peak. */
  function handleScenario() {
    if (!graph) return;
    const route = QUICK_ROUTES[1]; // Koramangala → Manyata Tech Park (strong peak contrast)
    const s = nearestNode(graph, route.from.coord[0], route.from.coord[1]);
    const d = nearestNode(graph, route.to.coord[0], route.to.coord[1]);
    setSourceId(s);
    setDestId(d);
    setSourceLabel(route.from.name);
    setDestLabel(route.to.name);
    setHour(9); // morning peak — arterials clog, the longer route wins on time
    setTrafficMetric("time");
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
    setDemoMode(false);
    setPunchToken(0);
    setRouteMode("shortest");
  }

  // Auto-play the whole sequence for a screen recording. Uses the endpoints YOU
  // picked if both are set; otherwise defaults to Electronic City → Whitefield.
  // The auto-advance effect then carries it through Stages 1 → 4.
  function handlePlayDemo() {
    if (!graph || !chReady) return;
    let s = sourceId;
    let d = destId;
    if (s == null || d == null) {
      const route = QUICK_ROUTES[0]; // Electronic City → Whitefield
      s = nearestNode(graph, route.from.coord[0], route.from.coord[1]);
      d = nearestNode(graph, route.to.coord[0], route.to.coord[1]);
      setSourceId(s);
      setDestId(d);
      setSourceLabel(route.from.name);
      setDestLabel(route.to.name);
    }
    setMode("source");
    setSpeed(110); // brisk but watchable for the recording
    setPunchToken(0);
    setDemoMode(true);
    play(0, s, d, {});
  }

  // Stage 4 → "Show what really happened": jump back to the fully-revealed CH
  // technical view so viewers connect the clean result to the machinery.
  function handleShowReal() {
    const chRes = results[CH_STAGE];
    if (!chRes || !graph) return;
    setDemoMode(false);
    setCurrentStage(CH_STAGE);
    setAnim({ revealStep: chRes.log.length, pathReveal: 1 });
    setPhase("done");
    setShowCompare(false);
    if (sourceId != null && destId != null) {
      setFrameRoute({
        source: graph.coords[sourceId],
        dest: graph.coords[destId],
        token: Date.now(),
      });
    }
  }

  // Free-text place search → OSM Nominatim geocode (bounded to Bengaluru) → snap
  // to the nearest graph node → set the current endpoint (source/destination).
  async function handleSearch(query: string) {
    if (!graph || !query.trim()) return;
    setSearching(true);
    setSearchErr(null);
    try {
      const viewbox = "77.45,13.10,77.78,12.82"; // west,north,east,south
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1" +
        `&viewbox=${viewbox}&q=${encodeURIComponent(query + ", Bengaluru, India")}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = (await res.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
      if (!Array.isArray(data) || data.length === 0) {
        setSearchErr("No place found in Bengaluru");
        return;
      }
      const lng = parseFloat(data[0].lon);
      const lat = parseFloat(data[0].lat);
      const id = nearestNode(graph, lng, lat);
      const label = (data[0].display_name ?? query).split(",")[0];
      setDemoMode(false);
      resetBuild();
      setFocus({ coord: graph.coords[id] as [number, number], token: Date.now() });
      if (mode === "source") {
        setSourceId(id);
        setSourceLabel(label);
        setMode("destination");
      } else {
        setDestId(id);
        setDestLabel(label);
      }
    } catch {
      setSearchErr("Search failed — check your connection");
    } finally {
      setSearching(false);
    }
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
            presentation,
          }
        : null;

    // Phase 5: in Traffic mode the staged search is suppressed and replaced by the
    // congestion overlay + the active/alternative route.
    const toCoords = (path: number[]): [number, number][] =>
      path.map((id) => graph.coords[id] as [number, number]);
    let traffic = null as Parameters<typeof buildLayers>[0]["traffic"];
    if (trafficMode) {
      // Closure markers from the blocked-edge keys (covers any road class).
      // Defensive: never let a malformed key crash the whole render.
      const closureMids: [number, number][] = [];
      for (const kk of closures) {
        const sp = kk.split(" ");
        const a = graph.coords[Number(sp[0])];
        const b = graph.coords[Number(sp[1])];
        if (!a || !b) continue;
        closureMids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
      if (journey) {
        // Driving: the vehicle follows its journey; old route shown briefly on reroute.
        traffic = {
          edges: arterials,
          levels: congestionLevels,
          routePath: journey.coords,
          altPath: oldRouteCoords,
          metric: trafficMetric,
          closures: closureMids,
          vehicle: vehicle ? vehicle.coord : null,
        };
      } else {
        // Idle: show the two candidate routes for the metric comparison (Slice A).
        const active = trafficRoutes
          ? trafficMetric === "time"
            ? trafficRoutes.byTime
            : trafficRoutes.byDist
          : null;
        const alt = trafficRoutes
          ? trafficMetric === "time"
            ? trafficRoutes.byDist
            : trafficRoutes.byTime
          : null;
        const samePath =
          active && alt && active.path.length === alt.path.length &&
          active.path.every((x, i) => x === alt.path[i]);
        traffic = {
          edges: arterials,
          levels: congestionLevels,
          routePath: active && active.path.length >= 2 ? toCoords(active.path) : null,
          altPath: alt && !samePath && alt.path.length >= 2 ? toCoords(alt.path) : null,
          metric: trafficMetric,
          closures: closureMids,
          vehicle: null,
        };
      }
    }

    return buildLayers({
      roadEdges,
      render: trafficMode ? null : render,
      water,
      source: sourceId != null ? graph.coords[sourceId] : null,
      destination: destId != null ? graph.coords[destId] : null,
      sourceLabel,
      destLabel,
      traffic,
    });
  }, [
    graph,
    roadEdges,
    water,
    precomp,
    trafficMode,
    trafficRoutes,
    trafficMetric,
    arterials,
    congestionLevels,
    closures,
    journey,
    vehicle,
    oldRouteCoords,
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

      <ModeSwitch mode={appMode} onMode={setAppMode} />

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
        onSearch={handleSearch}
        searching={searching}
        searchErr={searchErr}
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
        onPlayDemo={handlePlayDemo}
        demoEnabled={chReady && !busy}
        appMode={appMode}
      />

      {trafficMode && (
        <TrafficPanel
          hour={hour}
          onHour={setHour}
          metric={trafficMetric}
          onMetric={setTrafficMetric}
          hasEndpoints={sourceId != null && destId != null}
          timeRoute={
            trafficRoutes
              ? { km: trafficRoutes.byTime.meters / 1000, minutes: trafficRoutes.byTime.seconds / 60 }
              : null
          }
          distRoute={
            trafficRoutes
              ? { km: trafficRoutes.byDist.meters / 1000, minutes: trafficRoutes.byDist.seconds / 60 }
              : null
          }
          driving={driving}
          hasJourney={journey != null}
          onToggleDrive={handleToggleDrive}
          onInject={handleInject}
          onClear={handleClearIncidents}
          rerouteMs={rerouteMs}
          closuresCount={closures.length}
          onScenario={handleScenario}
        />
      )}

      {!trafficMode && <StageTimeline statuses={statuses} />}

      {!trafficMode && !presentation && (
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
      )}

      {!trafficMode && showCompare && results[0] && results[1] && (
        <CompareCard
          dijkstra={results[0].stats}
          astar={results[1].stats}
          ch={results[2]?.stats ?? null}
          onClose={() => setShowCompare(false)}
        />
      )}

      {/* Stage 4: the consumer-app route card + the punchline + "show the machinery". */}
      {!trafficMode && presentation && phase === "done" && routeEstimate && (
        <>
          <RouteCard
            fromLabel={sourceLabel}
            toLabel={destLabel}
            minutes={routeEstimate.minutes}
            freeMinutes={routeEstimate.freeMinutes}
            distanceKm={routeEstimate.distanceKm}
            via={routeEstimate.via}
            condition={condition}
            onCondition={setCondition}
            routeMode={routeMode}
            onRouteMode={setRouteMode}
            shortMinutes={shortEst ? shortEst.minutes : null}
            fastMinutes={fastEst ? fastEst.minutes : null}
            onShowReal={handleShowReal}
          />
          <div key={punchToken} className="punchline">
            Everything you just watched happens invisibly — in milliseconds — every
            time you tap <b>Go</b>.
          </div>
        </>
      )}

      {/* Demo Mode: per-stage caption + corner wordmark for screen recording. */}
      {!trafficMode && demoMode && (
        <>
          <div className="demo-caption">{stage.caption}</div>
          <div className="demo-wordmark">RouteEngine</div>
        </>
      )}

      {showIntro && <Intro />}
    </>
  );
}
