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
 * Contraction Hierarchies — the "production" query (Stage 3).
 *
 * CH is a two-part technique. OFFLINE (scripts/build-ch.ts) we contract nodes
 * one by one in increasing order of importance; when a node is removed we add
 * "shortcut" edges that preserve shortest distances between its neighbours, each
 * shortcut remembering the node it bypasses. ONLINE (this file) a query becomes a
 * BIDIRECTIONAL search that only ever moves UPWARD in the hierarchy — from the
 * source climbing up, from the target climbing up — until the two frontiers meet.
 * Because both sides only relax edges to strictly higher levels, each search
 * touches a tiny, funnel-shaped slice of the graph instead of flooding it.
 *
 * The answer is identical to Dijkstra's (the correctness gate proves this on 200
 * random pairs, exact match). The displayed route is recovered by UNPACKING each
 * shortcut on the meeting path recursively into its two halves, all the way down
 * to original road edges — so the ribbon follows real Bengaluru roads, never a
 * straight shortcut line.
 */

const FWD = 0;
const BWD = 1;
const HIER = 2;

/** Caps for the stylised hierarchy-assembly beat (kept small + elegant, not a web). */
const MAX_ARCS = 130;
const MAX_LANDMARKS = 1300;

export class CHData {
  readonly level: Int32Array;
  readonly nodeCount: number;

  /** Upward adjacency (CSR): only edges that go to a strictly higher level. */
  readonly upOff: Int32Array;
  readonly upTo: Int32Array;
  readonly upW: Float64Array;

  /** Unpacking table: key(a,b) -> middle node of that (shortcut) edge, or -1. */
  private readonly midOf: Map<number, number>;
  private readonly wOf: Map<number, number>;
  private readonly nForKey: number;

  /** Precomputed stylised hierarchy beat (built once). */
  readonly arcs: { a: number; b: number }[];
  readonly landmarks: number[];

  constructor(json: CHGraphJSON) {
    const n = json.meta.nodeCount;
    this.nodeCount = n;
    this.nForKey = n;
    this.level = Int32Array.from(json.level);

    // Build upward CSR + unpacking maps in one pass over augmented edges.
    const updeg = new Int32Array(n);
    for (const [a, b] of json.edges) {
      if (this.level[a] < this.level[b]) updeg[a]++;
      else updeg[b]++;
    }
    this.upOff = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.upOff[i + 1] = this.upOff[i] + updeg[i];
    this.upTo = new Int32Array(this.upOff[n]);
    this.upW = new Float64Array(this.upOff[n]);
    const cur = this.upOff.slice(0, n);

    this.midOf = new Map();
    this.wOf = new Map();
    const arcCandidates: { a: number; b: number; lvl: number }[] = [];

    for (const [a, b, w, mid] of json.edges) {
      const key = this.key(a, b);
      // keep the lighter parallel edge for unpacking + its middle
      const prev = this.wOf.get(key);
      if (prev === undefined || w < prev) {
        this.wOf.set(key, w);
        this.midOf.set(key, mid);
      }
      if (this.level[a] < this.level[b]) {
        this.upTo[cur[a]] = b;
        this.upW[cur[a]++] = w;
      } else {
        this.upTo[cur[b]] = a;
        this.upW[cur[b]++] = w;
      }
      if (mid !== -1) {
        const lvl = Math.min(this.level[a], this.level[b]);
        arcCandidates.push({ a, b, lvl });
      }
    }

    // Sample the highest shortcuts as representative arcs for the build beat.
    arcCandidates.sort((p, q) => q.lvl - p.lvl);
    this.arcs = arcCandidates
      .slice(0, MAX_ARCS)
      .map(({ a, b }) => ({ a, b }));

    // Sample landmark nodes across the top of the hierarchy.
    const byLevel = Array.from({ length: n }, (_, i) => i);
    byLevel.sort((p, q) => this.level[q] - this.level[p]);
    this.landmarks = byLevel.slice(0, MAX_LANDMARKS);
  }

  static fromJSON(json: CHGraphJSON): CHData {
    return new CHData(json);
  }

  private key(a: number, b: number): number {
    return a < b ? a * this.nForKey + b : b * this.nForKey + a;
  }

  /** Recursively expand a (possibly shortcut) edge a→b into real road nodes. */
  unpack(a: number, b: number, out: number[]): void {
    const key = this.key(a, b);
    const mid = this.midOf.get(key);
    if (mid === undefined || mid === -1) {
      out.push(b); // original edge
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
  relaxations: number; // edges that actually improved a distance (the real "work")
  order: { node: number; g: number }[];
}

/** One direction of the upward bidirectional search (records its settle order). */
function searchUp(ch: CHData, src: number): SideResult {
  const n = ch.nodeCount;
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
    for (let i = ch.upOff[u]; i < ch.upOff[u + 1]; i++) {
      const v = ch.upTo[i];
      const nd = d + ch.upW[i];
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
    const start = performance.now();

    const F = searchUp(ch, sourceId);
    const B = searchUp(ch, targetId);

    // Meeting node: minimises forward + backward distance.
    let meet = -1;
    let best = Infinity;
    // Only nodes touched by the smaller search need checking.
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

    // Up-path source→meet and meet→target (still in shortcut space).
    const upPath = meet === -1 ? [] : buildUpPath(F.parent, sourceId, meet, B.parent, targetId);

    // Unpack to real road nodes for the displayed ribbon.
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

/** Reconstruct source→meet→target through the two parent trees. */
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
  // bwd is meet … target already (parent climbs from meet toward target)
  return fwd.concat(bwd.slice(1));
}

/**
 * Build the replayable log: first the stylised HIERARCHY beat (landmark nodes +
 * shortcut arcs, raised by level), then the bidirectional SEARCH beat (forward
 * and backward settles, two-coloured, climbing by level and meeting). Height for
 * every step is the LEVEL, so the model reads as a layered structure.
 */
function buildLog(ch: CHData, F: SideResult, B: SideResult): ExplorationLog {
  const log: ExplorationLog = [];
  const lvl = (x: number) => ch.level[x];

  // ---- Beat 1: hierarchy assembly ----
  // One reveal step per landmark node (raised by its level) so the hierarchy
  // materialises as a layered cloud of dots; the sampled shortcut arcs are spread
  // across the first steps so they sweep in as the structure assembles. App reads
  // step.node as a dot and the (from≠to) edge as an arc — both reveal on the same
  // clock, and neither counts toward the search-work HUD because dir === 2.
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

  // ---- Beat 2: the bidirectional query, interleaved by settle distance ----
  // We draw only the SEARCH TREE — one edge from each settled node back to the
  // parent it was reached from — not every upward edge scanned. That keeps the
  // two funnels clean and legible (a few hundred edges, not ~12k city-spanning
  // lines) so the "meet in the middle" is actually visible.
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
