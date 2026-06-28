/**
 * build-turn-restrictions.ts — fetch OSM turn restrictions for Bengaluru.
 *
 * Run with `npm run build-turns` (needs internet; the sandbox can't reach
 * Overpass, so run it locally). It pulls every `type=restriction` relation in the
 * bbox — "no_right_turn", "no_u_turn", "only_straight_on", etc. — and writes the
 * raw rules (from-way → via-node/way → to-way + type) to
 * `public/turn-restrictions.json`.
 *
 * STATUS / NEXT STEPS (honest): this script does the *data acquisition*. To make
 * the router obey these rules end-to-end you still need:
 *   1. build-graph.ts to PRESERVE OSM way + node ids on each edge (it currently
 *      discards them when it collapses ways into edges), so a restriction's OSM
 *      way ids can be mapped to our internal edges.
 *   2. A turn-aware routing layer — the standard approach is an EDGE-BASED graph
 *      (nodes = directed edges, arcs = legal turns) so a forbidden turn is simply
 *      an arc you don't add; CH then runs on that edge graph unchanged.
 * One-way handling (already shipped) removes the majority of illegal-turn cases;
 * explicit turn signs are the remaining few this pipeline targets.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, "public", "turn-restrictions.json");

const BBOX = { south: 12.82, west: 77.45, north: 13.1, east: 77.78 } as const;
const OVERPASS_URL =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

interface OverpassMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}
interface OverpassElement {
  type: string;
  id: number;
  members?: OverpassMember[];
  tags?: Record<string, string>;
}

function query(): string {
  const { south, west, north, east } = BBOX;
  return `
    [out:json][timeout:180];
    relation["type"="restriction"](${south},${west},${north},${east});
    out body;
  `;
}

async function main() {
  console.log(`• Fetching turn restrictions from Overpass (${OVERPASS_URL}) …`);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RouteEngine/0.1 (portfolio project; OSM routing demo)",
      Accept: "application/json",
    },
    body: "data=" + encodeURIComponent(query()),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { elements: OverpassElement[] };

  const rules = [];
  for (const el of json.elements) {
    if (el.type !== "relation" || !el.members || !el.tags?.restriction) continue;
    const from = el.members.find((m) => m.role === "from" && m.type === "way");
    const to = el.members.find((m) => m.role === "to" && m.type === "way");
    const via = el.members.find((m) => m.role === "via");
    if (!from || !to || !via) continue;
    rules.push({
      id: el.id,
      restriction: el.tags.restriction, // e.g. no_right_turn, no_u_turn, only_left_turn
      fromWay: from.ref,
      toWay: to.ref,
      viaType: via.type, // node | way
      viaRef: via.ref,
    });
  }

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(
    OUTPUT,
    JSON.stringify({ meta: { generated: new Date().toISOString(), count: rules.length }, rules }),
  );
  console.log(`\n✔ Wrote ${rules.length.toLocaleString()} turn restrictions → public/turn-restrictions.json`);
  console.log("  (see the header comment for how to apply them in the router)");
}

main().catch((err) => {
  console.error("\n✖ Turn-restriction fetch failed:", err.message);
  console.error("  Try a mirror: OVERPASS_URL=https://overpass.kumi.systems/api/interpreter npm run build-turns");
  process.exit(1);
});
