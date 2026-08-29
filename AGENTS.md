# AGENTS.md — guide for AI agents (and humans) working on bike-network-builder

> **Keep this file current.** When you change the architecture, add a workflow,
> learn a new gotcha, or finish/defer something in "Current state," update
> AGENTS.md in the same change. It is the first thing the next session reads.

## What this is & why it exists

The PUBLIC-FACING tool of **Malden Safe Streets (MSS)**, a nonprofit advocating
for safer cycling/walking/transit in Malden, MA: a web editor for designing a
protected-bike-lane network on a real map — draw/edit paths, phase them, pick a
color mode, import/export `network.yaml`, export PNG/HTML/GeoJSON maps.

It is being made **geography-agnostic** (Malden stays the default). The plan is
`V2_PLAN.md`; the design discussion behind it is `V2_DESIGN_NOTES.md`. **Read
V2_PLAN.md before making architectural changes** — several things that look
like obvious cleanups are deliberate, and several that look fine are on the
list to break.

This repo was extracted from a private development monorepo in 2026-07; that
private archive holds the pre-split history.

## Three parts, one contract

| Part | What it is |
|---|---|
| **The spec** | `network.yaml`. The contract. Governs both other parts. `NETWORK_FORMAT.md` documents it. |
| **The app** | `web/` — a static, framework-free, offline-capable editor. No build step. **The only editor and the only renderer.** |
| **`build.py`** | The headless Python path into the same spec: describe corridors in words, get geometry from OSM. The entry point for scripts and agents. |

**There is no Flask editor any more** (retired 2026-08, V2_PLAN.md §2). `web/`
was already a complete port, so keeping both meant building everything twice.
Do not reintroduce a Python renderer, a Python editor, or a second copy of the
palette.

**Python's remaining job** is batch data preparation plus being the *reference
reader/validator* — a second, independent implementation of the format. That
second reading is what keeps the spec honest, and it is pinned by real parity
tests (see below). Keep `bikenetwork/` stdlib + PyYAML only.

## The format (the load-bearing decision)

**v2.** `network.yaml` holds `areas` (with their boundaries), `authorities`,
`phases`, and `features` — a FEATURE is a place, its TREATMENTS are the
facilities built there. Spec: `NETWORK_FORMAT.md`. Implementation:
`bikenetwork/network_format.py` (reference) and `web/js/network_format.js` —
**keep them in step**; a parity test fails if they diverge.

**The dividing rule:** anything describing the PLACE lives on the feature;
anything describing the FACILITY lives on the treatment. Treatment fields may
be defaulted on the feature and overridden per treatment.

**Treat the format as a stable public contract.** Exported files circulate and
get re-imported. v2 was the one deliberate break (V2_PLAN.md §4.2) and spent
the whole budget; anything further needs a very good reason.

The invariants that carry the most weight:

- **Lengths are derived, never stored** — every consumer measures and
  boundary-clips the geometry itself, so a file cannot disagree with itself.
- **Geometry is a list of PARTS.** One coordinate is a point, two or more a
  line; one feature may mix both. No polymorphism, no sniffing.
- **Treatment list order is INSIGNIFICANT** — renderers order by the registry's
  `stack_rank`. NOTHING may read `treatments[0]` as primary; that is what keeps
  a future `arrangement:` key reachable without another break.
- **One shared id namespace**, always assigned.
- **Strict about structure, lenient-with-notice about vocabulary** — except
  where an unknown value would change the arithmetic. An unknown treatment
  `type` is a notice; an unknown `status` is an error.
- **`target_date` is always a QUOTED string.** YAML's implicit timestamp type
  makes an unquoted date a `date` in PyYAML and a UTC-midnight `Date` in
  js-yaml, which renders a day early west of UTC.
- Unknown top-level keys are preserved untouched (`ordinance_chapter`).

## The treatment registry

`data/treatments.json` — not the spec — defines what the tool can represent.
Adding a treatment is a registry entry, not a format change.

