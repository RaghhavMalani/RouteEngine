/**
 * build-ch.ts — Contraction Hierarchies preprocessing (run once, offline).
 *
 * Run with `npm run build-ch` AFTER `npm run build-graph`. It reads the routing
 * graph, contracts every node in increasing order of importance, adds shortcut
 * edges that preserve shortest distances, and writes an augmented graph + per-node
 * levels to `public/bengaluru-ch.json` for the Stage 3 query to load at runtime.
 *
 * WHY OFFLINE: contraction is expensive; queries must be instant. We pay the cost
 * once and ship the result, exactly like the OSM→graph build.
 *
 * NODE ORDERING: a lazy priority queue keyed by EDGE DIFFERENCE (shortcuts a
 * contraction would add minus the edges it removes) plus a contracted-neighbours
 * term to spread the order out. We pop the cheapest node, recompute its priority,
 * and only contract it if it's still the minimum — otherwise we push it back.
 *
 * WITNESS SEARCH: before adding a shortcut u→w through v we run a local Dijkstra
 * from u (ignoring v) to see if a path u→w no longer than w(u,v)+w(v,w) already
 * exists. If so, no shortcut is needed. The search is BOUNDED (capped settled
 * count + a distance bound) so it stays tractable on ~220k nodes — a limited
 * witness search may add a few unnecessary shortcuts, which is standard CH
 * engineering and stays correct, just slightly larger.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "public", "bengaluru-graph.json");
const OUTPUT = resolve(ROOT, "public", "bengaluru-ch.json");

/** Cap on witness-search settled nodes (bounds preprocessing cost). */
const MAX_SETTLED = 120;

interface GraphJSON {
  meta: { nodeCount: number; edgeCount: number };
  nodes: number[][];
  edges: [number, number, number, number, number][];
}

const tStart = Date.now();
const data = JSON.parse(readFileSync(INPUT, "utf8")) as GraphJSON;
const N = data.nodes.length;

// Dynamic adjacency: per-node parallel arrays. mid = -1 for an original edge.
const aTo: number[][] = Array.from({ length: N }, () => []);
const aW: number[][] = Array.from({ length: N }, () => []);
const aMid: number[][] = Array.from({ length: N }, () => []);

function addEdge(u: number, v: number, w: number, mid: number): void {
  const tu = aTo[u];
  for (let i = 0; i < tu.length; i++) {
    if (tu[i] === v) {
      if (w < aW[u][i]) { aW[u][i] = w; aMid[u][i] = mid; }
      return;
    }
  }
  aTo[u].push(v); aW[u].push(w); aMid[u].push(mid);
}

for (const [u, v, len] of data.edges) {
  addEdge(u, v, len, -1);
  addEdge(v, u, len, -1);
}
console.log(`• loaded ${N.toLocaleString()} nodes, ${data.edges.length.toLocaleString()} edges`);

const level = new Int32Array(N).fill(-1);
const contracted = new Uint8Array(N);
const contractedNb = new Int32Array(N);

// version-stamped distance array for fast repeated bounded Dijkstra
const dist = new Float64Array(N);
const stamp = new Int32Array(N);
let curStamp = 0;

// typed binary heap for the witness search
let hd = new Float64Array(1024);
let hv = new Int32Array(1024);
let hn = 0;
function heapClear(): void { hn = 0; }
function heapPush(d: number, v: number): void {
  if (hn === hd.length) {
    const nd = new Float64Array(hd.length * 2); const nv = new Int32Array(hd.length * 2);
    nd.set(hd); nv.set(hv); hd = nd; hv = nv;
  }
  let i = hn++; hd[i] = d; hv[i] = v;
  while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break;
    const td = hd[p]; hd[p] = hd[i]; hd[i] = td; const tv = hv[p]; hv[p] = hv[i]; hv[i] = tv; i = p; }
}
function heapPopNode(): number {
  const rv = hv[0]; hn--;
  if (hn > 0) { hd[0] = hd[hn]; hv[0] = hv[hn]; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let s = i;
      if (l < hn && hd[l] < hd[s]) s = l; if (r < hn && hd[r] < hd[s]) s = r;
      if (s === i) break; const td = hd[s]; hd[s] = hd[i]; hd[i] = td; const tv = hv[s]; hv[s] = hv[i]; hv[i] = tv; i = s; } }
  return rv;
}

function activeNeighbours(v: number): { nb: number[]; wt: number[] } {
  const nb: number[] = []; const wt: number[] = [];
  const seen = new Map<number, number>();
  const tv = aTo[v];
  for (let i = 0; i < tv.length; i++) {
    const x = tv[i]; if (contracted[x]) continue;
    const w = aW[v][i];
    const e = seen.get(x);
    if (e === undefined) { seen.set(x, nb.length); nb.push(x); wt.push(w); }
    else if (w < wt[e]) wt[e] = w;
  }
  return { nb, wt };
}

