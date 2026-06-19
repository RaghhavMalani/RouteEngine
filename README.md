# RouteEngine

A cinematic, interactive visualizer of how map-routing algorithms actually work,
built on the **real road network of Bengaluru** (220,723 nodes / 279,814 edges
straight from OpenStreetMap). The city is rendered as a clean, dark **3D model** —
not a map — and the app plays a **staged construction sequence**: the *same* route
is solved by escalating methods, each stage visibly rebuilding on the last, like an
architectural fly-through where a building goes foundation → skeleton → finished.

Pick a source and destination, press **Build**, and watch **Stage 1 (Dijkstra)**
flood outward in every direction. Press **Next** and the model *reforms* into
**Stage 2 (A\*)** — a focused beam aimed at the goal — then a compare card shows the
payoff: same optimal route, a fraction of the work.

---

## The staged construction sequence

Each stage is a different routing **method**, presented as a refinement of the one
before. The route never changes — only how cleverly we search for it.

| Stage | Method | Status |
| --- | --- | --- |
| **Model 1 — Brute Force** | Dijkstra | available |
| **Model 2 — Guided Search** | A\* (admissible heuristic) | available |
| **Model 3 — Production** | Contraction Hierarchies | locked (coming) |
| **Model 4 — What You Actually See** | clean route + ETA | locked (coming) |

Locked stages render greyed with a lock — they double as a visible roadmap.

**Height = g(n).** In both live stages, every explored node and edge is lifted off
the ground by its **cost-from-source** `g(n)`. This makes the *method* visible:
Dijkstra rises as a smooth, **symmetric dome** centred on the source (it explores by
increasing cost, uniformly in all directions). A\* rises as a narrow, **directed
ridge** running toward the goal. The reform animation between stages retracts the
dome and regrows the ridge over ~1.2s — the "construction" beat.

### Stage 1 → Stage 2: why A\* is the refinement

Dijkstra has no idea where the destination is; it expands the closest-by-cost node
every time, so it explores a roughly circular flood. **A\*** keeps Dijkstra's
machinery but changes the priority from `g(n)` to `f(n) = g(n) + h(n)`, where
`h(n)` is a **guess of the remaining distance** to the goal. We use the **haversine
straight-line distance** from `n` to the destination. Because a straight line is the
shortest possible distance, `h` never overestimates — it is **admissible**, which
guarantees A\* still returns the **provably optimal** path, identical to Dijkstra's.
It's also **consistent** (triangle inequality), so the same clean settled-set loop
works with no re-expansions.

On the demo route **Electronic City → Whitefield**, measured on the real graph:

| | Dijkstra | A\* |
| --- | --- | --- |
| Nodes explored | 96,830 | **13,554** |
| Edges relaxed | 107,667 | **15,145** |
| Route distance | 20.95 km | 20.95 km |

Same 20.95 km path — A\* just reached it exploring **~14% of the nodes**. That is the
whole point of the heuristic, made visible.

---

## How the search is built and animated

1. **Builds a routing graph from OpenStreetMap.** A one-time Node script downloads
   Bengaluru's drivable roads from the Overpass API and converts the raw geometry
   into a compact graph of intersections and weighted road segments.
2. **Routes in the browser.** A dependency-free TypeScript engine loads that graph;
   `DijkstraPathfinder` and `AStarPathfinder` are two implementations of one
   `Pathfinder` interface, so adding a method doesn't touch the UI.
3. **Animates the search.** Each algorithm runs once and records an *exploration
   log* (settled nodes + relaxed edges, each tagged with its cost `g`); the UI
   replays that log frame by frame. The algorithm is never re-run to draw frames.

---

## The graph model — how OSM becomes nodes and edges

OpenStreetMap gives you **ways** (ordered lists of points that trace a road) and
**nodes** (points with coordinates). That is *geometry*, not a *graph* — a single
way can be a kilometre long with dozens of shape points and several junctions
along it. You can't route on it directly.

The pipeline (`scripts/build-graph.ts`) turns geometry into a graph:

- **Keep only drivable roads.** We query ways tagged
  `highway = motorway | trunk | primary | secondary | tertiary | unclassified |
  residential | *_link`, and exclude footways, paths, cycleways, and service
  roads so the graph stays a *driving* graph.
- **Find the real nodes.** A point becomes a graph node if it is an
  **intersection** (it appears in two or more kept ways) or a **way endpoint**.
  Everything in between is just shape and gets collapsed away.
- **Build weighted edges.** Between two consecutive graph nodes along a way, we
  emit one edge whose weight is the **summed haversine length** (in meters) of all
  the little shape segments in between. Haversine (great-circle distance) is used
  instead of planar distance because a degree of longitude in Bengaluru is shorter
  than a degree of latitude — ignoring the Earth's curvature would skew weights.
