import { Graph } from "./graph";
import { MinHeap } from "./heap";
import type {
  CHGraphJSON,
  ExplorationLog,
  ExploreStep,
  PathResult,
  Pathfinder,
} from "./types";

/**
 * Contraction Hierarchies — the "production" query (Stage 3), now DIRECTED so it
 * respects one-way streets (and the divided-road U-turns that follow from them).
 *
 * Offline (scripts/build-ch.ts) we contract nodes by importance and add directed
 * shortcut edges (each remembers the node it bypasses). Online, a query is a
 * BIDIRECTIONAL upward search: a FORWARD search from the source over out-edges that
 * climb the hierarchy, and a BACKWARD search from the target over in-edges (the
 * reverse graph) that also climb — they meet near the top. The answer is identical
 * to a directed Dijkstra (proven by a 200-pair correctness gate). Shortcuts on the
 * meeting path are unpacked recursively into real, legally-directed road edges.
 */

const FWD = 0;
const BWD = 1;
const HIER = 2;

const MAX_ARCS = 130;
const MAX_LANDMARKS = 1300;

export class CHData {
  readonly level: Int32Array;
  readonly nodeCount: number;

  /** Forward up-graph (out-edges to a higher level) — for the source search. */
  readonly fOff: Int32Array;
  readonly fTo: Int32Array;
  readonly fW: Float64Array;
  /** Backward up-graph (reverse of in-edges from a higher level) — target search. */
  readonly bOff: Int32Array;
  readonly bTo: Int32Array;
  readonly bW: Float64Array;

  /** Directed unpacking table: key(a→b) -> middle node (or -1 for an original edge). */
  private readonly midOf: Map<number, number>;
  private readonly nForKey: number;

  readonly arcs: { a: number; b: number }[];
  readonly landmarks: number[];

  constructor(json: CHGraphJSON) {
    const n = json.meta.nodeCount;
    this.nodeCount = n;
    this.nForKey = n;
    this.level = Int32Array.from(json.level);
    const lvl = this.level;

    const fdeg = new Int32Array(n);
    const bdeg = new Int32Array(n);
    for (const [u, v] of json.edges) {
      if (lvl[v] > lvl[u]) fdeg[u]++;
      if (lvl[u] > lvl[v]) bdeg[v]++;
    }
    this.fOff = new Int32Array(n + 1);
    this.bOff = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.fOff[i + 1] = this.fOff[i] + fdeg[i];
      this.bOff[i + 1] = this.bOff[i] + bdeg[i];
    }
    this.fTo = new Int32Array(this.fOff[n]);
    this.fW = new Float64Array(this.fOff[n]);
    this.bTo = new Int32Array(this.bOff[n]);
    this.bW = new Float64Array(this.bOff[n]);
    const fc = this.fOff.slice(0, n);
    const bc = this.bOff.slice(0, n);

    this.midOf = new Map();
    const arcCandidates: { a: number; b: number; lvl: number }[] = [];

    for (const [a, b, w, mid] of json.edges) {
      const key = a * this.nForKey + b; // directed
      const prev = this.midOf.get(key);
      if (prev === undefined) this.midOf.set(key, mid);
      if (lvl[b] > lvl[a]) {
        this.fTo[fc[a]] = b;
        this.fW[fc[a]++] = w;
      }
      if (lvl[a] > lvl[b]) {
        this.bTo[bc[b]] = a;
        this.bW[bc[b]++] = w;
      }
      if (mid !== -1) arcCandidates.push({ a, b, lvl: Math.min(lvl[a], lvl[b]) });
    }

    arcCandidates.sort((p, q) => q.lvl - p.lvl);
    this.arcs = arcCandidates.slice(0, MAX_ARCS).map(({ a, b }) => ({ a, b }));

    const byLevel = Array.from({ length: n }, (_, i) => i);
    byLevel.sort((p, q) => lvl[q] - lvl[p]);
    this.landmarks = byLevel.slice(0, MAX_LANDMARKS);
  }

  static fromJSON(json: CHGraphJSON): CHData {
    return new CHData(json);
  }

  /** Recursively expand a (possibly shortcut) directed edge a→b into road nodes. */
  unpack(a: number, b: number, out: number[]): void {
    const mid = this.midOf.get(a * this.nForKey + b);
    if (mid === undefined || mid === -1) {
      out.push(b);
      return;
    }
    this.unpack(a, mid, out);
    this.unpack(mid, b, out);
  }
}

interface SideResult {
  dist: Float64Array;
  parent: Int32Array;
  settled: number;
  relaxations: number;
  order: { node: number; g: number }[];
}