Each entry answers three questions, and a test enforces that all three are
answered: what `category` is it (only `bike` counts toward bicycle lane
distance), what does it `cost` (explicitly `null` when uncosted — never invent
a figure), and how does it render (`stack_rank`, colour or glyph).

`stack_rank` is DRAW ORDER ONLY, never semantics.

## Quick start

```bash
cd web && python serve.py          # the editor -> http://127.0.0.1:8613
cd web && python serve.py -n       # ...without opening a browser tab
cd web && node --test              # 144 offline JS tests

python -m venv .venv && .venv\Scripts\activate    # Windows
pip install -r requirements.txt                   # PyYAML + requests + pytest
python -m pytest -q                               # 100 offline tests
python build.py --offline -o out.yaml             # headless build from cache
```

`web/serve.py` disables caching **on purpose**. Browsers cache ES modules hard,
and a plain reload revalidates the HTML but not always its module graph — so
after an edit the page can keep running the previous `app.js` and look like it
ignored the change. If you serve `web/` some other way, disable caching there
too or you will chase ghosts.

## Conventions

- **Red/green TDD.** Write a failing test first, watch it fail, implement until
  green, refactor. Pure logic lives in small testable functions; network/IO is
  isolated behind seams and stubbed. **Both suites run offline — never add a
  test that needs the network.**
- Match the surrounding code's style; comments explain *why*, not *what*.
- The colorblind-safe **Okabe-Ito** palette lives in `web/js/render_common.js`
  and `data/treatments.json` — one copy each, shared by the editor, the PNG and
  the HTML.
- **Geometry travels WITH its feature**, never in a name-keyed dict. Duplicate
  feature names are legal everywhere except the OSM seed.
- **Distances are kilometres everywhere in the code.** Imperial is a display
  preference converted at the presentation layer and nowhere else.

## Code structure

```
build.py                    CLI: corridors.yaml + OSM -> a network.yaml. No rendering.
data/place.json             THE DEPLOYMENT'S AREA. Nothing in code names a city.
corridors.yaml              seed corridors (street names, no geometry)
fetch_layers.py             CLI (networked, untested): refresh data/layers/
network.yaml                the Malden network (also the parity-test fixture)
NETWORK_FORMAT.md           the format spec
V2_PLAN.md                  the v2 / geography-agnostic plan  <- read this
V2_DESIGN_NOTES.md          the discussion that produced it
data/treatments.json        THE REGISTRY. What the tool can represent.
tools/make_road_tiles.py    cut a street graph into roads tiles for the app
tools/fetch_existing_infra.py  batch OSM pull -> existing-infra candidates
bikenetwork/
  place.py                  reads data/place.json; derives the bbox from the boundary
  registry.py               reads data/treatments.json
  network_format.py         SHARED format module (reference reader/validator)
  migrate.py                v1 -> v2 upgrade (import only; no downgrade)
  geometry.py               haversine, bbox, Dijkstra (pure)
  boundary.py               ring assembly + containment, PURE PYTHON (no shapely)
  osm.py                    ONLY networked module: Overpass client, throttle/cache
  model.py                  corridors.yaml seed parse/validate
data/                       malden_boundary / existing_infra / committed_infra .geojson,
                            osm_cache.json, base_network.yaml (fresh-user seed),
                            street_graph.json (snap asset; also the local snap cache)
  layers/                   context layers + layers.json manifest
web/                        THE APP. index.html, app.js, style.css, help.md
  js/                       place, registry, network_format, migrate, geometry,
                            boundary, geojson, costs, pipeline, merge, routing,
                            graph (spatial index + tiles), history (undo/redo),
                            storage (IndexedDB + journal), store, zip,
                            render_common (the palette + the stacking rule),
                            render_html, render_png (canvas), export, gif
  data/                     byte-identical copies of the data assets (test-enforced)
  test/                     node --test suite
tests/                      pytest, incl. the Python<->JS parity checks
  fixtures/v1_network.yaml  Malden pre-v2. KEPT FOREVER: the shim's only test
  fixtures/v2_network.yaml  its upgrade; the parity fixture
```

