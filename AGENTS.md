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
                            boundary, census (area lookup) and osm (Overpass
                            import) — the only two that touch the network,
                            geojson, costs, pipeline, merge, routing,
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
- **The line BETWEEN two of your areas is not an edge of the network.**
  `splitBoundaryEdges()` classifies every boundary segment as outer or shared
  and the map draws shared ones faintly; without it a two-town network looks
  like two maps pushed together. It cannot be done by matching vertices —
  Malden's outline comes from OSM and Medford's from the Census, so the same
  legal line is two different point sets tens of metres apart. Proximity is
  what's reliable, hence the `tolMiles` (~55 m) default.
- **Your areas are the subject of the map, so everything else is shaded.**
  `drawOutsideMask()` draws ONE polygon covering the world with a hole punched
  for each area's outer ring, and the outer edge gets a white casing under a
  heavy dark dash. Without both, the boundary was just one more administrative
  line among the several the basemap already draws.
  ⚠️ The mask lives in `maskGroup`, NOT `boundaryGroup`, because
  `boundaryGroup` feeds `fitBounds()` and a world-sized rectangle in there
  frames the planet. Inner rings are deliberately skipped: an enclave inside an
  area should stay shaded.
- **The clip boundary is the union of `config.areas[].boundary`, not the
  deployment's.** `areasBoundary()` in `app.js` builds it, memoized in
  `areaClip`. It used to be `store.boundary()`, which meant adding an area in
  the editor did not widen where you could draw — the Areas card would have
  been a lie. Anything that swaps the area list wholesale (`restoreSnapshot`
  for undo, `afterImport`) must set `areaClip = null`.
  Always run an area's boundary through `normalizeBoundary()` before reading
  it: one may arrive as a bare ring, a polygon, or a multipolygon depending on
  whether it was adopted from the deployment, parsed from a file, or uploaded
  as GeoJSON, and iterating the wrong depth clips against nothing.
- **Drawing is clipped at COMMIT, once, for snapped and freehand lines alike**
  (`clipToAreas`). Clipping used to live inside `snapPoints`, which meant only
  snapped lines stopped at the border, only the longest piece survived, and a
  line drawn wholly outside became an invisible stub carrying a default name
  that the user could neither see nor select to delete. A line entirely outside
  every area is now REFUSED, and a spot outside is refused without leaving
  placing mode.
- **Every refusal and every trim says so**, in `#clip-notice` — a bar that
  outlives the next `setStatus()`. Trimming is correct but invisible, and the
  remedy for "I meant to draw that" is a wider boundary, so the message that
  raises the problem also carries the way out. When the dropped part can be
  located, the notice NAMES the town (`areaAt`) and the button becomes
  **"Add Medford"**; when it cannot, it stays "Add an area…" and opens the
  picker. Best-effort: no network, no name, and the generic button still works.
- ⚠️ **A trim is detected by GEOMETRY, not by vertex count.** Clipping a
  two-point line that starts in the next town returns a two-point line with its
  first vertex moved onto the border: same count, same single piece. The count
  test said "not trimmed", so the user lost half of what they drew and was told
  nothing. `clipToAreas` reports a trim when any drawn vertex lies outside the
  areas — that vertex IS the thing being cut off, and it names the town too.
- **State roads matter a lot.** Route 60 (Pleasant/Centre/Eastern/Salem) and
  Route 99 (Broadway) are ~half the draft network. `jurisdiction: state` paths
  draw solid magenta in phase mode and are excluded from city cost totals.

### Areas come from the Census, not from a file dialog

- **`web/js/census.js` looks an area up by NAME** against US Census TIGERweb
  (ArcGIS REST, public, CORS-enabled). The picker opens already listing the
  towns that touch your current areas — `nearbyAreas(bbox)` — because "I'll do
  Medford too this weekend" is the ordinary case. Free-text search covers the
  rest, ranked so the state you are already working in wins (there is a
  Somerville in five states).
