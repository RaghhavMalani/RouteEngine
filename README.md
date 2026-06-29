# RouteEngine

A cinematic, interactive visualizer of how map-routing algorithms actually work,
built on the **real road network of Bengaluru** (220,723 nodes / 279,814 edges
straight from OpenStreetMap). The city is rendered as a clean, dark **3D model** —
not a map — and the app plays a **staged construction sequence**: the *same* route
is solved by escalating methods, each stage visibly rebuilding on the last, like an
architectural fly-through where a building goes foundation → skeleton → finished.

Pick a source and destination, press **Build**, and watch **Stage 1 (Dijkstra)**
flood outward in every direction. Press **Next** and the model *reforms* into
**Stage 2 (A\*)** — a focused beam aimed at the goal. Press **Next** again to reach
**Stage 3 (Contraction Hierarchies)** — the "production" model that assembles into a
layered hierarchy and then barely searches: two short funnels climb from the source
and the target and meet in the middle, touching a few hundred nodes instead of a
hundred thousand. A three-way compare card shows the payoff: same optimal route, a
tiny fraction of the work. Press **Next** once more for **Stage 4 (What You Actually
See)** — all the machinery fades away and you're left with the one calm route a maps
app would show, plus an ETA. A **Play full sequence** button auto-plays all four
stages end-to-end for a screen recording.

---

## The staged construction sequence

Each stage is a different routing **method**, presented as a refinement of the one
before. The route never changes — only how cleverly we search for it.

| Stage | Method | Status |
| --- | --- | --- |
| **Model 1 — Brute Force** | Dijkstra | available |
| **Model 2 — Guided Search** | A\* (admissible heuristic) | available |
| **Model 3 — Production** | Contraction Hierarchies | available |
| **Model 4 — What You Actually See** | clean route + ETA | available |

All four stages are now live. (Stage 3 shows locked only until its precomputed CH
cache finishes loading; Stage 4 reuses the CH route, so it needs Stage 3 first.)

**Height encodes the method.** In Stages 1–2, every explored node and edge is lifted
off the ground by its **cost-from-source** `g(n)`. Dijkstra rises as a smooth,
**symmetric dome** centred on the source (it explores by increasing cost, uniformly in
all directions); A\* rises as a narrow, **directed ridge** running toward the goal. In
**Stage 3, height instead encodes a node's LEVEL / importance**, so arterial high-level
roads lift toward the top and the graph reads as a layered hierarchy — the search then
visibly *climbs* it. The reform animation between stages retracts the old shape and
regrows the new one over ~1.2s — the "construction" beat.

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

| | Dijkstra | A\* | CH |
| --- | --- | --- | --- |
| Nodes explored | 96,830 | 13,554 | **846** |
| Route distance | 20.95 km | 20.95 km | 20.95 km |

Same 20.95 km path every time — A\* reached it exploring ~14% of Dijkstra's nodes, and
Contraction Hierarchies reached it touching **846 nodes (~0.9%)**. Escalating method,
identical answer, dramatically less work.

### Stage 2 → Stage 3: Contraction Hierarchies (the production model)

A\* is cleverer than Dijkstra, but it still searches *live* over the raw road graph. A
real routing service does most of the work **ahead of time**. Contraction Hierarchies
(CH) is the classic technique for that, and it is what Stage 3 makes visible.

**Offline — preprocessing (`scripts/build-ch.ts`, run once).** We rank every node by
*importance* and "contract" them one at a time from least to most important. Contracting
a node `v` means removing it and, for any pair of its neighbours whose shortest path went
through `v`, adding a **shortcut edge** that preserves that distance — labelled with the
node it bypasses. To decide whether a shortcut is actually needed we run a **witness
search**: a small local Dijkstra from one neighbour that looks for an alternative path no
longer than the shortcut. If one exists, no shortcut is added. Node order is chosen with a
**lazy priority queue** keyed by *edge difference* (shortcuts a contraction would add minus
the edges it removes), plus a contracted-neighbours term to spread the order out. Each node
also records its **level** (its contraction rank). The result — original edges + shortcuts +
levels — is cached to `public/bengaluru-ch.json`.

**Online — the query (`src/engine/ch.ts`).** A query is a **bidirectional** search: one
Dijkstra climbs *up* the hierarchy from the source, another climbs *up* from the target,
and **each side only ever relaxes edges to a strictly higher level**. Because both sides
move only upward, they each explore a small funnel and meet near the top. We track the
**meeting node** that minimises forward + backward distance, then walk back through both
parent trees to get the path in shortcut space. Finally we **unpack** each shortcut
recursively — replacing it with its two halves via the stored middle node — down to
original road edges, so the displayed ribbon follows **real Bengaluru roads**, never a
straight shortcut line.