## Domain knowledge / gotchas (learned the hard way)

### Geography and boundaries
- **OSM needs a bbox**, not `area["name"="Malden"]` — that matches Malden, WA
  as well as Malden, MA. The bbox is **derived from the boundary** by
  `place.bbox()`; nothing hardcodes one. Two paddings exist on purpose:
  `BBOX_PAD_OSM` (~1 km) so border intersections still resolve, and
  `BBOX_PAD_LAYERS` (~450 m) so a tree layer doesn't drag in the next town.
  A test pins that the derived box is never tighter than the old hand-tuned
  `MALDEN_BBOX`, which is now a literal in `tests/test_place.py` only.
- **Intersection resolution prefers the in-area node** when the same street
  names cross in both Malden and a neighbor (Melrose/Everett). Border-only
  crossings are kept and reported as a *notice*, not dropped. `build.py` uses
  `boundary.near_boundary(..., 0.0015)` (~165 m) for this — that tolerance is
  what keeps genuine border crossings in play.
- **The boundary is a MULTIPOLYGON with holes**, assembled from raw ways at
  runtime by `ringsFromWays` / `boundaryFromWays`. There is no precomputed ring
  file and no shapely: Census and OSM return multipolygons routinely (islands,
  exclaves, enclave towns that punch a hole in a neighbour), and OSM boundary
  relations arrive as member ways that must be chained.
- **Ways that never close are dropped, deliberately.** The old shapely path
  fell back to a convex hull, which silently over-included territory. A
  boundary of dangling fragments is not an area — better to have none.
- **Clipping keeps EVERY in-boundary piece.** v1 kept only the longest per
  segment, silently losing mileage whenever a line left the boundary and came
  back. Malden's outline hid it; a hole or a multi-area union does not. Drawing
  aids that want one continuous line call `longestPiece()` explicitly, so the
  choice is visible rather than buried in the clipper.
- **Everything is clipped to the boundary** so mileage/cost only count in-area
  street.
- **State roads matter a lot.** Route 60 (Pleasant/Centre/Eastern/Salem) and
  Route 99 (Broadway) are ~half the draft network. `jurisdiction: state` paths
  draw solid magenta in phase mode and are excluded from city cost totals.

### The format
- **Bicycle lane distance = corridor distance × `sides`**, and ONLY for
  `bike`-category treatments. `travel` (which way you can ride) and `sides`
  (how many facilities exist) are separate fields because v1 conflated them and
  so could not express a two-way track on one side of the street.
- **Phased upgrades.** `upgrades` is a LIST of TREATMENT ids. **The math:**
  full-buildout distance counts the corridor ONCE (superseded excluded, via
  `supersededIds()`), while per-phase rows and cost include EVERY phase's work
  — building twice costs twice. The "Show" menu preview is **visual only —
  totals always describe the full plan**, because numbers that shift with a
  view dropdown read as a bug to non-technical users.
- Referencing treatments (not features) means a same-geometry upgrade is two
  treatments on ONE feature. That is what removed the whole class of bug that
  came from upgrades duplicating geometry.
- **multi-part features**: one entry = 1+ parts; Combine… merges features; the
  Northern Strand is one 31-part entry.
- **Context layers** are NOT part of network.yaml — `data/layers/<id>.geojson`
  plus a `layers.json` manifest, read as static assets. The "Map layers" card
  lazy-fetches on first toggle and draws on a shared `L.canvas`, so layers cost
  nothing while off and stay smooth with ~1300 trees. Adding one needs no code:
  drop the file in `data/layers/` **and** `web/data/layers/`, add a manifest entry.

### The app (web/app.js)
- GOTCHA: never add decorator/plain LayerGroups to `networkGroup` —
  `FeatureGroup.getBounds()` throws on layers without getBounds and kills init;
  arrows live in `arrowsGroup`.
