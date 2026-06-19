/**
 * build-graph.ts — the OSM → routable-graph pipeline.
 *
 * Run once with `npm run build-graph`. It downloads Bengaluru's drivable roads
 * from the OpenStreetMap Overpass API, turns that raw geometry into a clean
 * routing graph (intersections = nodes, road segments = weighted edges), keeps
 * only the largest connected component, and writes a compact JSON the app loads
 * at runtime.
 *
 * WHY A SEPARATE BUILD STEP? Parsing OSM is slow and network-bound; routing must
 * be instant. So we pay that cost once, offline, and ship a small pre-built graph.
 * The raw Overpass response is also cached to disk, so re-running to tweak the
 * graph-building logic doesn't re-hit Overpass (be a good API citizen).
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { haversine } from "../src/engine/geo";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- Configuration ---------------------------------------------------------

/** Bounding box covering Bengaluru's urban core (Electronic City → Whitefield). */
const BBOX = { south: 12.82, west: 77.45, north: 13.1, east: 77.78 } as const;

/**
 * Road classes we keep — the ones cars actually drive on. We deliberately
 * EXCLUDE footway/path/cycleway/service so the driving graph stays manageable
 * and realistic. `*_link` covers slip roads / ramps between classified roads.
 */
const HIGHWAY_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
] as const;

const OVERPASS_URL =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

const CACHE_DIR = resolve(ROOT, "scripts", ".cache");
const CACHE_FILE = resolve(CACHE_DIR, "overpass-bengaluru.json");
const OUTPUT_FILE = resolve(ROOT, "public", "bengaluru-graph.json");

// --- Overpass types (only the fields we use) -------------------------------

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  // node
  lat?: number;
  lon?: number;
  // way
  nodes?: number[];
  tags?: Record<string, string>;
}
interface OverpassResponse {
  elements: OverpassElement[];
}

// --- Step 1: fetch (with disk cache) ---------------------------------------

