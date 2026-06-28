/**
 * build-ch.ts — DIRECTED Contraction Hierarchies preprocessing (run once, offline).
 *
 * Run with `npm run build-ch` AFTER `npm run build-graph`. It honours one-way
 * streets: a one-way edge is used only in its legal direction, so the resulting
 * hierarchy (and every query on it) is *drivable*, not just geometrically shortest.
 *
 * Node ordering = lazy priority queue keyed by EDGE DIFFERENCE (directed shortcuts
 * added minus in+out edges removed) + a contracted-neighbours term. Contracting v
 * considers each (in-neighbour u → v → out-neighbour w) pair; a bounded directed
 * WITNESS search (local Dijkstra from u over out-edges, ignoring v) decides whether
 * a shortcut u→w is needed. Shortcuts store the middle node for unpacking. The
 * bounded witness can add a few extra shortcuts — standard CH engineering, still
 * optimal. Output: public/bengaluru-ch.json (directed augmented edges + levels).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "public", "bengaluru-graph.json");
const OUTPUT = resolve(ROOT, "public", "bengaluru-ch.json");
const MAX_SETTLED = 120;

interface GraphJSON {
  meta: { nodeCount: number; edgeCount: number };
  nodes: number[][];
  edges: [number, number, number, number, number][];
}

const tStart = Date.now();
const data = JSON.parse(readFileSync(INPUT, "utf8")) as GraphJSON;
const N = data.nodes.length;

// Directed dynamic adjacency: out + in. mid = -1 for an original edge.
const oTo: number[][] = Array.from({ length: N }, () => []);
const oW: number[][] = Array.from({ length: N }, () => []);
const oMid: number[][] = Array.from({ length: N }, () => []);
const iFr: number[][] = Array.from({ length: N }, () => []);
const iW: number[][] = Array.from({ length: N }, () => []);
const iMid: number[][] = Array.from({ length: N }, () => []);

function addArc(u: number, v: number, w: number, mid: number): void {
  const ot = oTo[u];
  let found = false;
  for (let k = 0; k < ot.length; k++)
    if (ot[k] === v) { if (w < oW[u][k]) { oW[u][k] = w; oMid[u][k] = mid; } found = true; break; }
  if (!found) { oTo[u].push(v); oW[u].push(w); oMid[u].push(mid); }
  const it = iFr[v];
  found = false;
  for (let k = 0; k < it.length; k++)
    if (it[k] === u) { if (w < iW[v][k]) { iW[v][k] = w; iMid[v][k] = mid; } found = true; break; }
  if (!found) { iFr[v].push(u); iW[v].push(w); iMid[v].push(mid); }
}

let oneCount = 0;
for (const [u, v, len, , oneway] of data.edges) {
  addArc(u, v, len, -1);
  if (oneway === 1) oneCount++;
  else addArc(v, u, len, -1);
}
console.log(`• loaded ${N.toLocaleString()} nodes, ${data.edges.length.toLocaleString()} edges (${oneCount.toLocaleString()} one-way)`);

const level = new Int32Array(N).fill(-1);
const contracted = new Uint8Array(N);
const contractedNb = new Int32Array(N);

const dist = new Float64Array(N);
const stamp = new Int32Array(N);
let curStamp = 0;
let hd = new Float64Array(1024);
let hv = new Int32Array(1024);
let hn = 0;
function hClear(): void { hn = 0; }
function hPush(d: number, v: number): void {
  if (hn === hd.length) { const a = new Float64Array(hd.length * 2); const b = new Int32Array(hd.length * 2); a.set(hd); b.set(hv); hd = a; hv = b; }
  let i = hn++; hd[i] = d; hv[i] = v;
  while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break; const td = hd[p]; hd[p] = hd[i]; hd[i] = td; const tv = hv[p]; hv[p] = hv[i]; hv[i] = tv; i = p; }
}
function hPop(): number {
  const rv = hv[0]; hn--;
  if (hn > 0) { hd[0] = hd[hn]; hv[0] = hv[hn]; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < hn && hd[l] < hd[s]) s = l; if (r < hn && hd[r] < hd[s]) s = r; if (s === i) break; const td = hd[s]; hd[s] = hd[i]; hd[i] = td; const tv = hv[s]; hv[s] = hv[i]; hv[i] = tv; i = s; } }
  return rv;
}

function activeOut(v: number): { nb: number[]; wt: number[] } {
  const nb: number[] = []; const wt: number[] = []; const seen = new Map<number, number>(); const t = oTo[v];
  for (let i = 0; i < t.length; i++) { const x = t[i]; if (contracted[x]) continue; const w = oW[v][i]; const e = seen.get(x); if (e === undefined) { seen.set(x, nb.length); nb.push(x); wt.push(w); } else if (w < wt[e]) wt[e] = w; }
  return { nb, wt };
}
function activeIn(v: number): { nb: number[]; wt: number[] } {
  const nb: number[] = []; const wt: number[] = []; const seen = new Map<number, number>(); const t = iFr[v];
  for (let i = 0; i < t.length; i++) { const x = t[i]; if (contracted[x]) continue; const w = iW[v][i]; const e = seen.get(x); if (e === undefined) { seen.set(x, nb.length); nb.push(x); wt.push(w); } else if (w < wt[e]) wt[e] = w; }
  return { nb, wt };
}

function witness(u: number, avoid: number, maxDist: number): void {
  curStamp++; hClear(); dist[u] = 0; stamp[u] = curStamp; hPush(0, u);
  let settled = 0;
  while (hn > 0) {
    const du = hd[0]; const x = hPop();
    if (du > dist[x]) continue;
    if (du > maxDist) break;
    if (++settled > MAX_SETTLED) break;
    const t = oTo[x]; const w = oW[x];
    for (let i = 0; i < t.length; i++) { const y = t[i]; if (contracted[y] || y === avoid) continue; const nd = du + w[i]; if (nd > maxDist) continue; if (stamp[y] !== curStamp || nd < dist[y]) { dist[y] = nd; stamp[y] = curStamp; hPush(nd, y); } }
  }
}
const gd = (x: number): number => (stamp[x] === curStamp ? dist[x] : Infinity);

function contract(v: number, add: boolean): { added: number; deg: number } {
  const inN = activeIn(v); const outN = activeOut(v);
  let added = 0;
  for (let a = 0; a < inN.nb.length; a++) {
    const u = inN.nb[a]; const wuv = inN.wt[a];
    let maxP = 0;
    for (let b = 0; b < outN.nb.length; b++) if (outN.nb[b] !== u) { const p = wuv + outN.wt[b]; if (p > maxP) maxP = p; }
    if (maxP === 0) continue;
    witness(u, v, maxP);
    for (let b = 0; b < outN.nb.length; b++) {
      const w = outN.nb[b]; if (w === u) continue;
      const P = wuv + outN.wt[b];
      if (gd(w) <= P + 1e-9) continue;
      added++;
      if (add) addArc(u, w, P, v);
    }
  }
  return { added, deg: inN.nb.length + outN.nb.length };
}

let pd = new Float64Array(N);
let pv = new Int32Array(N);
let pn = 0;
function pqPush(p: number, v: number): void { let i = pn++; pd[i] = p; pv[i] = v; while (i > 0) { const par = (i - 1) >> 1; if (pd[par] <= pd[i]) break; const t = pd[par]; pd[par] = pd[i]; pd[i] = t; const tv = pv[par]; pv[par] = pv[i]; pv[i] = tv; i = par; } }
function pqPop(): number { const rv = pv[0]; pn--; if (pn > 0) { pd[0] = pd[pn]; pv[0] = pv[pn]; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < pn && pd[l] < pd[s]) s = l; if (r < pn && pd[r] < pd[s]) s = r; if (s === i) break; const t = pd[s]; pd[s] = pd[i]; pd[i] = t; const tv = pv[s]; pv[s] = pv[i]; pv[i] = tv; i = s; } } return rv; }
const pqTop = (): number => (pn > 0 ? pd[0] : Infinity);

for (let v = 0; v < N; v++) { const r = contract(v, false); pqPush(r.added - r.deg + contractedNb[v], v); }
console.log(`• initial ordering in ${Date.now() - tStart}ms`);

let order = 0;
while (pn > 0) {
  const v = pqPop();
  if (contracted[v]) continue;
  const sim = contract(v, false);
  const pri = sim.added - sim.deg + contractedNb[v];
  if (pn > 0 && pri > pqTop() + 1e-9) { pqPush(pri, v); continue; }
  contract(v, true);
  contracted[v] = 1; level[v] = order++;
  const oN = activeOut(v); const iN = activeIn(v);
  for (const x of oN.nb) contractedNb[x]++;
  for (const x of iN.nb) contractedNb[x]++;
}

const edges: [number, number, number, number][] = [];
let shortcutCount = 0;
for (let u = 0; u < N; u++) {
  const t = oTo[u];
  for (let i = 0; i < t.length; i++) { edges.push([u, t[i], oW[u][i], oMid[u][i]]); if (oMid[u][i] !== -1) shortcutCount++; }
}

const out = {
  meta: {
    generated: new Date().toISOString(),
    nodeCount: N,
    origEdgeCount: data.edges.length,
    augEdgeCount: edges.length,
    shortcutCount,
    maxSettled: MAX_SETTLED,
    directed: true,
  },
  level: Array.from(level),
  edges,
};
writeFileSync(OUTPUT, JSON.stringify(out));

console.log(`\n✔ Directed CH built → public/bengaluru-ch.json`);
console.log(`  preprocessing time:  ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
console.log(`  directed shortcuts:  ${shortcutCount.toLocaleString()}`);
console.log(`  total directed edges:${edges.length.toLocaleString()} (was ${data.edges.length.toLocaleString()})`);