- ⚠️ **This is the ONLY outbound call the editor makes**, and only when the
  user opens the picker or asks to add a town — never on load, never per-tile.
  That is the same rule the roads graph follows by being static tiles: static
  files can't be DDoSed by your own users. Do not move Census lookups onto a
  path that runs per tile, per pan, or per keystroke (the search box is
  debounced for exactly this reason).
- **Nothing here is required.** Every call is wrapped, every failure degrades
  to a sentence plus the `.geojson` upload, which still covers "our advocacy
  area is these six neighbourhoods" — an area no registry will ever have.
- **Layer 1 is County Subdivisions, layer 4 is Incorporated Places.** Both are
  queried and the results deduped by name+state, preferring the subdivision —
  in New England that IS the town — except when it is a "CCD", a statistical
  division the Census invented for states without real ones, where the
  incorporated place is the right answer.
- **Boundaries are fetched simplified** (`maxAllowableOffset` ≈ 3 m): 427
  points and 17 KB become 128 points and 3 KB. Do not raise it much — a 10 m
  tolerance can move a border street to the wrong side of the line, and this
  outline decides what gets clipped.
- **Search results are ranked by land area**, via `orderByFields=AREALAND DESC`
  on the service. There are thirty-odd Clevelands and sorting our own page
  would not have helped — the service's default order put the big one past the
  40-record limit, so it never arrived at all. Land area is a crude proxy for
  "which one did they mean", and the state you are already working in still
  outranks it.
- **`census:<GEOID>` is the area id**, so the same town is never added twice
  and full resolution stays re-fetchable. `place.json` carries the real GEOID;
  it used to carry an invented one, which defeated the point. `haveArea()`
  falls back to name+state so a network saved before that fix still recognises
  its own town.
- GeoJSON is `[lon, lat]`; every boundary in this codebase is `[lat, lon]`.
  The flip happens once, in `toBoundary`, at the edge.

### Dialogs, starting, and starting over

- ⚠️ **`.sheet` is the BACKDROP, `.sheet-inner` is the card.** The backdrop is
  fixed and `display:flex` to centre its child. Put `class="sheet"` on the card
  and it becomes a flex container that lays its heading, hint, lists and
  buttons out in a ROW — which is exactly how the area picker shipped, and it
  looked broken at every screen size. A source test pins this now. Every new
  dialog rides the same pair, so it gets the full-screen mobile treatment for
  free.
- **CSS class names here are global and this file is old.** `.area-row` and
  `.area-choice` already belonged to the import sheet; the Areas card's rules
  are scoped under `#areas-list` so they don't reach in there. Check for an
  existing rule before inventing a class.
- ⚠️ **An area with no boundary must borrow the deployment's — on IMPORT as
  well as on startup.** `adoptDeploymentBoundary()` is the one place that does
  it. v1 kept the boundary outside the file and plenty of v2 files predate
  this tool writing it, so an imported area often arrives with none: no
  outline, no clipping, and every feature assigned to "somewhere else", which
  showed up as a successful import that left Malden with zero features until
  the user reloaded. It lends the outline ONLY to an area whose name matches
  `place.name` — handing Malden's boundary to an imported Cleveland would be
  silently, invisibly wrong.
- **Starting fresh assumes no geography.** "Start a new network" drops the
  presumed area and opens the picker. The deployment's place is a fine default
  for someone who opened this to work on Malden and pure noise for someone
  starting in another state — and it would quietly lend them Malden's outline.
  Backing out of the picker with nothing chosen returns to the start sheet
  rather than stranding the user on a map that belongs to no place.
- **The start sheet appears when there is nothing to edit** and the user
  hasn't already said "start a new one" (`bnb.started` in localStorage). An
  empty map with no explanation is a dead end — nothing to click, no hint that
  opening a file is even possible.
- **Reset means reset.** It clears `bnb.started`, calls `store.clear()` — which
  DELETES the stored network rather than writing an empty one, so the next load
  seeds from the deployment instead of resurrecting an empty file — sets
  `dirty = false` so a pending autosave can't rewrite what was just deleted,
  and reloads. Reloading is the point: it rebuilds every layer, index and
  history from nothing, which is what "the same screen you'd get from zero"
  has to mean.