function buildQuery(): string {
  const filter = HIGHWAY_CLASSES.join("|");
  const { south, west, north, east } = BBOX;
  // (._;>;); pulls in every node referenced by the matched ways so we get their
  // coordinates. `out body` includes way tags + node refs we need to rebuild it.
  return `
    [out:json][timeout:180];
    (
      way["highway"~"^(${filter})$"](${south},${west},${north},${east});
    );
    (._;>;);
    out body;
  `;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchOverpass(): Promise<OverpassResponse> {
  if (await fileExists(CACHE_FILE)) {
    console.log(`• Using cached Overpass response: ${CACHE_FILE}`);
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as OverpassResponse;
  }

  console.log(`• Fetching drivable roads from Overpass (${OVERPASS_URL}) …`);
  console.log("  (this is one request and can take 30–120s for this bbox)");

  // Politeness + safety: a single request with a generous-but-bounded timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass sits behind a proxy/CDN that returns 406 to requests with no
        // (or a non-browser-like) User-Agent. A descriptive UA also identifies us
        // politely, as the Overpass usage policy asks.
        "User-Agent": "RouteEngine/0.1 (portfolio project; OSM routing demo)",
        Accept: "application/json",
      },
      body: "data=" + encodeURIComponent(buildQuery()),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Overpass returned HTTP ${res.status} ${res.statusText}`);
    }
    // Overpass occasionally answers 200 with an HTML/text error (e.g. rate limit)
    // rather than JSON, so parse defensively and surface a readable snippet.
    const text = await res.text();
    let json: OverpassResponse;
    try {
      json = JSON.parse(text) as OverpassResponse;
    } catch {
      throw new Error(
        `Overpass did not return JSON. First 200 chars:\n${text.slice(0, 200)}`,
      );
    }
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(json));
    console.log(`• Cached raw response to ${CACHE_FILE}`);
    return json;
  } catch (err) {
    console.error(
      "\n✖ Overpass fetch failed. Tips:\n" +
        "  - It may be temporarily overloaded — wait a minute and retry.\n" +
        "  - Try a mirror, e.g.  OVERPASS_URL=https://overpass.kumi.systems/api/interpreter npm run build-graph\n" +
        "  - Or shrink the bbox in BBOX, or use a Geofabrik Karnataka extract.\n",
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Step 2: turn OSM into a graph -----------------------------------------

function isOneway(tags: Record<string, string>): boolean {
  const ow = tags.oneway;
  if (ow === "yes" || ow === "true" || ow === "1" || ow === "-1") return true;
  // Motorways and their links are implicitly one-way in OSM convention.
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return true;
  return false;
}

interface RawEdge {
  a: number; // OSM node id
  b: number; // OSM node id
  length: number; // meters
  highway: string;
  oneway: boolean;
}

function buildGraph(osm: OverpassResponse) {
  // Index node coordinates by OSM id.
  const coordById = new Map<number, [number, number]>();
  for (const el of osm.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      coordById.set(el.id, [el.lon, el.lat]); // [lng, lat]
    }
  }

  const ways = osm.elements.filter(
    (el): el is OverpassElement & { nodes: number[]; tags: Record<string, string> } =>
      el.type === "way" && Array.isArray(el.nodes) && !!el.tags?.highway,
  );

  // Count how many KEPT ways each OSM node belongs to. A node that appears in two
  // or more ways is a true intersection; a way's first/last node is an endpoint.
  // Both become graph nodes — everything in between is just shape and gets
  // collapsed into a single weighted edge.
  const usage = new Map<number, number>();
  for (const way of ways) {
    for (const nid of way.nodes) usage.set(nid, (usage.get(nid) ?? 0) + 1);
  }

  const isGraphNode = (nid: number, way: number[], idx: number): boolean =>
    idx === 0 || idx === way.length - 1 || (usage.get(nid) ?? 0) >= 2;

  // Walk each way, emitting one edge per span between consecutive graph nodes,
  // weighted by the summed haversine length of the shape points along that span.
  const rawEdges: RawEdge[] = [];
  for (const way of ways) {
    const ns = way.nodes;
    let segStart = ns[0];
    let segLen = 0;
    const oneway = isOneway(way.tags);
    const highway = way.tags.highway;

    for (let i = 1; i < ns.length; i++) {
      const prev = coordById.get(ns[i - 1]);
      const cur = coordById.get(ns[i]);
      if (!prev || !cur) continue; // node outside bbox; skip this hop
      segLen += haversine(prev, cur);

      if (isGraphNode(ns[i], ns, i)) {
        if (ns[i] !== segStart && segLen > 0) {
          rawEdges.push({ a: segStart, b: ns[i], length: segLen, highway, oneway });
        }
        segStart = ns[i];
        segLen = 0;
      }
    }
  }

  return { rawEdges, coordById };
}

// --- Step 3: largest connected component + compaction ----------------------

function largestComponent(rawEdges: RawEdge[]): Set<number> {
  // Build an undirected adjacency over OSM ids (Phase 0 treats roads as
  // bidirectional, so connectivity is undirected too).
  const adj = new Map<number, number[]>();
  const add = (x: number, y: number) => {
    const list = adj.get(x);
    if (list) list.push(y);
    else adj.set(x, [y]);
  };
  for (const e of rawEdges) {
    add(e.a, e.b);
    add(e.b, e.a);
  }

  const seen = new Set<number>();
  let best = new Set<number>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Iterative BFS (avoids blowing the call stack on a big component).
    const comp = new Set<number>();
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const node = queue.pop()!;
      comp.add(node);
      for (const nb of adj.get(node) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

async function main() {
  const osm = await fetchOverpass();
  console.log(`• Overpass returned ${osm.elements.length} raw elements`);

  const { rawEdges, coordById } = buildGraph(osm);
  console.log(`• Extracted ${rawEdges.length} raw edges before cleanup`);

  // Keep only edges whose both endpoints sit in the largest connected component,
  // discarding disconnected fragments (a node on an island can't be routed to).
  const keep = largestComponent(rawEdges);
  const compEdges = rawEdges.filter((e) => keep.has(e.a) && keep.has(e.b));

  // De-duplicate parallel segments between the same pair of nodes, keeping the
  // shortest. Two OSM ways sometimes trace the same physical link.
  const dedup = new Map<string, RawEdge>();
  for (const e of compEdges) {
    const key = e.a < e.b ? `${e.a}_${e.b}` : `${e.b}_${e.a}`;
    const existing = dedup.get(key);
    if (!existing || e.length < existing.length) dedup.set(key, e);
  }
  const finalEdges = [...dedup.values()];

  // Compact re-indexing: map surviving OSM ids → dense 0..N-1 internal ids.
  const idMap = new Map<number, number>();
  const nodes: number[][] = [];
  const internalId = (osmId: number): number => {
    let id = idMap.get(osmId);
    if (id === undefined) {
      id = nodes.length;
      idMap.set(osmId, id);
      const c = coordById.get(osmId)!;
      // Round to 6 decimals (~0.11 m) to shrink the JSON without visible loss.
      nodes.push([+c[0].toFixed(6), +c[1].toFixed(6)]);
    }
    return id;
  };

  // Build the highway-type lookup table so edges store a small index, not a string.
  const highwayTypes: string[] = [];
  const highwayIndex = new Map<string, number>();
  const hwIdx = (h: string): number => {
    let i = highwayIndex.get(h);
    if (i === undefined) {
      i = highwayTypes.length;
      highwayTypes.push(h);
      highwayIndex.set(h, i);
    }
    return i;
  };

  const edges: [number, number, number, number, number][] = finalEdges.map((e) => [
    internalId(e.a),
    internalId(e.b),
    Math.round(e.length), // meters, integer is plenty precise
    hwIdx(e.highway),
    e.oneway ? 1 : 0,
  ]);

  const out = {
    meta: {
      bbox: [BBOX.south, BBOX.west, BBOX.north, BBOX.east] as [
        number,
        number,
        number,
        number,
      ],
      generated: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      highwayTypes,
    },
    nodes,
    edges,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(out));

  console.log("\n✔ Graph built and written to public/bengaluru-graph.json");
  console.log(`  nodes: ${nodes.length.toLocaleString()}`);
  console.log(`  edges: ${edges.length.toLocaleString()}`);
  console.log(`  road classes: ${highwayTypes.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