/** One direction of the upward search over the given CSR adjacency. */
function searchUp(
  n: number,
  off: Int32Array,
  to: Int32Array,
  w: Float64Array,
  src: number,
): SideResult {
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const order: { node: number; g: number }[] = [];

  dist[src] = 0;
  const pq = new MinHeap<number>();
  pq.push(src, 0);
  let settled = 0;
  let relaxations = 0;

  while (!pq.isEmpty()) {
    const { value: u, priority: d } = pq.pop()!;
    if (done[u]) continue;
    if (d > dist[u]) continue;
    done[u] = 1;
    settled++;
    order.push({ node: u, g: d });
    for (let i = off[u]; i < off[u + 1]; i++) {
      const v = to[i];
      const nd = d + w[i];
      if (nd < dist[v]) {
        dist[v] = nd;
        parent[v] = u;
        relaxations++;
        pq.push(v, nd);
      }
    }
  }
  return { dist, parent, settled, relaxations, order };
}

export class CHPathfinder implements Pathfinder {
  readonly name = "Contraction Hierarchies";
  private readonly ch: CHData;

  constructor(ch: CHData) {
    this.ch = ch;
  }

  findPath(_graph: Graph, sourceId: number, targetId: number): PathResult {
    const ch = this.ch;
    const n = ch.nodeCount;
    const start = performance.now();

    const F = searchUp(n, ch.fOff, ch.fTo, ch.fW, sourceId);
    const B = searchUp(n, ch.bOff, ch.bTo, ch.bW, targetId);

    let meet = -1;
    let best = Infinity;
    const scan = F.order.length < B.order.length ? F.order : B.order;
    for (const { node: x } of scan) {
      if (F.dist[x] !== Infinity && B.dist[x] !== Infinity) {
        const tot = F.dist[x] + B.dist[x];
        if (tot < best) {
          best = tot;
          meet = x;
        }
      }
    }

    const upPath = meet === -1 ? [] : buildUpPath(F.parent, sourceId, meet, B.parent, targetId);

    const path: number[] = [];
    if (upPath.length > 0) {
      path.push(upPath[0]);
      for (let i = 0; i + 1 < upPath.length; i++) ch.unpack(upPath[i], upPath[i + 1], path);
    }

    const computeTimeMs = performance.now() - start;
    const edgesRelaxed = F.relaxations + B.relaxations;
    const log = buildLog(ch, F, B);

    return {
      path,
      log,
      meetNode: meet === -1 ? undefined : meet,
      stats: {
        nodesExplored: F.settled + B.settled,
        edgesRelaxed,
        pathLengthMeters: meet === -1 ? 0 : best,
        computeTimeMs,
      },
    };
  }
}

/**
 * Reconstruct source→meet→target. Forward parents are predecessors (walk back from
 * meet to source). Backward parents are *successors toward the target* (walk
 * forward from meet to target), since the backward search ran on the reverse graph.
 */
function buildUpPath(
  fParent: Int32Array,
  source: number,
  meet: number,
  bParent: Int32Array,
  target: number,
): number[] {
  const fwd: number[] = [];
  for (let x = meet; x !== -1; x = fParent[x]) {
    fwd.push(x);
    if (x === source) break;
  }
  fwd.reverse(); // source … meet
  const bwd: number[] = [];
  for (let x = meet; x !== -1; x = bParent[x]) {
    bwd.push(x);
    if (x === target) break;
  }
  // bwd is meet … target (each step is a real forward edge)
  return fwd.concat(bwd.slice(1));
}

function buildLog(ch: CHData, F: SideResult, B: SideResult): ExplorationLog {
  const log: ExplorationLog = [];
  const lvl = (x: number) => ch.level[x];

  // Beat 1: hierarchy assembly (landmark dots + sampled shortcut arcs).
  const hierSteps = ch.landmarks.length;
  for (let s = 0; s < hierSteps; s++) {
    const node = ch.landmarks[s];
    const step: ExploreStep = { node, cost: lvl(node), edges: [], dir: HIER };
    if (s < ch.arcs.length) {
      const { a, b } = ch.arcs[s];
      step.edges.push({ from: a, to: b, toCost: Math.max(lvl(a), lvl(b)) });
    }
    log.push(step);
  }

  // Beat 2: the two converging search trees (one edge per settled node).
  let i = 0;
  let jb = 0;
  while (i < F.order.length || jb < B.order.length) {
    const useF =
      jb >= B.order.length ||
      (i < F.order.length && F.order[i].g <= B.order[jb].g);
    const { node: u } = useF ? F.order[i++] : B.order[jb++];
    const dir = useF ? FWD : BWD;
    const parent = useF ? F.parent : B.parent;
    const step: ExploreStep = { node: u, cost: lvl(u), edges: [], dir };
    const p = parent[u];
    if (p !== -1) step.edges.push({ from: p, to: u, toCost: lvl(u) });
    log.push(step);
  }

  return log;
}