- **Chevron membership belongs to `syncArrows()` alone.** Arrows are rebuilt on
  load, on shape edits and on import, so any other place that adds them
  resurrects a replaced path's chevron. `init()` must call `applyPhaseView()`
  itself, or the first paint ignores upgrades until the Show menu is touched
  (that shipped once). `web/test/app_structure.test.js` guards both plus the
  legend rebuild, since app.js has no DOM harness.
- **A superseded path draws no one-way chevron** when its replacement is on the
  same map: the upgrade covers the old line exactly, so only the stale arrow
  would show, claiming the new lane is one-way.
- One-way paths (`directions: 1`) draw a direction chevron — geometry point
  order IS the direction; Reverse flips it. Chevrons are rotated dark glyphs
  with a white halo on ALL surfaces (DivIcon = PNG rotated "▶" with a
  patheffects-style white stroke) — never arrow patches, NO
  leaflet-polylinedecorator, NO folium TextPath (that crashed map.html).

### Exports
- **Nothing injected into the exported map.html may touch the map at parse
  time.** Wrap injected code in `DOMContentLoaded` (the phase slider and the
  chevron-zoom handler both do).
  `test_html_never_touches_the_map_before_it_exists` pins this.
- **A replaced path is hidden only while its replacement is actually shown** —
  consult `map.hasLayer(replacement)` as well as the slider position, so
  unticking the upgrade's phase falls back to the path it replaced instead of
  blanking the corridor. The slider re-asserts phase groups on `input` only,
  never on `overlayadd`/`overlayremove`.
- Animation frames must be pixel-stable: fixed canvas AND fixed axes box, and
  captions padded to a constant line count.
- `web/js/gif.js` is a small GIF89a+LZW encoder. Two traps it already fell
  into: never spread a frame's bytes into `Array.push` (argument limit), and
  median cut allocates palette slots by area — a pale basemap crowds the
  network's colors out unless `reserved` is passed (export.js passes
  `MAP_PALETTE`).