- **"Export, then reset" must not reset when the export fails**, or the option
  chosen by the person protecting their work is the one that loses it.
- **`.geojson` imports too**, as features only, on top of the config already
  loaded — a GeoJSON has no areas, phases or authorities in it.

### OSM import, and the one live query

- ⚠️ **`web/js/osm.js` is the ONLY thing in the browser that may call Overpass**,
  and only on a click. V2_PLAN §8.5 rule 1 was amended for it rather than
  broken: load scales with towns added, not with editing time. Keep it that way
  — never call it from a pan, a draw, a keystroke or a retry loop.
- ⚠️ **The kindest thing here is the CACHE, not the throttle.** Fetched
  elements are persisted (`readCache`/`writeCache`, 7-day expiry), so importing
  a city, reloading and importing again costs the service ONE query. The
  requests that actually burn a rate limit are the repeats — a failed run that
  discards what already arrived is the most wasteful thing this tool can do,
  which is why a multi-area run keeps its partial results and re-ticks only the
  areas that failed.
- **A wait is not capped, and that is deliberate.** Waiting costs the service
  one status read and a timer; an error costs it a button press from someone
  who will press it again. The wait is cancellable instead, which is the
  affordance that actually belongs there. Do not "improve" this by adding a
  timeout that hands back a retry button.
- **It ASKS BEFORE IT FIRES.** `waitForSlot()` reads Overpass's `/status`
  endpoint, which says how many slots are free and when the next one frees up,
  and waits rather than firing into a full queue. Status is ADVISORY: a mirror
  without the endpoint, or a format we have not seen, must never block an
  import. Past `MAX_SLOT_WAIT_MS` it gives up and tells the user instead of
  sitting and polling.
  ⚠️ **This is not a guarantee.** `overpass-api.de` load-balances across
  backends, so the status you read may not describe the backend your query
  lands on — a 429 straight after "2 slots available now" is normal. The slot
  check reduces 429s; it cannot eliminate them.
- **A big area is flagged BEFORE the button** (`isHeavy`), as a WARNING — the
  size cap (`MAX_AREA_SQKM`) is the refusal. Someone building a network for
  Dallas or Seattle is the user this tool is FOR, and a city's cycleways are a
  tiny slice of OSM; that is an ordinary Overpass query, not a bulk download.
  What made it fail was our own waste, not its size. The sheet now says it may
  take a few minutes of waiting, that waiting is the point, and that adding a
  huge city's boroughs as separate areas works better than one giant query.
- ⚠️ **Never auto-slice a bbox into a grid to get under a limit.** Splitting by
  REAL areas is modelling (you probably want per-borough totals anyway);
  splitting by tiles to make many small requests is working around a limit that
  exists to say "don't do this here", and it sends more total load, not less.
- **The guardrails are in the SESSION, not the UI**, so no caller can skip them
  by wiring a button differently: sequential fetches, `MIN_INTERVAL_MS` between
  requests, a per-area cache, `MAX_AREA_SQKM` refused before any request is
  sent, and **no automatic retry** — a 429 or 504 stops and says so, because
  retrying under load is how a polite client becomes a hammer.
  `place.fetch.overpass_url` overrides the endpoint so a busy deployment
  self-hosts.
- **The tag rules and the query are duplicated in Python**
  (`tools/fetch_existing_infra.py`) and pinned together by
  `tests/test_web_assets.py`. Two copies that drift are two different tools:
  the same street would import as `buffered_painted` from one and
  `concrete_separated` from the other.
- ⚠️ **The OSM import has NO empty-map shortcut, and must not grow one.** A
  FILE import skips the review sheet on a blank slate, which is kind: there is
  nothing to merge into, so the only question has one answer. For OSM the
  question is "which of these 116 do you actually want", which has many — and
  the sheet has just promised to ask it. It asked on top of an existing network
  and silently imported everything onto an empty one.