**Why it's still optimal.** A correct contraction never changes shortest-path distances:
every shortcut equals the path it replaces, and the upward-only bidirectional search is a
theorem-backed property of the hierarchy. We don't take that on faith — a **correctness
gate** runs 200 random source/target pairs through both plain Dijkstra and the CH query;
distances match **exactly** (max error `0`), and every unpacked route is a contiguous chain
of real edges whose length equals the true shortest distance.

**Honest caveats (interview-ready).** The node ordering is a *heuristic* and the witness
search is *bounded* (capped at a few hundred settled nodes), so a few unnecessary shortcuts
get added — standard CH engineering. On this graph preprocessing takes **~8s** and adds
**~270k shortcuts** (≈1× the original edge count). That doesn't affect correctness; a
slightly larger hierarchy just means a few extra edges, never a wrong or longer route.

### Stage 3 → Stage 4: What You Actually See (the product)

Stage 4 is **subtraction**. The whole sequence has been about the machinery; the closer
takes it all away. Entering Stage 4, every search layer (flood, frontier, hierarchy,
shortcut arcs) fades out, the camera eases down to a calmer, closer view, and you're left
with exactly what a consumer maps app shows: **clean pins and one smooth route line** (the
Stage 3 CH path, unpacked to real roads) in a restrained accent colour — plus a route card.

**The ETA.** The card shows estimated travel time, distance, the dominant road ("via …"),
and an arrival clock. The time is a genuine **free-flow estimate**: each OSM road class is
given a typical free-flow speed (motorway/trunk fast, primary/secondary medium, residential
slow) and the route's per-segment times are summed (`src/engine/eta.ts`). On Electronic City
→ Whitefield that's **20.95 km ≈ 41 min** via primary roads.

**Honest caveats.** This is *free-flow* time (empty roads), **not** traffic-aware, and the
displayed route is **distance-optimal** (from CH), not yet time-optimal. The per-class speed
table is deliberately the hook for the next arc: swap those constants for live/historical
per-edge speeds and the same summation becomes a traffic-aware ETA; feed them back as edge
weights and the route becomes time-optimal. A small **"Show what really happened"** control
jumps back to the Stage 3 technical view so a viewer can connect the clean result to the
machinery behind it.

**Demo Mode.** *Play full sequence* auto-selects Electronic City → Whitefield and auto-runs
Stage 1 → 2 → 3 → 4 with a caption per stage and a corner wordmark — a ~30–60s hands-free
take for a screen recording, ending on the clean route and the punchline.

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

`DijkstraPathfinder` (Stage 1), `AStarPathfinder` (Stage 2), and `CHPathfinder`
(Stage 3) are *three implementations of this same interface*. The staged UI just asks
each stage's pathfinder for a result — swapping algorithms never touches the rendering
or animation code, which is exactly why CH dropped in by reusing the same exploration
log and animation pipeline as the other two.

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
- **Stage 3 reads differently on purpose.** Height switches to node *level*, so the
  reveal first assembles a stylised hierarchy — level-raised landmark nodes plus a
  capped sample of shortcut **arcs** (deck.gl `ArcLayer`) sweeping over the city — and
  then plays the bidirectional query in **two colours** (forward from source, backward
  from target) climbing to their meeting node, with the unpacked real-road route as the
  bright hero ribbon. Sampling the arcs/landmarks (not all ~270k shortcuts) is what
  keeps the build beat at 60fps.

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
npm run build-ch     # ONE-TIME: precompute the Contraction Hierarchies (~8s) for Stage 3
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
which builds Stage 1 instantly). Press **Build** to play **Stage 1 (Dijkstra)**,
**Next → A\*** to watch the model reform into **Stage 2**, and **Next → CH** to reform
into **Stage 3 (Contraction Hierarchies)** — the hierarchy assembles, then the
bidirectional search meets in the middle and the **three-way compare card** shows the
Dijkstra-vs-A\*-vs-CH numbers. The **speed** slider controls the reveal rate. Model 4
remains locked on the timeline as the roadmap.

---

## Project structure