- PNG labels place themselves (candidates slide along the route, scored by
  other paths' ink under the box; crowded labels are dropped, not overlapped)
  and avoid chevrons.

### Data
- `fetch_layers.py` derives its bbox from `data/malden_boundary.geojson` (not
  `osm.MALDEN_BBOX`) so another city needs no code change, and it renames raw
  fields to plain language AT FETCH TIME — MassDOT's `NON_MTRST_TYPE_CL`,
  epoch-ms dates and KABCO codes mean nothing to a resident, and popups show
  property names verbatim. The serious-injury signal is in `MAX_INJR_SVRTY_CL`,
  NOT `CRASH_SEVERITY_DESCR` (which only says fatal / non-fatal / property damage).
- The Overpass User-Agent uses the MSS contact address — keep it that way,
  Overpass etiquette wants a reachable contact.
- **The browser must never call public Overpass** (V2_PLAN.md §8.5). Overpass
  is a batch tool: `build.py` and `fetch_layers.py`, where volume is bounded
  and a human is present. Snapping data reaches the browser as STATIC TILES,
  which cannot be DDoSed by our own users the way a query API can — there is
  no query, just cacheable bytes with a flat cost curve.
- **Snap data has three tiers, and "none" is a legitimate one**: `street_tiles`
  (fetched for the current view and merged), `street_graph` (a bundled asset —
  Malden's path, instant and fully offline), or nothing, in which case snapping
  is unavailable and a click behaves exactly like today's off-street click.
  Never turn the third into an error.
- **A click more than ~30 m from a road is DELIBERATE**, not a failed snap:
  park interiors and cut-throughs stay exactly where they were put. Worth
  remembering when a route comes back as a straight line — check the endpoint
  distance before suspecting the graph.
- `nearestNode` and `nearRoad` take an optional `GraphIndex` (`graph.js`).
  Without one they scan every node/edge, which is 30,516 nodes per waypoint on
  Malden alone; with one they look at a few grid cells. A test pins that the
  two agree on the shipped graph.
- **`web/help.md` is the ONE copy of the manual, and it is human-authored
  (Calvin writes it) — do NOT edit it.** When you add a user-facing feature,
  list what needs covering in your summary instead of writing it yourself.
  V2_PLAN.md §13 holds the outline for the v2 rewrite.

## Cross-implementation parity

`tests/test_web_assets.py` shells out to node (skipped if node isn't installed)
and pins two things:

- **Ring assembly agrees** — `bikenetwork/boundary.py` and `web/js/boundary.js`
  produce identical rings for the real Malden boundary.
- **Python reads what JS writes** — JS serializes `network.yaml`, Python parses
  it, and every field and coordinate matches.

If you change either format module or either boundary module, expect these to
be the tests that catch you.

## Current state (2026-08)

**Done: M-1 — the Flask editor is retired** (V2_PLAN.md §2, §3):

- Deleted `editor.py`, `editor/`, and the duplicated `bikenetwork/` modules
  (`render_map`, `render_html`, `pipeline`, `geojson`, `routing`, `costs`),
  plus `tools/export_boundary_polygon.py` and the tests that covered them.
- **shapely, matplotlib, folium, contextily and Flask are gone from
  requirements.txt.** Python is PyYAML + requests + pytest.
- `web/js/boundary.js` rewritten: runtime ring assembly, multipolygons, holes,
  and the every-piece clipping fix. `web/data/malden_boundary_polygon.json` and
  its staleness test are gone — the app polygonizes at load.
- `bikenetwork/boundary.py` rewritten as a pure-Python mirror of the assembly
  and containment halves (no clipping — that's the app's job).
- `build.py` no longer renders: it writes one network file and takes `-o`.
- CI now runs pytest as well as `node --test`.
- Verified: clipped mileage over the whole Malden network is **identical**
  (19.638949 mi) before and after, per path and in total.

**Done: M0 — de-Maldenized behind `data/place.json`** (V2_PLAN.md §9):

- `data/place.json` (+ its byte-identical `web/data/` copy) declares the
  deployment's area: id, name, context, authorities, asset paths, opening map
  view, and the Overpass contact string. `bikenetwork/place.py` and
  `web/js/place.js` read it.
- Every asset the app fetches — boundary, street graph, layers manifest, seed
  network — is now named by place.json, not by a path in the code. Missing
  assets are a normal state: no street graph means snapping is unavailable, no
  seed means the app starts empty.
- `osm.MALDEN_BBOX` is gone; the bbox is derived. `USER_AGENT` became
  `user_agent()`, overridable via `fetch.user_agent`.
- **Acceptance test in both suites: a synthetic "Testville" place drives the
  whole pipeline with no code change.** That is the definition of done for
  "geography-agnostic" — if Testville passes, the claim is true.
- Verified: build.py's output is byte-identical before and after, and clipped
  totals via the assembled polygon match the old precomputed ring exactly
  (9.720391 build mi / 19.120550 lane mi).

**Done: M1 — the v2 format** (V2_PLAN.md §4, §5). The whole break, spent at once:

- `data/treatments.json` + `registry.py` / `registry.js` — the registry, with
  the category / cost / render contract enforced by a test.
- `network_format.py` and `network_format.js` rewritten for v2: areas,
  authorities, features + treatments, parts-based geometry, quoted dates, one
  id namespace, list-valued `upgrades`, `tags`, `meta`, `costs`.
- `migrate.py` / `migrate.js` — the v1 shim, import-only and **deterministic**
  (`f-1`, `t-1`, …), so two people upgrading the same file get byte-identical
  output. `tests/fixtures/v1_network.yaml` is Malden's real pre-v2 network and
  is kept FOREVER; a test asserts upgrading it reproduces the v2 fixture byte
  for byte.
- Every consumer ported: geojson (one collection, GeometryCollection for mixed
  features), pipeline (category-gated totals, per-authority/per-area rollups,
  counted quantities), costs (metric + three tiers of override), render_common
  (the stacking rule), render_html, render_png, export, store, and the editor.
- `network.yaml` and `data/base_network.yaml` are **gone from the repo** — no
  network data ships here any more (V2_PLAN.md §7). `place.json` no longer
  names a seed, so a fresh browser opens empty; a deployment that wants its
  existing conditions adds a `seed_network` asset.
- Verified in a real browser against the migrated Malden network: 14.3
  corridor-mi / 28.4 lane-mi, breakdown Malden 9.7 + MassDOT 4.6 (9.7 matches
  the pre-v2 city figure exactly), a second treatment added on a corridor draws
  a stacked stroke and survives autosave → YAML → reload, trees do NOT inflate
  lane distance, and units toggle 14.3 mi ↔ 23.1 km.

**Done: M4 — additive import** (V2_PLAN.md §6) and **M2 — snapping at scale**
(§8). See the commit messages for the detail; the short version:

- `merge.js` — import by AREA, not wholesale. Areas you don't have default to
  add, areas you do default to keep mine, a feature belongs to the area holding
  most of its length, colliding ids are rewritten with their references, and
  phase mapping is skipped whenever it would be trivial.
- `graph.js` — a grid index (12x faster nearest-node on the shipped graph, and
  the gap grows with size) plus tile arithmetic, so the graph grows to fit
  where you draw instead of shipping whole.
- `tools/make_road_tiles.py` cuts a graph into z14 tiles: Malden's 3.9 MB
  becomes 24 tiles averaging 156 KB. Verified in a browser that a route crosses
  three tiles and follows streets (6.19 km routed vs 4.68 km straight).

**Still operational, not code:** generating and hosting a roads archive for a
region beyond Malden. The tiler exists and the app consumes tiles; what's left
is running it on a Geofabrik extract and putting the output on storage. Malden
keeps its bundled graph, so nothing regresses in the meantime.

**Done: M3 — bring your own context**, and **M5 — scale hardening**:

- Layers declare an `extent`; one that misses the area is hidden rather than
  shown empty. FARS is wired as the national floor (the fetch itself is a
  networked run you have to make).
- `tools/fetch_existing_infra.py` pulls OSM cycleways as candidates. BATCH, per
  the never-call-Overpass-from-the-browser rule, with a deliberately
  conservative tag mapping — a painted lane is `buffered_painted`, never
  anything "separated".
- **Additive imports.** A file that proposes nothing is a record of what
  exists, not a rival plan, so the keep-mine/use-theirs question disappears and
  the review list becomes the whole sheet. Importing OSM-derived features sets
  `meta.license` to ODbL-1.0 and says so.
- **Undo/redo** — buttons plus Ctrl+Z/Ctrl+Y, coalescing rapid edits, keeping
  the selection across a restore. Snapshots BOUNDED BY BYTES, so a small
  network gets deep history and a huge one gets shallow history rather than
  eating the tab. Startup is suppressed, or a freshly loaded page would offer
  to undo its own housekeeping.
- **IndexedDB** is the store now; localStorage remains only as a synchronous
  journal for `pagehide`, because an IndexedDB transaction does not complete
  once a tab is being torn down.
- **Canvas rendering** for the network, and exports over more than four areas
  split into one file per area plus an index.

**Next:** nothing in the plan. Remaining work is yours: `help.md`, manual
testing, and the operational half of M2 (a roads-tile archive on hosted
storage) — it depends on M1 and
nothing else, and M2 is gated on D7. Then M3, then M2, then M5. See V2_PLAN.md
§9 for the sequence and §8 for the settled snapping/licence design.

**help.md needs writing** for everything M1 added — V2_PLAN.md §13 is the
outline. New user-facing surface since v1: treatments (several things at one
place), the treatment chips in the panel, `travel`/`sides`/`side` replacing
directions, quantities, "who builds it" replacing jurisdiction, the
under-construction status, the units toggle, the breakdown table, the unknown-
treatment notice, and the phase-date prompt when an older file is imported.

**Deferred:** PyInstaller `.exe` packaging of `build.py` hasn't been redone
since the split.