- **Ways are chained back together by name.** OSM splits a way at every tag
  change and many junctions, so one path arrives as a dozen "lanes" — the
  Dr. Paul Dudley White Path came in as fourteen. `chainParts()` rejoins them;
  pieces that genuinely do not touch stay separate PARTS of one feature rather
  than being bridged with geometry that isn't there. Endpoints that meet are
  identical numbers (adjacent ways share an OSM node), so there is no tolerance
  and there must not be one — a tolerance would join paths that really stop.
  Only NAMED ways group: "Unnamed path" is not a name, and lumping every
  anonymous cycleway in a city together would be worse than the fragmentation.
  Different treatments on the same street stay separate, or the map stops
  showing the difference it exists to show.
- ⚠️ **`cycleway=track` is `quick_build_separated`, NOT `concrete_separated`.**
  OSM's `track` means "physically separated" and says nothing about what
  separates it. Importing it as concrete invents a curb that may be flex posts
  — the same over-claiming the painted-lane rule exists to prevent, pointed the
  other way. The tags that drove each decision travel in the feature's `notes`
  (`explainTags`) so a reviewer can see why, and the sheet says plainly that
  the import is only as good as OSM is.
- **Paths and spots are INDEPENDENT halves of the query**, and either can be
  asked for alone. A city whose OSM lanes are all paint an activist would not
  count still has bike parking worth importing. `Look up` is disabled when no
  area is ticked or neither half is — greying out beats sending a shared
  service a query that cannot answer anything. The cache key covers both, so
  the three questions about one town are three separate entries.
- **Spot improvements (bike parking, bike share docks, humps, bollards,
  islands, tree rows) are OPT-IN.** Malden alone returns ~100 of them and a city returns thousands;
  every one lands in the review list, and a review list with thousands of rows
  is one nobody reads. The batch tool always fetches them — it has nobody
  waiting and no list to swamp.
- **OSM results go through the ORDINARY importer.** They are serialized to a v2
  file in memory and handed to `store.importBytes`, so the review list, the
  additive merge and the ODbL notice all come for free instead of being
  reimplemented. Nothing is added without the review list.
- **Share-alike is contagious.** `mergedMeta()` keeps mine, except that ODbL
  wins — `applyMerge` used to keep only `mine.meta`, which silently dropped the
  licence off every OSM import landing in a network that already had features.
  `licenseConflict()` REPORTS a clash between two declared licences and never
  adjudicates one: whether two files may be combined depends on provenance only
  the user knows.

- **Every clause is a separate bbox scan**, so tags that differ only in their
  value belong in ONE regex clause — `amenity~"^(bicycle_parking|bicycle_rental)$"`
  rather than two. Fewer clauses is directly less work for a shared service.

### Telling someone what is slow

- **`python web/serve.py --debug`** shows a readout of zoom, feature counts,
  vertices, what is on the canvas and how many DOM markers exist. It turned
  "it lags a bit" into "z14, 3,473 spots, 0 DOM markers", which is a report
  someone can act on. `?debug` in the URL does the same for a deployed copy.
  The server answers `/debug-mode`; a static host 404s and the app treats that
  as off, so the same files serve both ways.
- **The number that predicts lag is DOM markers**, not features. Canvas costs
  are counted separately in the readout because they behave nothing alike.

### The awkward files

- **`tests/fixtures/merge/` is generated** by `tools/make_test_networks.py` and
  split so every file has exactly ONE expected outcome: two that must import
  (including the speed-hump corridor — legal in the format, never offered by
  the editor), five that must be refused with a message naming the problem, and
  five that must not parse at all. Both suites read them.
- ⚠️ **They already earned their keep:** an empty document used to parse into a
  default network that validated clean, so importing an empty or unrelated file
  reported SUCCESS — and on an empty map replaced everything with nothing.
  `parseNetwork` now refuses a document that declares none of the network keys,
  and `Store.loadNetwork` treats "nothing stored" explicitly instead of parsing
  `""` for its defaults.

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
- **The header is menus, and it is RESPONSIVE.** Wide screens get a one-click
  THREE tiers, all CSS, no resize handler. ROOMY (>=1150 px) shows all four
  add buttons and the Snap toggle, no menu at all — which of the four you add
  over and over depends on what you are doing that day, so none of them should
  cost an extra click. CRAMPED (<1150 px) collapses them into `+ Add ▾`.
  NARROW (<=760 px) also hides the brand and the idle status and moves
  Help/Import behind `⋯`, keeping the header to ONE row at 375 px.
  `.roomy-only` / `.cramped-only` / `.narrow-only` do the switching.