```
scripts/build-graph.ts      OSM → graph pipeline (run once)
scripts/build-ch.ts         Contraction Hierarchies preprocessing (run once)
scripts/build-water.ts      OSM → water polygons (optional context)
public/bengaluru-graph.json  generated graph (created by build-graph)
public/bengaluru-ch.json     augmented graph + levels + shortcuts (created by build-ch)

src/engine/                 pure TypeScript routing engine (no UI imports)
  types.ts                    shared types + the Pathfinder interface
  graph.ts                    adjacency-list graph, loaded from JSON
  heap.ts                     binary min-heap priority queue
  dijkstra.ts                 Stage 1: Dijkstra + exploration log + stats
  astar.ts                    Stage 2: A* (g + haversine h), same interface
  ch.ts                       Stage 3: CH query (bidirectional + unpacking)
  eta.ts                      Stage 4: free-flow ETA from per-road-class speeds
  nearest.ts                  snap a clicked lng/lat to the closest node
  geo.ts                      haversine distance (used as weight AND A* heuristic)
  pathfinder.ts               public barrel + Pathfinder interface

src/stages.ts               the staged sequence (Models 1–4, all live)

src/map/
  MapView.tsx                 blank dark stage + deck.gl model + cinematic camera
  layers.ts                   road model + per-stage frontier/route layers

src/ui/
  Intro.tsx                   cinematic title card on load
  ControlPanel.tsx            endpoints, quick-picks, speed, Build/Next, Play demo
  StageTimeline.tsx           the construction-phases indicator
  Metrics.tsx                 per-stage live metrics HUD
  CompareCard.tsx             Dijkstra-vs-A*-vs-CH payoff card (truthful per-row)
  RouteCard.tsx               Stage 4 consumer route sheet (ETA / distance / via)

src/App.tsx                  stage state machine + reform + camera + Demo Mode
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
city route). **Contraction Hierarchies** passes a mandatory correctness gate before it
is ever used: 200 random source/target pairs are solved with both plain Dijkstra and
the CH query, and the distances match **exactly** (max error `0`); additionally every
unpacked CH route is checked to be a contiguous chain of real road edges whose summed
length equals the true shortest distance (also exact). The build pipeline's
intersection-collapse and largest-component logic were validated on a synthetic OSM
payload with a known topology.

---

## Phase 5 — Traffic-aware routing & live rerouting

The **Traffic** mode (toggle at the top of the panel) shifts the objective from
distance to **travel time**. Every edge's weight becomes

```
time(seconds) = length / (freeFlowSpeed(roadClass) × congestionFactor)
```

where `congestionFactor` retains 100 % of free-flow at **FREE**, 60 % at **MODERATE**,
35 % at **HEAVY**, and 0 % at **BLOCKED** (a closure — effectively infinite time).

**Simulated traffic (honest).** Congestion is *modelled*, not a live feed. It is driven
by **time of day** — arterials and highways clog toward the 9 am and 6 pm peaks and run
free overnight — with a mild "closer to the centre is worse" bias, so it has a plausible
shape rather than being random noise. The time-of-day slider re-colours the network
(green / amber / red on arterials) and re-weights the graph. Because the longer road can
be faster once the short one is jammed, the panel shows both candidate routes with their
distance **and** time and highlights the time-winner (the "shorter-but-slower vs
longer-but-faster" teaching moment; one-click via *Show me a rush-hour detour*).

**Live rerouting.** A vehicle drives the current route. *Inject incident* closes a road
just ahead of it and the engine **recomputes from the vehicle's current node to the
destination** on the updated time-weights (a directed A\*), and the car switches onto the
new route. The recompute time is reported in the panel (low-tens of ms at this scale —
fast enough to do on every change, which is exactly why we reroute on Dijkstra/A\* here
and **not** on CH).

### Honest scope note — why not CH for rerouting?

Contraction Hierarchies precomputes shortcuts **against a fixed metric**. The moment edge
weights change (traffic, a closure), those shortcuts are stale, so a CH query on the new
weights can be wrong. Rebuilding the whole hierarchy per change is far too slow. The
production answer is **Customizable Route Planning (CRP)** / **Customizable Contraction
Hierarchies (CCH)**: split preprocessing into a slow **metric-independent** phase (over
the topology alone) and a fast **customization** phase that re-weights the precomputed
structure whenever the metric changes, keeping queries fast.

This phase deliberately stops short of CRP/CCH (it reroutes on plain directed A\*), but the
code leaves a clean seam for it: `engine/traffic.ts` separates the **graph (topology,
metric-independent)** from a **`TrafficModel` (the metric)**. Today a reroute builds a
fresh `TrafficModel` and re-runs A\*; a future customization phase would slot in at exactly
that boundary — re-weighting a precomputed structure — **without** touching the engine or
the topology.

---

## Roadmap

All four models plus traffic-aware routing and live rerouting are built. Next:

- **Customizable Route Planning (CRP / CCH):** a metric-independent preprocessing phase +
  a fast customization pass, so traffic-aware queries stay CH-fast (the `TrafficModel`
  seam above is where this plugs in).
- Turn restrictions (edge-based / turn-expanded graph) on top of the existing one-way
  directed graph.
- A real traffic provider replacing the simulated time-of-day model (same `TrafficModel`
  interface).