- **Keep the largest connected component.** Disconnected fragments (a stub road
  that doesn't actually link to the rest of the city in our data) are discarded,
  because you can never route to or from them.
- **Compact the output.** Surviving nodes are re-indexed to a dense `0…N-1` range
  and written as plain number arrays (not objects) so the JSON stays small and
  parses fast. Each edge also stores its `highway` class and `oneway` flag — unused
  today, but kept so later phases get them for free.

The result is `public/bengaluru-graph.json`, an adjacency list the app loads once
at startup.

---

## How Dijkstra works here

**The idea in one sentence:** grow a set of nodes whose shortest distance from the
source is known *for certain*, always expanding next from the closest unfinished
node — because once that closest node is reached, no longer route could ever beat
it. (This is exactly why Dijkstra requires non-negative weights, which physical
road lengths always satisfy.)

Concretely (`src/engine/dijkstra.ts`):

- A **binary min-heap priority queue** (`src/engine/heap.ts`) always hands us the
  unsettled node with the smallest tentative distance. This is what makes the
  algorithm `O((V + E) log V)` instead of `O(V²)` — the difference between usable
  and unusable on a city-sized graph.
- We **relax** each edge out of the node we just settled: if going through it gives
  a shorter tentative distance to a neighbour, we record the improvement and push
  the neighbour onto the heap.
- The heap uses **lazy deletion** rather than a `decrease-key` operation: instead of
  mutating an entry already in the queue, we push a fresh, better one and skip the
  stale entry when it surfaces. This keeps the heap code simple at the cost of a
  few extra entries — a deliberate readability trade-off.
- We **stop early** the moment the destination is settled: its distance is final
  and no further exploration can improve the answer.

### Separating computation from rendering (the key design decision)

`findPath` returns three things:

```ts
{ path, log, stats }
```

- `path` — the ordered node ids of the shortest route.
- `log` — an **ordered recording of the search**: for each settled node, the edges
  that were relaxed from it. This is what the UI animates.
- `stats` — nodes explored, edges relaxed, path length (m), and compute time (ms).

The animation **never re-runs the algorithm**. Dijkstra runs once, to completion,
and writes down what it did; the UI then reveals a growing prefix of that recording
on each `requestAnimationFrame`, at a speed you control. Compute-once / render-many
is the architectural backbone of the project — it's also what will let a future A\*
or CH implementation animate through the identical UI without changing a line of it.

### The `Pathfinder` interface

Every algorithm implements one strategy interface:

```ts
interface Pathfinder {
  readonly name: string;
  findPath(graph, sourceId, targetId): { path, log, stats };
}
```

`DijkstraPathfinder` (Stage 1) and `AStarPathfinder` (Stage 2) are *two
implementations of this same interface*; Contraction Hierarchies will be a third. The
staged UI just asks each stage's pathfinder for a result — swapping algorithms never
touches the rendering or animation code.

---

## Rendering: the model + how it stays at 60fps

The scene is a **designed 3D model**, not a map. MapLibre is given an empty style
(just a dark background) so there are no tiles and no town/village labels — it serves
purely as the camera/projection engine. deck.gl draws everything: Bengaluru's full
road network as thin refined lines on the ground plane, optional water bodies as
faint dark shapes, and the current stage's search lifted off the ground by `g(n)`.
The only two labels in the whole scene are the source and destination. The camera
holds a fixed pitch and **slowly, continuously orbits**, like a lit display table.

- **Height.** Each search vertex sits at `[lng, lat, g · zFactor]`, with
  `zFactor = HEIGHT_M / maxCost` — a single committed look, no sliders.
- **Depth.** deck.gl runs **interleaved** with MapLibre (`MapboxOverlay`), sharing
  the depth buffer so the elevated geometry composites correctly as the camera orbits.
- **The reveal is done on the GPU — no per-frame array rebuilds.** The full geometry
  for a stage is built **once**. Every edge/node carries its exploration-order index
  as a filter attribute (deck.gl's `DataFilterExtension`); growing the frontier just
  moves the filter's upper bound — one uniform update per frame. With ~100k+ edges
  this is what holds interactive frame rates.
- **The reform.** Advancing Stage 1 → 2 retracts Dijkstra's reveal back to zero, swaps
  in A\*'s precomputed geometry, and regrows it — a ~1.2s morph from flood to beam,
  driven entirely by that same filter bound and an `opacity` uniform.

---

## Real-world simplifications

These are intentional, and called out here so they're honest and easy to discuss:

- **Roads are treated as bidirectional.** The `oneway` flag is parsed and stored on
  every edge, but Phase 0 adds both directions to the adjacency list and ignores
  direction. (Honouring one-ways is a later-phase switch to a true directed graph.)
- **Edge weight is physical distance in meters.** No travel time, speed limits, or
  traffic yet — those arrive in a later phase, at which point the stored `highway`
  class becomes the basis for speed estimates.
- **Largest connected component only.** Disconnected fragments are dropped, so every
  node in the graph is guaranteed routable to every other.
- **Nearest-node snapping is a linear scan.** A click rarely lands exactly on a
  junction, so we snap to the closest node by scanning all of them. For Bengaluru
  this is sub-millisecond and runs only on click. A k-d tree / grid index is the
  noted upgrade for when the region scales up.

---

## Running it

Requires Node 18+ and an internet connection for the one-time graph build.

```bash
npm install          # install dependencies
npm run build-graph  # ONE-TIME: fetch Bengaluru roads from Overpass, build the graph
npm run build-water  # OPTIONAL: faint water bodies for context (app runs without it)
npm run dev          # start Vite; open the printed localhost URL
```

`npm run build-graph` makes a single Overpass request and **caches the raw response**
to `scripts/.cache/` so re-runs (e.g. while tweaking the graph-building logic) don't
re-hit the API. It prints the final **node and edge counts** when done. If Overpass
is overloaded:

```bash
# try a mirror
OVERPASS_URL=https://overpass.kumi.systems/api/interpreter npm run build-graph
```

…or shrink the bounding box in `scripts/build-graph.ts`, or fall back to a Geofabrik
Karnataka extract.

Once the app is open: pick **Source** / **Destination** mode and click the model to
place endpoints (or hit a **quick-pick route** like *Electronic City → Whitefield*,
which builds Stage 1 instantly). Press **Build** to play **Stage 1 (Dijkstra)**, then
**Next → A\*** to watch the model reform into **Stage 2**, after which the **compare
card** shows the Dijkstra-vs-A\* numbers. The **speed** slider controls the reveal
rate. Models 3–4 are shown locked on the timeline as the roadmap.

---

## Project structure

```
scripts/build-graph.ts      OSM → graph pipeline (run once)
scripts/build-water.ts      OSM → water polygons (optional context)
public/bengaluru-graph.json  generated graph (created by build-graph)

src/engine/                 pure TypeScript routing engine (no UI imports)
  types.ts                    shared types + the Pathfinder interface
  graph.ts                    adjacency-list graph, loaded from JSON
  heap.ts                     binary min-heap priority queue
  dijkstra.ts                 Stage 1: Dijkstra + exploration log + stats
  astar.ts                    Stage 2: A* (g + haversine h), same interface
  nearest.ts                  snap a clicked lng/lat to the closest node
  geo.ts                      haversine distance (used as weight AND A* heuristic)
  pathfinder.ts               public barrel + Pathfinder interface

src/stages.ts               the staged sequence (Models 1–4; 3–4 locked)

src/map/
  MapView.tsx                 blank dark stage + deck.gl model + orbit camera
  layers.ts                   road model + per-stage frontier/route layers

src/ui/
  ControlPanel.tsx            endpoints, quick-picks, speed, Build/Next/Reset
  StageTimeline.tsx           the construction-phases indicator (with locks)
  Metrics.tsx                 per-stage live metrics HUD
  CompareCard.tsx             Dijkstra-vs-A* payoff card

src/App.tsx                  stage state machine + reform transition + clock
src/places.ts                famous Bengaluru landmarks for quick-pick routes
```

---

## Tech stack

- **Vite + React + TypeScript**
- **MapLibre GL JS** as the camera/projection engine, given an **empty style** so the
  scene is a designed model — no tiles, no labels
- **deck.gl** interleaved on MapLibre for the road model and animated search, with
  `@deck.gl/extensions`' `DataFilterExtension` for the GPU reveal
- **Plain TypeScript** routing engine (no Rust/WASM yet — correctness first)

---

## Correctness

The engine is pure and framework-free, so it's tested in isolation. **Dijkstra** was
validated against an independent Bellman-Ford across many randomized graphs (distances
must match exactly), plus hand-built graphs and unreachable-target cases. **A\*** was
validated against Dijkstra on planar graphs (where the haversine heuristic is
admissible): identical path lengths in every trial — proving optimality — while
exploring far fewer nodes (≈22% on average; ≈14% on the Electronic City → Whitefield
city route). The build pipeline's intersection-collapse and largest-component logic
were validated on a synthetic OSM payload with a known topology.

---

## Roadmap

- **Model 3 — Contraction Hierarchies:** precomputed shortcuts for near-instant queries.
- **Model 4 — Production presentation:** the clean route + ETA a rider actually sees.
- Directed graph honouring one-ways and turn restrictions.
- Travel-time weights and live traffic; dynamic rerouting.