- **The header must stay one row at every width.** Four buttons leave far less
  slack than the menu did, so the two things that can grow without bound are
  pinned: header buttons never wrap a label (`white-space: nowrap`) and
  `.status` shrinks and ellipsizes (`flex: 1 1 0; min-width: 0`). Without that
  a long status message wrapped the header onto two rows at 1400 px.
- **Two Snap checkboxes, one setting.** `#snap` (in the Add menu) and
  `#snap-roomy` (the roomy header) mirror each other on change; read `#snap`.
  `wireMenu()` is the one behaviour for all four header menus: a click inside a
  menu that isn't a command (a select, a checkbox) leaves it open, so you can
  change two settings at once.
- ⚠️ **`header` sets a stacking context.** It has `position: relative;
  z-index: 1500`, and an open `.menu` inside it can never paint above that
  number however high its own z-index is. It was 1000, tying with Leaflet's
  `.leaflet-top` and losing on document order — which is why the zoom buttons
  used to render over an open menu. Anything new that must sit above the map
  belongs in the header, or needs its own z-index above 1200 (the mobile
  sidebar).
- ⚠️ **Spots are drawn on the CANVAS. There is exactly ONE DOM marker in the
  app.** A real OSM import of Boston and Cambridge is 4,758 features — 3,473
  of them spots, 2,651 bike racks — and as `L.marker` divIcons that was 3,473
  DOM elements for Leaflet to reposition on every pan. Hiding them below a zoom
  threshold only moved the lag to the first zoom where they appeared, and a
  COUNT-based threshold would make them blink in and out while scrolling.
  Canvas has no such cliff: 3,473 cost about what one does. Measured on that
  file: 0 DOM markers, 42 nodes under `#map`.
  - `SpotMarker` extends `L.CircleMarker` and replaces only `_updatePath`, so
    Leaflet still gives canvas drawing, hit-testing and a `click` event; the
    invisible radius is what stays clickable.
  - Below `MIN_SPOT_ZOOM` it paints a 2.5px dot instead of a glyph: `fillText`
    is the expensive call, and a glyph is illegible at city zoom anyway. Spots
    stay VISIBLE at every zoom — vanishing markers were the old compromise.
  - The one exception is `syncDragHandle()`: canvas cannot be dragged, so the
    SELECTED spot gets a real DOM marker on top. One, not thousands. It follows
    the selection — never call it from `syncMarkers`, which runs per feature.
- **Spots are OFF by default** (`showSpots`), with a checkbox in the header on
  roomy screens and in the Display menu everywhere else — two controls, one
  setting, the arrangement Snap already uses. Cheap to draw is not the same as
  worth drawing: a city import is thousands of spots sitting on top of the
  lanes the map is about, and at low zoom they merge into a grey smear.
  ⚠️ Two places turn it back on, because otherwise a working feature looks
  broken: placing a spot (`startPlacePoint`) and an import that fetched them.
  A click that appears to do nothing is the worst possible reading.
  - Glyph RUNS along lines are still DOM markers and still keep the threshold
    (`glyphGroup`); a city import had only 9, so they have not needed more.
- ⚠️ **`restyleAll()` must not run on every zoom step.** It walks every feature
  and rebuilds its overlays and glyph markers — free on a hand-drawn network,
  and the lag on a city import. `onZoomChanged` compares a render BAND (the
  stacking threshold, the spot threshold, and the zoom level while spots are
  shown) and restyles only when it changes. The cheap group toggles always run.