/** Bounded local Dijkstra from u, ignoring `avoid`; results read via getDist. */
function witness(u: number, avoid: number, maxDist: number): void {
  curStamp++; heapClear();
  dist[u] = 0; stamp[u] = curStamp; heapPush(0, u);
  let settled = 0;
  while (hn > 0) {
    const du = hd[0]; const u2 = heapPopNode();
    if (du > dist[u2]) continue;
    if (du > maxDist) break;
    if (++settled > MAX_SETTLED) break;
    const t = aTo[u2]; const w = aW[u2];
    for (let i = 0; i < t.length; i++) {
      const x = t[i]; if (contracted[x] || x === avoid) continue;
      const nd = du + w[i]; if (nd > maxDist) continue;
      if (stamp[x] !== curStamp || nd < dist[x]) { dist[x] = nd; stamp[x] = curStamp; heapPush(nd, x); }
    }
  }
}
const getDist = (x: number): number => (stamp[x] === curStamp ? dist[x] : Infinity);

/** Contract v (add=false → just count edge difference). */
function contract(v: number, add: boolean): { added: number; deg: number } {
  const { nb, wt } = activeNeighbours(v);
  const deg = nb.length;
  let added = 0;
  for (let i = 0; i < deg; i++) {
    const u = nb[i]; const wuv = wt[i];
    let maxP = 0;
    for (let k = 0; k < deg; k++) if (k !== i) { const p = wuv + wt[k]; if (p > maxP) maxP = p; }
    if (maxP === 0) continue;
    witness(u, v, maxP);
    for (let k = 0; k < deg; k++) {
      if (k === i) continue;
      const w = nb[k]; const P = wuv + wt[k];
      if (getDist(w) <= P + 1e-9) continue;
      added++;
      if (add) addEdge(u, w, P, v);
    }
  }
  return { added, deg };
}

// lazy priority queue of (priority, node)
let pd = new Float64Array(N);
let pv = new Int32Array(N);
let pn = 0;
function pqPush(p: number, v: number): void {
  let i = pn++; pd[i] = p; pv[i] = v;
  while (i > 0) { const par = (i - 1) >> 1; if (pd[par] <= pd[i]) break;
    const t = pd[par]; pd[par] = pd[i]; pd[i] = t; const tv = pv[par]; pv[par] = pv[i]; pv[i] = tv; i = par; }
}
function pqPopNode(): number {
  const rv = pv[0]; pn--;
  if (pn > 0) { pd[0] = pd[pn]; pv[0] = pv[pn]; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let s = i;
      if (l < pn && pd[l] < pd[s]) s = l; if (r < pn && pd[r] < pd[s]) s = r;
      if (s === i) break; const t = pd[s]; pd[s] = pd[i]; pd[i] = t; const tv = pv[s]; pv[s] = pv[i]; pv[i] = tv; i = s; } }
  return rv;
}
const pqTop = (): number => (pn > 0 ? pd[0] : Infinity);

// initial node ordering
for (let v = 0; v < N; v++) {
  const { added, deg } = contract(v, false);
  pqPush(added - deg + contractedNb[v], v);
}
console.log(`• initial ordering in ${Date.now() - tStart}ms`);

// main contraction loop
let order = 0;
while (pn > 0) {
  const v = pqPopNode();
  if (contracted[v]) continue;
  const sim = contract(v, false);
  const pri = sim.added - sim.deg + contractedNb[v];
  if (pn > 0 && pri > pqTop() + 1e-9) { pqPush(pri, v); continue; } // lazy: no longer min
  contract(v, true);
  contracted[v] = 1; level[v] = order++;
  const { nb } = activeNeighbours(v);
  for (const x of nb) contractedNb[x]++;
}

// collect augmented edges (u < v), counting shortcuts
const edges: [number, number, number, number][] = [];
let shortcutCount = 0;
for (let u = 0; u < N; u++) {
  const t = aTo[u];
  for (let i = 0; i < t.length; i++) {
    const v = t[i];
    if (u < v) {
      edges.push([u, v, aW[u][i], aMid[u][i]]);
      if (aMid[u][i] !== -1) shortcutCount++;
    }
  }
}

const out = {
  meta: {
    generated: new Date().toISOString(),
    nodeCount: N,
    origEdgeCount: data.edges.length,
    augEdgeCount: edges.length,
    shortcutCount,
    maxSettled: MAX_SETTLED,
  },
  level: Array.from(level),
  edges,
};
writeFileSync(OUTPUT, JSON.stringify(out));

console.log(`\n✔ CH built → public/bengaluru-ch.json`);
console.log(`  preprocessing time: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
console.log(`  shortcuts added:    ${shortcutCount.toLocaleString()}`);
console.log(`  total edges:        ${edges.length.toLocaleString()} (was ${data.edges.length.toLocaleString()})`);
