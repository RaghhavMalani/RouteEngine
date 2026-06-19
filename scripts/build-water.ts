/**
 * build-water.ts — OPTIONAL context layer.
 *
 * Fetches Bengaluru's water bodies (lakes/tanks/rivers) from Overpass and writes a
 * small GeoJSON the app renders as faint dark shapes behind the road model. The app
 * works fine without this; it's purely for geographic context.
 *
 *   npm run build-water
 *
 * Like build-graph, it sends a descriptive User-Agent (Overpass rejects requests
 * without one) and is a single polite request.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, "public", "bengaluru-water.json");

const BBOX = { south: 12.82, west: 77.45, north: 13.1, east: 77.78 };
const OVERPASS_URL =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

interface OEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}

function query(): string {
  const { south, west, north, east } = BBOX;
  // Closed ways tagged as water/lakes/reservoirs. (We keep it simple: ways only.)
  return `
    [out:json][timeout:120];
    (
      way["natural"="water"](${south},${west},${north},${east});
      way["water"](${south},${west},${north},${east});
      way["landuse"="reservoir"](${south},${west},${north},${east});
    );
    (._;>;);
    out body;
  `;
}

async function main() {
  console.log("• Fetching Bengaluru water bodies from Overpass …");
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RouteEngine/0.1 (portfolio project; OSM water context)",
      Accept: "application/json",
    },
    body: "data=" + encodeURIComponent(query()),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { elements: OEl[] };

  const coordById = new Map<number, [number, number]>();
  for (const el of data.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      coordById.set(el.id, [el.lon, el.lat]);
    }
  }

  const features: unknown[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 4) continue;
    const ring: [number, number][] = [];
    for (const nid of el.nodes) {
      const c = coordById.get(nid);
      if (c) ring.push([+c[0].toFixed(6), +c[1].toFixed(6)]);
    }
    if (ring.length < 4) continue;
    // Close the ring if needed.
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  const fc = { type: "FeatureCollection", features };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(fc));
  console.log(`✔ Wrote ${features.length} water polygons to public/bengaluru-water.json`);
}

main().catch((err) => {
  console.error("✖ build-water failed:", err.message);
  console.error("  (this layer is optional — the app runs fine without it.)");
  process.exit(1);
});