- **The network canvas has `tolerance: 10`.** Leaflet hit-tests a canvas path
  against the stroke itself, so a 4px line is a 4px target — fine zoomed in and
  genuinely annoying zoomed out, which is exactly where you are when picking
  one corridor out of a town. The tolerance extends the clickable band by about
  a fingertip and costs nothing to draw.
- **A treatment chip carries an x when there are two or more.** Removing one of
  several used to live only on the Delete button, which reads as "delete the
  whole thing" — so undoing "+ Add another" was hidden behind the scariest
  control on the panel. The last chip has no x on purpose: a place with nothing
  built or proposed there is not part of the network, and deleting it is
  Delete's job.
- **Shape editing belongs to the selected feature**, not to a global mode.
  `layer.pm.enable()` on that one layer; selecting elsewhere or pressing Escape
  ends it. The button is hidden for a point feature, which has no shape to
  edit — its marker is already draggable.
- The default colour mode is `treatment` ("What is built"), which is the
  question most people open the tool asking.
- **The treatment picker is filtered by the feature's geometry**, via
  `registry().forGeometry("line" | "point")`. The FORMAT allows any treatment
  on any geometry and always will — a file from another tool is not wrong for
  saying so — but offering the full list on both let you put bike parking on a
  corridor (drawn as a black dashed line, because a counted treatment carries
  no colour) or a separated bike lane on a spot (drawn as a black dot). The
  registry has declared `geometry` all along; the UI simply never asked. The
  six treatments that are genuinely either — speed humps, bollards, retractable
  bollards, street trees, parking removal, other — appear on both lists, which
  is the point: a street tree can be one tree or a row of them.
  A value already in the file that the list excludes is still SHOWN (marked
  "unusual here") rather than silently retyped.
- **A counted treatment on a LINE draws as a run of GLYPHS, not a stroke.**
  `featureLayers()` splits a feature's treatments: those the registry gives a
  colour are strokes, those it gives a glyph and no colour are glyph runs. A
  row of street trees used to paint a black dashed line — `treatmentColor()`
  falls back to `POINT_PROPOSED_COLOR` for a treatment with no colour — and so
  read as an unrecognised bike facility. Every renderer (editor, HTML, PNG)
  goes through `featureLayers`; none of them call `featureStrokes` directly.
  - Glyph runs take `pointColor`, NOT the stroke colour, so one street tree and
    a row of them are the same colour.
  - Spacing is GEOGRAPHIC (`glyphRunPoints`), not per-vertex: a line drawn with
    three clicks and one drawn with forty must produce the same row. The editor
    varies the spacing with zoom and rebuilds on `zoomend` via `restyleAll`;
    exports use one fixed `EXPORT_GLYPH_KM`, capped by `EXPORT_GLYPH_MAX` so a
    whole-city PNG does not vanish under tree glyphs.
  - A feature with ONLY counted treatments has no stroke, so it gets a
    `spine`: a 2px dotted hairline in the glyph's colour. It is what shows the
    run's extent and, in the editor, what you click.
- **`speed_hump` and `retractable_bollards` are point-only.** Nobody builds a
  corridor of speed humps, and retractable bollards gate ONE opening. A plain
  `bollards` row along a path edge is real, so that one stays both.
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
- **The basemap is CONFIGURATION, never a constant.** It was a hardcoded CARTO
  URL until CARTO began requiring an API key and every tile came back stamped
  "API KEY REQUIRED" — and a static app has nowhere to put a private key.
  `place.json` names the tile URL and attribution now, for the live map AND the
  PNG export. The keyless default is openstreetmap.org, which is fine for local
  work and a small deployment; their usage policy discourages heavy use, so a
  public deployment with real traffic should serve its own tiles. Same
  conclusion and the same cheap static hosting as the roads tiles.
- **Test the FRESH FIRST RUN from empty storage.** Every store test seeded a
  network first, which left the default experience — no stored state, no seed
  asset, an area invented from place.json — as the one path never exercised. It
  threw inside serialize on the very first autosave, because a
  place-synthesized area is a plain object and the serializer trusted its
  shape. Anything reaching the serializer now goes through `makeArea` /
  `makePhase`, and the serializer is defensive about missing collections.
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
