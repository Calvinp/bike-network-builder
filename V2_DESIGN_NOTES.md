# Making bike-network-builder geography-agnostic — a plan

**Status:** proposal, nothing implemented. Malden stays the default throughout.
Revision 2 — incorporates the v2 format break, the decision to keep the
nationwide server in a separate repo, and the D1–D9 answers.

## The reframe

The tool doesn't have a "Malden setting" you can change. It has **one implicit
"here"**, expressed in seven unrelated places that don't know about each other.
Becoming geography-agnostic is not a find-and-replace of the string `Malden`; it
is introducing an explicit **area** object that all seven hang off, and then
letting a network reference *more than one* of them.

### Where "Malden" actually lives today

| # | What | Where | Kind of coupling |
|---|---|---|---|
| 1 | Display name | `Network.city` / `.state` | cosmetic — already flows into every title, legend and export |
| 2 | The clip polygon | `data/malden_boundary.geojson` (5 raw LineStrings) + precomputed `web/data/malden_boundary_polygon.json` (one ring) | **structural** — hardcoded in `editor.py`, `build.py`, `fetch_layers.py`, `store.js`, `tools/export_boundary_polygon.py` |
| 3 | Who builds it | `jurisdiction: city \| state` | **semantic** — "city" means *Malden*, "state" means *MassDOT* |
| 4 | Snap-to-road | `data/street_graph.json` (3.9 MB, 30,516 nodes, one bundled asset) | **structural + scaling** |
| 5 | OSM seed bbox | `osm.MALDEN_BBOX` | structural, easy |
| 6 | Context layers | `data/layers/*.geojson`; two of four are MassDOT-only | data availability |
| 7 | Format magic string | `FORMAT_ID = "malden-bike-network"` | public contract |

---

## Two decisions that reshape everything else

### A — Retire the Python editor; keep Python only for offline data prep

**Direct answer to "is the Python webpage contributing anything that can't be
done statically?": no.** Not one thing. `web/` is a complete port —
`network_format`, `geometry`, `boundary`, `geojson`, `costs`, `pipeline`,
`routing` all have JS twins, plus `render_png.js` (canvas port of the matplotlib
map, with label placement, chevrons, legend/scale/north), `render_html.js`,
`gif.js`, `zip.js`, and `store.js` standing in for the whole Flask API. Both
editors need a CDN for Leaflet, so Flask isn't even the more offline one — the
localStorage version is *more* portable.

What Python uniquely provides is **batch data preparation**, not editing:

| Keep | Why |
|---|---|
| `fetch_layers.py` + `bikenetwork/osm.py` | writes reference data into the repo; a build-time job, correctly a CLI |
| `bikenetwork/network_format.py` (+ a `validate` CLI) | see below |
| `web/serve.py` | 30 lines, cache-disabled static server |
| `build.py` / `corridors.yaml` | **decide separately** — its Overpass corridor-by-intersection-name seeding has no JS equivalent, but D8's in-browser OSM importer largely replaces it |

Everything else — `editor.py`, `editor/`, `render_map.py`, `render_html.py`,
`pipeline.py`, `geojson.py`, `routing.py`, `boundary.py`, `geometry.py`,
`costs.py` — is a second implementation of code that already exists in JS, and
AGENTS.md has to keep saying *"keep the two in step"* about all of it.

**Why this is the highest-leverage sequencing decision:** every single item in
D1–D9 currently has to be built twice. Retiring the duplicate roughly halves the
cost of this entire project. Do it **first**.

Two real costs, both worth paying:

- **You lose the independent second implementation** that kept the spec honest.
  The serialization-parity test (Python parses JS-written YAML and agrees to 4
  decimals) is genuine evidence the format is well-specified, not just
  well-implemented. **Mitigation:** keep `bikenetwork/network_format.py` as a
  standalone **reference reader/validator** — stdlib + PyYAML, no other repo
  dependencies — with a `python -m bikenetwork.validate file.yaml` entry point.
  That preserves the second reading of the spec, serves downstream consumers,
  and (see below) is exactly the interface an AI agent needs.
- **shapely goes away**, and with it the only code that polygonizes raw boundary
  ways into an area. See the multipolygon work item in D1.

### B — The nationwide server is a different repo. Agreed, and it changes the job here.

Then this repo's entire contribution to that future is **the file format**. Not
sync, not accounts, not concurrency, not moderation. The format is the API.

Which means the forward-compatibility checklist gets *shorter* and more
concrete: reserve the keys a server would need, make ids globally stable, and
otherwise design as if the server will never exist. That's now the M6 section,
and it's a page of YAML keys rather than an architecture.

---

## How OSM handles concurrent editing (and what's worth stealing)

Since you asked, and since it's directly relevant to both the merge design and
the agent question:

**The model is optimistic concurrency at element granularity, with no locking
and no branches.**

- Every node, way and relation carries an **id and a version number**.
- Edits are grouped into a **changeset** — open one, upload an `osmChange`
  document, close it. Changesets carry a bbox, a comment, and the editor that
  made them.
- Upload is **atomic and version-checked**: if any element you touched has been
  changed by someone else since you downloaded it, the server rejects the whole
  upload with a `409 Conflict`. Nothing partial lands.
- The **client** resolves conflicts. JOSM has a real conflict-resolution UI;
  iD generally refetches and retries. There is no server-side merge.
- **Bulk reads never go through the editing API** — it caps bbox downloads
  (~0.25 sq degrees / 50k nodes). Bulk consumers use planet dumps plus
  minutely/hourly/daily replication diffs, or Overpass. Reading and writing are
  deliberately different systems at different scales.
- **Governance is flat and social, not hierarchical.** No moderator tree. There
  are changeset comments, revert tools, an import policy requiring community
  consultation before bulk imports, and a Data Working Group for disputes.

What's worth stealing, and what isn't:

| OSM idea | Verdict here |
|---|---|
| Stable ids + version numbers per element | **Steal.** Reserve `id` (always assigned) and an optional `version` on every path. Cheap now, impossible to retrofit. |
| Changesets as the unit of contribution | **Steal the shape.** A shared partial-network YAML *is* a changeset. Naming it that internally keeps the future server's job obvious. |
| Reads and writes at different granularities | **Steal.** Export any area you like; large areas come as per-area files, not one blob. |
| Optimistic 409-on-conflict | **The other repo's problem.** File sharing has no concurrent writers. |
| Flat governance / no moderator tree | **Worth reconsidering your instinct.** You sketched supermoderators → metro moderators → town moderators. OSM deliberately doesn't have that, and it's the largest volunteer geodata project in the world. A hierarchy is a lot of social machinery to build and staff. Flat + area ownership + revert may get you there with far less. Not a decision for this repo, but worth carrying into the next one. |

## AI agents as contributors

I think this is right, and mostly it's already true — the format is plain text,
fully specified in `NETWORK_FORMAT.md`, and validated with human-readable
errors. That combination *is* an agent interface. Three cheap things make it a
good one:

1. **The standalone validator from decision A.** `python -m bikenetwork.validate
   network.yaml` giving line-referenced, plain-language errors is the agent's
   feedback loop. Without it an agent is guessing; with it, it iterates.
2. **Optional provenance that can say "a machine made this."** OSM's *Automated
   Edits code of conduct* — separate accounts, disclosure, prior consultation —
   is the precedent, and it exists because undisclosed bulk automation went
   badly there more than once. Reserve it now:
   ```yaml
   areas:
     - id: census:2510-0038805
       contributors: [{name: "Malden Safe Streets", kind: organization}]
       generated_by: {tool: "claude-opus-5", automated: true}   # optional
   ```
   Nothing in this repo needs to *act* on it. But a future server that can't
   distinguish a hand-drawn network from a generated one has no way to moderate
   fairly, and by then the files are already in circulation.
3. **Round-trip stability.** An agent that reads, changes one path, and writes
   back must not produce a diff full of reordered keys and reformatted numbers.
   The existing "re-saves with no value changes" test already pins this — keep
   it as a hard requirement through the v2 work.

The failure mode to design against isn't agents contributing; it's *generated
volume drowning hand-drawn local knowledge*. That's a moderation problem, so
it's the other repo's — but disclosure is what makes it solvable, and disclosure
has to be in the format from day one.

---

## Design decisions

### D1 — `areas:` becomes a first-class list *(agreed; UI picks, backend absorbs the complexity)*

```yaml
format: bike-network
format_version: 2
units: metric                    # see D9
areas:
  - id: census:2510-0038805      # stable, globally unique, from a public registry
    name: Malden
    kind: municipality           # municipality | county | tract | state | region | custom
    context: Massachusetts       # disambiguation shown after the name
    boundary: [...]              # polygon(s), possibly with holes — see below
    updated: 2026-08-23
```

The boundary travels **inside** the file so a shared network is
self-describing: someone who receives Somerville's network gets Somerville's
outline with it, and can draw and clip with no lookup and no network call.
Malden's ring is 2 KB.

**Work item you can't skip: multipolygons and holes.** Today the boundary is 5
raw `LineString` ways that shapely polygonizes into one ring, and the JS clipper
only understands **a single ring**. Census and OSM will hand back
`MultiPolygon`s routinely — coastal cities with islands, towns with exclaves,
and enclave municipalities that punch a hole in their neighbor. With shapely
retired (decision A), `web/js/boundary.js` needs proper multipolygon + hole
support written from scratch. Budget for it; it's the least glamorous and most
load-bearing item in M1.

### D2 — v2, and spend the entire breakage budget at once *(your call, and it's the better one)*

You're right, and it's the more useful decision than my "don't bump". A clean
break means the v2 parser is *simple* rather than a pile of leniency, and the
v1 path becomes a small, well-understood shim.

- **v2 writes `format: bike-network`, `format_version: 2`.** `areas:` required.
- **v1 read = a shim.** Synthesize one area from `city:`/`state:`. If the name
  matches the deployment's bundled place, attach that boundary; otherwise the
  area has a name but no boundary (draw everything, clip nothing, say so). Map
  `jurisdiction: city|state` onto the authorities in D3. **Import only** — the
  tool never writes v1 again, and it tells you it upgraded the file.
- **v2 does not need the legacy leniency.** `treatment` (for `type`) and `kind`
  (for spots) are v1 courtesies; the v2 parser can drop them, because only this
  tool writes v2.

**The principle worth writing down: v2 is the only breakage budget you get.**
Every incompatible change you'll want for the next several years should land in
it, together, once. The current list:

| Change | From D |
|---|---|
| `format: bike-network`, `format_version: 2` | D2 |
| `areas:` replaces `city:`/`state:` | D1 |
| `authorities:` replaces `jurisdiction: city\|state` | D3 |
| `units:` + metric storage | D9 |
| `costs:` overrides and per-area multipliers | D9 |
| path `id` always present | M6 |
| optional path `version` reserved | M6 |
| optional `contributors` / `generated_by` | agents |
| new spot types (pedestrian island, HAWK, …) | D8 |
| drop `treatment` / `kind` aliases | D2 |

Anything not on that list at implementation time is deferred to a hypothetical
v3. **That "is there anything else?" pass is the appendix at the end of this
document** — 20 candidates, triaged.

### D3 — `authorities:`, declared in the file, not an enum *(you're right; two values doesn't survive contact with reality)*

Your NY example breaks it, and so does Massachusetts, closer to home than you'd
think: **DCR owns parkways** — the Fellsway is a state agency that is *not*
MassDOT, with its own process and its own politics. So `city|state` is already
lossy in Malden's own back yard.

For the record on your US question: you're right that Interstates and US routes
are state-owned and state-maintained, with federal funding. Genuinely federal
roads are only those on federal land — national parks, forests, military bases,
some tribal roads. So "federal" is a real but rare level, and NYC is indeed
weird (state routes inside the city are frequently city-maintained).

Rather than guess a universal enum, declare the authorities in the file, the way
areas are declared:

```yaml
authorities:
  - id: malden
    name: City of Malden
    level: municipal          # municipal | county | state | federal | special | private
  - id: massdot
    name: MassDOT
    level: state
  - id: dcr
    name: DCR
    level: special            # a state agency that isn't the state DOT
    note: parkways
  - id: nassau-county
    name: Nassau County DPW
    level: county
paths:
  - name: Fellsway
    authority: dcr            # replaces jurisdiction: state
```

- `level` is a small fixed vocabulary, used only for **rollups and defaults** —
  cost attribution, the "who has to say yes" grouping, and legend ordering. The
  displayed name is always the free-text one, so nothing is mistranslated.
- Each area names a `default_authority` (usually its own municipality), so
  drawing a new path needs no thought.
- v1 shim: `city` → the area's municipal authority, `state` → its state one.
- The editor field becomes a dropdown of the file's authorities, plus
  "Add another…", rather than a hardcoded two-way toggle.

**Totals, per your answer:** the collapsible per-area table, *plus* the same
table groupable by authority — because "how many miles need MassDOT to say yes"
and "how many miles are in Medford" are both questions people actually ask, and
with declared authorities both are one `group by` away. The resting state stays
one combined total so the mobile panel doesn't grow.

### D4 — Three boundary sources, one abstraction *(agreed, unchanged)*

"Change area" offers:

1. **Pick from the US Census** — TIGERweb publishes states, counties, county
   subdivisions, incorporated places and tracts as queryable GeoJSON over
   ArcGIS REST (verify layer ids and CORS against the live service when you
   build it). In New England, **county subdivisions**, not "places", are the
   right unit; elsewhere "places" miss unincorporated territory.
2. **Search OpenStreetMap** — boundary relations, worldwide. The escape hatch
   that keeps the tool from being US-only. (Note: an OSM boundary relation
   arrives as member ways needing assembly into rings — the polygonizer shapely
   used to do. Another reason D1's JS geometry work is on the critical path.)
3. **Upload a GeoJSON** — always works, works offline, and covers "our advocacy
   area is these six neighborhoods", which no registry will have.

The list is additive: pick Malden, then Medford, then Everett. That, not one
giant selection, is how a metro network actually gets assembled — and it makes
D5 fall out for free.

### D5 — Whole-area replace, with an advanced escape hatch *(agreed, plus your two additions)*

```
This file covers 3 areas.

  Malden       142 paths in the file · you have 138    ( ) Use theirs  (•) Keep mine
  Somerville    87 paths in the file · you have none   (•) Add theirs
  Medford       31 paths in the file · you have 40     ( ) Use theirs  (•) Keep mine

  Everett — not in this file. Your 40 paths are untouched.

  ▸ Advanced: choose individual paths

                                     [ Use theirs everywhere ]   [ Bring it in ]
```

- Areas you don't have default to **add**; areas you do have default to **keep
  mine**. Import never destroys work silently.
- **Vocabulary:** add, keep mine, use theirs, areas. Never commit, merge,
  branch, diff, conflict, revision.
- **"Use theirs everywhere" gets a confirmation**, as you asked, naming the
  cost: *"This replaces 138 paths in Malden and 40 in Medford with the ones in
  this file. There's no undo."* — with a **"Save a copy of my network first"**
  button right in the dialog. One click, and the misclick stops being fatal.
  Cheap to build, and it's the only undo story this tool has.
- **Advanced mode** is a collapsed disclosure that expands each area into a
  per-path checklist, defaulting to the area-level choice. Labelled *"Most
  people won't need this — it's easy to end up with two versions of the same
  street."* Power users get precision; nobody else has to see it.
- **Seam-crossing paths** (Main St into Melrose, the Northern Strand across four
  municipalities) belong to the area holding the **majority of their length**,
  so exactly one side owns them. The summary says so: *"3 paths cross into areas
  you're keeping — they stay as you have them."*

### D6 — Phase mapping, per your design *(better than mine; adopted with three refinements)*

Your flow: pick whose phase plan wins, then walk their phases one at a time,
choosing a destination for each — one of mine, or a new phase of its own — with
a warning on out-of-order mapping. Adopted. Three refinements:

1. **Skip the screen entirely in the easy cases.** If either side has exactly
   one phase, or the phase lists already match by number and label, map by
   number and just report it. The fantasy-map user who put everything in Phase 1
   should never learn this screen exists. This matters more than the screen
   itself does.
2. **Default the mapping to identity** (their 1 → your 1, their 2 → your 2) so
   the common case is Confirm, not twelve decisions.
3. **Show deadlines, not numbers.** "Phase 2 — Connector Network, 2032" is a
   choice someone can make; "Phase 2" isn't.

```
Their plan has 2 phases. Yours has 3.
Keeping: (•) my phases   ( ) their phases

  Their "Quick-build spine" (2030)  →  [ my Phase 1 — Core Network, 2029  ▾ ]
  Their "Connectors" (2034)         →  [ my Phase 3 — Outer, 2035         ▾ ]
                                        …or add it as a new phase at the end

                                                  [ Back ]     [ Looks right ]
```

Many-to-one is allowed without comment (two of theirs into one of yours is a
normal thing to want). Only **order inversion** warns: *"Their later phase is
going into an earlier phase than their earlier one. That's allowed, but it means
their sequencing won't survive the import."* — with Back always available.

### D7 — 🚩 **BLOCKER — deferred to its own session, by your call**

Snap-to-road cannot ship as a bundled asset: Malden is 3.9 MB for 5.1 sq mi
(~0.77 MB/sq mi), so Boston metro ≈ 3.6 GB and the US ≈ 3 TB. The obvious answer
is fetching streets from Overpass on demand — and the obvious answer is also how
a popular tool accidentally DDoSes a donated public resource.

**Agreed: this is a blocker, not one of nine questions.** Everything else in
this plan gets designed first; then one or two dedicated sessions on this alone,
before any implementation starts. The things that session has to settle:
self-hosted mirror vs. public Overpass vs. pre-baked tiles on a CDN; hard
client-side rate limits; cache aggressiveness and eviction; what the tool does
when the answer is "no streets available right now"; and whether snapping is
simply *off* outside pre-baked areas until the infrastructure exists.

Two fixes are needed regardless of that outcome, and can be done any time:
`nearestNode` linear-scans all 30,516 nodes per waypoint, and `nearRoad` scans
every edge per point. Both need a grid index. Already borderline in Malden.

### D8 — Reference data: shrink the promise, add a bootstrap *(agreed)*

**Existing infrastructure is just a network file** — paths with
`status: existing` already are the format, so a "region pack" needs no new
concept, and D5's import drops one in without touching anything else.

**"Import existing infrastructure from OpenStreetMap"** presents candidates as a
**review list with checkboxes**, never a blind import. That is exactly the
Centre St problem: you see the candidate, you untick it, it never enters your
file. The same mechanism seeds spots, which map onto OSM tags nearly
one-to-one — `amenity=bicycle_parking`, `barrier=bollard`,
`traffic_calming=hump`, `natural=tree`.

**New spot types** — pedestrian islands and HAWK signals are being added in a
separate session in flight right now, so this plan should *consume* that work
rather than duplicate it. Two notes for whoever wires up the OSM importer
afterward: refuges are reasonably tagged (`crossing:island=yes`,
`traffic_calming=island`), but **HAWK/PHB tagging in OSM is not settled** —
verify against current wiki practice rather than assuming a tag, and be willing
to leave HAWKs out of the importer while keeping them as a spot type.

**Context layers gain an `extent`.** A layer whose bbox doesn't intersect your
boundary is hidden rather than shown empty — that's how the MassDOT crash layers
stop being a lie outside Massachusetts. For a national floor, NHTSA's **FARS**
publishes fatal crashes with coordinates nationwide; serious-injury data stays
state-by-state. So the honest UI is "fatal crashes (nationwide)" plus "bike &
pedestrian crashes (Massachusetts)", plus a documented path for a region to
contribute its own file. `fetch_layers.py` already derives its bbox from the
boundary file, so it mainly needs its `--city-name` default and boundary path
unhardcoded.

### D9 — Metric storage, imperial default, costs that travel *(agreed, and it's cheaper than it looks)*

**The happy accident: lengths are never stored.** The format's own rule — every
consumer measures and clips the geometry itself — means the YAML contains no
distances at all, only lat/lon degrees, which are unit-free. So "switch to
metric" touches exactly two things:

- **the cost table's denominator** ($/mile → $/km), and
- **display**, everywhere.

That's it. `units: metric` in the file, a UI toggle defaulting to **imperial**,
and conversion at the presentation layer only. One canonical storage unit, no
round-tripping error, and the "bicycle lane miles" convention becomes "lane
kilometres" in the label without any arithmetic changing.

Add `currency: USD` alongside it while you're breaking things — same argument,
one field, impossible to retrofit gracefully.

**Costs.** Your instinct is right on both counts: a nationwide local cost model
is doomed, and the adjustments should travel with the file.

```yaml
costs:
  currency: USD
  per_km:                                   # optional override of the built-ins
    quick_build_separated: [95000, 310000]
  by_area:
    census:2510-0038805:                    # Malden
      multiplier: 1.0
    census:2517-0062535:                    # Somerville
      multiplier: 1.15
      per_km:
        concrete_separated: [900000, 2600000]   # per-area, per-type: the nerdy tier
```

Three tiers, and **the UI only ever shows tier one by default**:

1. Nothing — the built-in table, which is what almost everyone gets.
2. One "cost adjustment" number per area, in a collapsed *Advanced* section,
   defaulting to 1.0 and invisible until touched.
3. Per-area, per-type overrides — file-editable, surfaced read-only in the UI.

One thing to insist on: **if a file carries overrides, every export says so.**
These numbers end up on a slide in front of a city council. A footnote reading
*"Cost figures adjusted by the author from the tool's default ranges"* costs one
line and is the difference between a planning estimate and a misleading one.

---

## Milestones

### M-1 — Retire the Python editor *(new, and it goes first)*

Decision A. Delete `editor.py`, `editor/`, and the duplicated
`bikenetwork/` modules; keep `network_format.py` as a standalone reference
validator with a CLI; keep `fetch_layers.py`, `osm.py`, `web/serve.py`; decide
`build.py`'s fate. Port shapely's ring assembly to JS (needed by D1 anyway).
Update AGENTS.md, which currently has "keep the two in step" warnings throughout.

Every later milestone is roughly half the size once this lands.

### M0 — De-Maldenize, zero behavior change

`data/place.json` — the deployment's default area — naming the boundary, street
graph, layers manifest, display name and default authorities. Every hardcoded
path reads it. `MALDEN_BBOX` derives from the boundary. `fetch_layers.py`
defaults from it.

**Acceptance test:** a synthetic `place.json` for a fake town boots the app and
the whole pipeline with no code change. That test *is* the definition of
"geography-agnostic" — write it first and let every milestone move it toward
green. After M0 alone, another city forks the repo, drops in three files, runs.

### M1 — Areas, authorities, and the format v2 break

D1 + D2 + D3 + D4: `areas:`, `authorities:`, the boundary picker, multipolygon
and hole support in the clipper, per-area/per-authority totals, the v1 import
shim, and the units/currency/cost fields from D9 (declared now even if the UI
lands later — they're on the one-time breakage list). The spec, the validator
and the round-trip test move together.

### M2 — Snapping anywhere

**Gated on the D7 blocker session.** Nothing here starts until that's settled.

### M3 — Bring your own context

Layer extents, the OSM existing-infrastructure importer with its review list,
FARS as the national floor (D8).

### M4 — Additive import

The merge UI, area grouping, the phase-mapping flow, the confirmation and
save-a-copy safety net, advanced per-path mode (D5, D6). Depends on M1 for areas
and on nothing else — it can ship before M2/M3 if sharing partial networks turns
out to be the more urgent need. Given that M2 is blocked, it probably is.

### M5 — Scale hardening

Only once real multi-town networks exist:

- **localStorage → IndexedDB, per area.** At ~2.1 KB/path (29 paths = 61 KB
  today), a 100-town metro network is ~6 MB against a ~5 MB quota. Per-area
  records also stop autosave re-serializing everything every 1.2 s.
- **Canvas renderer + viewport culling** for `networkGroup` — context layers
  already use a shared `L.canvas`; the network is still SVG, which stops being
  viable in the low thousands of polylines.
- **Export scales by area**: past a threshold the bundle becomes one file per
  area plus an index, and PNG/GIF export gets an area picker. A nationwide PNG
  is not a document anyone wants.

### M6 — Keys reserved for the other repo

Not built here. Just present in the format, optional, omitted when empty,
invisible in the UI:

| Key | Why it can't be retrofitted |
|---|---|
| area `id` from a public registry (Census GEOID / OSM relation) | a server shards by area, and two people must independently produce the same name for Somerville |
| path `id`, **always assigned** | today it's lazy and only when an upgrade needs one, from 6 random chars. Widen it and always write it, so a path survives export → edit → re-import with its identity intact |
| path `version` (reserved, unused) | OSM's optimistic concurrency needs it and can't invent it later |
| area `updated` | "theirs is newer than yours" is otherwise unanswerable |
| `contributors`, `generated_by`, `license`, `source_url` | attribution, and telling hand-drawn from generated |

The YAML file stays the wire format; a server serves per-area fragments of the
same format. Never invent a second one. The offline, serverless, no-account app
remains the product.

---

## Scale cliffs and gotchas

1. **Clipping silently drops mileage today.** `clip_polyline_latlon` and the JS
   `clipPolylineLatlon` keep only the **single longest** in-boundary piece per
   segment. A path that leaves and re-enters loses the shorter piece. Malden's
   outline hides this; a multi-area union, a hole, or any notched boundary will
   not. **Fix in M1** — it's a live correctness bug that's about to become
   visible.
2. **Multipolygons and holes** — see D1. The single-ring assumption is
   everywhere on the JS side and shapely won't be there to cover for it.
3. **Boundary simplification vs. clip accuracy.** A 10 m tolerance can move a
   border street to the wrong side. Keep ~2–5 m for municipal areas, simplify
   harder only for state/national extents where nothing is clipped precisely
   anyway, and always record the source id so full resolution is re-fetchable.
4. **Duplicate corridors at seams.** Two towns both drawing the Northern Strand
   doubles the mileage. D5's majority-length ownership handles it; the import
   summary must say what it did.
5. **Basemap tile terms.** PNG export draws CARTO tiles. Malden-scale is fine;
   national-scale from many browsers may exceed the free tier. Same family of
   problem as D7 — check before promoting the tool widely.
6. **Whole-country PNG/GIF export** renders hundreds of megabytes of unreadable
   map. M5's area picker is the answer; a size warning will do until then.

## Explicitly out of scope

- **The ordinance tool stays Malden-specific.** `ordinance_chapter` is carried
  through untouched and never shown — exactly right, and it needs **no work at
  all** here. Just don't let anything new start interpreting it.
- Multi-user concurrency, accounts, moderation, sync — the other repo.
- Per-path *merging* (advanced mode is per-path **selection**, which is a
  different and much simpler thing).
- Real regional cost modelling.

## Testing

The suite stays offline. Two additions carry the project:

1. **A synthetic non-Malden fixture** — "Testville", a square boundary, a few
   paths, its own `place.json` — run through every test that currently assumes
   Malden. If Testville passes, the tool is geography-agnostic. If it doesn't,
   it isn't, whatever the code looks like.
2. **A multi-area fixture** with a path crossing the seam and an area with a
   hole, pinning the ownership rule, the both-pieces clipping fix, the
   multipolygon support, and the import-and-replace outcome.

Plus: the v1 → v2 shim gets its own tests against the **checked-in v1 base
network**, and the round-trip stability test (re-save produces no value changes)
survives the v2 break — it's what makes the format safe for both agents and
downstream consumers.

---

# Appendix — the v2 breakage brainstorm

Everything I can find that is (a) awkward today and (b) impossible to fix
without a break. Triaged into **strong / worth debating / probably cross off**.
Nothing here is decided.

The ones already agreed in D1–D9 aren't repeated: `format`/`format_version`,
`areas:`, `authorities:`, `units:`/`currency:`, `costs:`, always-assigned path
`id`, reserved path `version`, `contributors`/`generated_by`, new spot types,
dropping the `treatment`/`kind` aliases.

## ⚠️ First: one that the in-flight session is about to lock in

### V1. Are spot treatments a flat list, or objects with their own status and phase?

Multiselect makes an intersection a **bundle**. The flat version is the obvious
one:

```yaml
spots:
  - location: [42.4251, -71.0662]
    types: [hawk_signal, raised_crosswalk, street_trees, bollards]
    status: proposed
    phase: 1
```

But that forces **one status, one phase and one authority for the whole
bundle** — and at a real intersection those diverge constantly. The trees are
already there; the HAWK is a phase-1 ask; the raised crosswalk waits for the
repaving in phase 3; the bollards are the city's but the signal is MassDOT's.
The flat model can't say any of that, and you'd be back to creating three spots
at the same coordinate — which is exactly what multiselect is meant to stop.

The nested version:

```yaml
spots:
  - name: Main & Salem
    location: [42.4251, -71.0662]
    treatments:
      - {type: street_trees,     status: existing}
      - {type: hawk_signal,      status: proposed, phase: 1, authority: massdot}
      - {type: raised_crosswalk, status: proposed, phase: 3}
```

with status/phase/authority optionally defaulted at the spot level so the simple
case stays short. It costs one nesting level and buys per-treatment phasing,
per-treatment cost attribution (which the format has deliberately left room for
since `jurisdiction` landed on spots), and correct behavior in the phase slider
and per-phase maps.

**My lean: nested, and worth telling the other session now** — the two designs
are the same amount of work *today* and very different amounts of work in a
year. If nested is too much for the UI right now, the compromise that preserves
the option is to ship `treatments:` as a list of objects but only let the UI
edit the `type` field, leaving status/phase inherited from the spot.

## Strong candidates

### V2. `upgrades` should be a list

A concrete rebuild routinely **consolidates** two or three quick-build segments
into one corridor. Today `upgrades` is a single id, so that's unrepresentable —
and `superseded_ids()` would need to change shape to support it later. Make it
`upgrades: [id, ...]` now. Nearly free; impossible later.

### V3. An open `tags:` bag on paths, spots and areas

This is how OSM went twenty years without a v2. A documented, preserved,
tool-ignored key-value map is the pressure-release valve that stops every future
"can we record surface / width / barrier type / the city's project number /
which meeting approved it" from becoming a format change.

```yaml
tags: {surface: asphalt, width_m: 2.4, city_project_id: "TIP-12345"}
```

Rules: preserved on round-trip, never interpreted, never shown in the UI —
exactly the `ordinance_chapter` treatment, generalized. It also makes the tool
much better for agents, who can record their reasoning somewhere structured
instead of stuffing it into `notes`.

**This is the single highest-value item in the appendix**, because it's the one
that reduces the probability of ever needing a v3.

### V4. Split phase **identity** from phase **number**

Today `phase: 2` is simultaneously the phase's name, its sort order, and its
identity. That's what makes D6's cross-file phase mapping fiddly, and it means
inserting a phase in the middle rewrites every path in the file.

```yaml
phases:
  - id: core            # identity — stable, never renumbered
    number: 1           # display and ordering
    label: Core Network (quick-build spine)
    deadline: December 31, 2029
paths:
  - phase: core         # references the id
```

Reordering becomes editing one `number`. Merging two files becomes id mapping
rather than integer mapping. The cost is that `phase: 1` stops being readable at
a glance in raw YAML — real, but the ids are human-chosen words, so `phase:
core` arguably reads *better*.

Given how much of D6's complexity comes from integer collisions, I think this
pays for itself on the merge feature alone.

### V5. `geometry` should always be a list of segments

Today it's polymorphic: a flat point list means one segment, a nested list means
several, and `_parse_segments` sniffs which. A third-party consumer that assumes
flat breaks on the first combined path it meets — and the Northern Strand, a
31-segment entry, is in the shipped network. For a format explicitly meant to be
read by other software, that's a trap.

Always nest. One code path, no sniffing, no ambiguity. Costs one indent level
per path in the raw file.

### V6. Harmonize spot `status` with path `status`

Paths have `proposed | funded | existing`; spots have only `proposed | existing`.
The original reasoning — no funding pipeline for small interventions — doesn't
really hold: a HAWK signal absolutely gets funded and designed before it's
built. Either add `funded` to spots or write down why not, but don't leave the
asymmetry as an accident.

### V7. Version the exported GeoJSON too

`network.geojson` is a second public artifact and it carries no format marker at
all. Adding `format` and `format_version` as FeatureCollection-level properties
costs two lines and means a downstream consumer can tell what it's holding. Do
it while the GeoJSON property names are already changing.

## Worth debating

### V8. `directions: 1|2` doesn't model the facility that's actually most contested

`directions` conflates *how many facilities are on the corridor* with *which way
you can ride*. The case it can't express is a **two-way cycle track on one side
of the street** — one facility, both directions — which is neither of today's
values, and which is precisely the design fight in a lot of quick-build
projects. It also can't express a contraflow lane on a one-way street.

```yaml
travel: two_way          # one_way | two_way   — which way can you ride
sides: 1                 # 1 | 2               — how many facilities got built
```

Lane-mileage then comes from `sides`, and the map arrow comes from `travel`,
which is what each was actually for. You'd know far better than me whether the
lane-mile convention counts a two-way track as one or two — but the format
currently can't even ask the question.

Flagging it as debatable rather than strong only because it touches the mileage
headline number, which is the tool's most public output.

### V9. Rename `from` / `to`

`from` is a Python keyword, which is why the dataclass field is the misspelled
`frm`. If the reference validator stays in Python (decision A), that wart stays
forever. `start` / `end` also avoids implying travel direction, which `from`/`to`
do and which now conflicts with V8's `travel`. Both fields are real — the editor
surfaces them as "From (intersection)" / "To (intersection)" — so this is a
rename, not a removal.

### V10. Widen `status`

Advocacy tracking usually wants more than three states: *existing*, *under
construction*, *designed/funded*, *proposed*, *aspirational*. Every addition is
a break, so if you want any of them, now is when they're free. The counter-
argument is real though: more statuses means more legend entries and more
colors, and the palette is already carrying six path types.

### V11. Distinguish *whose* proposal it is

"The City's adopted 2030 plan" and "what MSS is asking for" are different
things, and a network that mixes them without saying so is the kind of thing
that gets a group's credibility questioned at a hearing. Today the only place to
record it is `notes`. Options: a `proposed_by` field referencing an entry in
`contributors`, or leave it to V3's `tags`. The `tags` answer is probably
sufficient and much cheaper — but the *rendering* question ("show me only the
official plan") is what would justify a real field.

### V12. Let spots carry a line or several points, not just one location

Street trees along a block, bollards down a stretch, a series of speed humps —
all currently need N separate spots. Renaming `location` → `geometry` and
allowing a point, a multipoint or a line would collapse those. It's a genuine
convenience; it's also scope creep into V13's territory, and it complicates
every renderer's glyph placement.

### V13. Unify `paths` and `spots` into one `features` list

The radical version of V12. Both are: name, type, status, authority, phase,
geometry, notes. One list with point-or-line geometry would halve the parser,
the validator, the wire format, the renderers and the merge logic.

Against it: `directions`/`travel`, `upgrades` and `on_street`/`from`/`to` are
path-only; glyph-vs-polyline rendering diverges anyway; the mileage rules differ
(spots carry no length); and — the real argument — "paths and spots" is how
users already think about it, and the UI would have to reintroduce the
distinction it just deleted.

**My lean is no**, but it belongs on the list because v2 is the only moment it's
even askable.

### V14. `deadline` free text vs. a sortable date

`deadline: December 31, 2029` is friendly and unsortable. Adding an optional
ISO `target_date` alongside the free-text `deadline` gives the phase slider,
per-phase exports and any future filtering something real to sort on, without
making anyone type ISO dates. Mild, cheap.

### V15. Top-level `meta:` block

A shared file has nowhere to say what it is. `title`, `description`, `created`,
`updated`, `license`, `source_url` — this partly overlaps the `contributors` /
`generated_by` work already agreed, and is worth designing as one block rather
than as scattered keys. Once files circulate between towns, "what is this and
who made it" stops being optional.

### V16. State the CRS explicitly

WGS84 is assumed everywhere and written down nowhere. `crs: EPSG:4326` in the
file costs one line and closes the one question a GIS professional will
certainly ask. (Related but **not** recommended: switching point order to
GeoJSON's `[lon, lat]`. It would remove a flip at every wire boundary, but
`[lat, lon]` is what a human reads and what every field in the spec says. Keep
`[lat, lon]` and document it loudly.)

## Probably cross off

### V17. Palette / styling carried in the file
Lets a file override the Okabe-Ito colors. Colorblind-safe consistency across
PNG, HTML and editor is a stated project value; making it file-overridable
invites exactly the regression the constants exist to prevent. **No.**

### V18. Multiple scenarios in one file
"Compare our plan with the city's." Interesting, but it's a whole second axis on
top of phases and upgrades, and two files plus the compare view is a better
answer. **No** — and V11's `tags` handles the 80% case.

### V19. Localized names / i18n
`name: {en: ..., es: ...}`. Real for a genuinely international tool, enormous
scope for a hypothetical benefit. `tags` can hold a translation if anyone ever
needs one. **No.**

### V20. Stored lengths
Every so often someone will want a `length` key so a consumer needn't compute
one. The "lengths are derived, never stored" invariant is load-bearing — it's
what makes it impossible for a hand-edited file to disagree with its own
geometry. **Never.** Worth restating in the v2 spec as an explicit
non-feature.

## If you take only the top of the list

`tags` (V3), `upgrades` as a list (V2), always-nested geometry (V5), and phase
ids (V4) are the four I'd fight for — the first because it prevents the *next*
break, the other three because they're each a few lines now and a migration
later. V1 needs a decision this week regardless, because the other session is
building it.

---

# Appendix decisions (reviewed)

| # | Item | Decision |
|---|---|---|
| V1 | Spot treatments nested, not flat | ✅ **in flight** — the sibling session already has per-treatment `type`/`status`/`jurisdiction`/`phase` with spot-level inheritance |
| V2 | `upgrades` as a list | ✅ in |
| V3 | Open `tags:` bag | ✅ in |
| V4 | Phase id separate from number | ✅ in |
| V5 | Always-nested `geometry` | ✅ in |
| V6 | `funded` added to spot statuses | ✅ in |
| V7 | Version the exported GeoJSON, keep it extensible | ✅ in |
| V8 | `travel` + `sides` replace `directions` | ✅ in — **plus `side`**, which applies to points too (see the follow-up) |
| V9 | `from`/`to` → `start`/`end` | ✅ in — see the note on why Python can't have `from` |
| V10 | Widen `status` | ✅ in principle; the list itself is decided below, and rendering is a separate design question |
| V11 | `proposed_by` in advanced properties | ✅ in |
| V12 | Spots may carry line geometry | ✅ — **and it forces V13**, see D10 |
| V13 | Unify `paths` + `spots` | ✅ recommended — full analysis in D10 |
| V14 | Date field for phases | ✅ in — **revised**: free-text `deadline` removed entirely, `target_date` is the only field (see below) |
| V15 | Top-level `meta:` block | ✅ in |
| V16 | State the CRS | ✅ in — explained below |
| V17 | File-carried palette | ❌ renderer concern |
| V18 | Multiple scenarios per file | ❌ renderer + import concern |
| V19 | Localized names | ❌ — and you're right that street names generally aren't translated; i18n belongs in the UI chrome, not the data |
| V20 | Stored lengths | ❌ — recorded as an explicit non-feature in the spec |

## V16 explained — what a CRS is and why one line of it is worth having

A pair of numbers like `42.4251, -71.0662` doesn't mean anything on its own. To
turn it into a place on Earth you need to know three things: where the origin
is, what the units are, and what shape you're assuming the Earth is. A
**coordinate reference system** (CRS) is the bundle of those answers.

**WGS84** is the CRS that GPS uses — degrees of latitude and longitude on a
particular mathematical model of the Earth's shape. It's what your phone
reports, what OpenStreetMap stores, what Leaflet expects, and what GeoJSON
*requires* (RFC 7946 mandates it). So this project is already entirely WGS84;
it has simply never said so.

**EPSG:4326** is the catalogue number for that system. EPSG is a public registry
of coordinate systems, and quoting the number is the machine-readable way to say
"WGS84 latitude/longitude in degrees" without ambiguity.

Why it's worth a line: **other systems are in constant use in municipal GIS, and
they look nothing alike.** Massachusetts has a State Plane system (EPSG:26986)
whose coordinates are metres from an origin near the state — the same Malden
point is roughly `236000, 906000` in it. If a city GIS department sends you a
shapefile, there's a good chance it's in State Plane, not lat/lon. Numbers like
that pasted into a field expecting degrees don't error; they silently land the
path somewhere in the Atlantic. (There's also a genuine but tiny WGS84-vs-NAD83
difference of a metre or two in North America — irrelevant for bike planning,
but the kind of thing a surveyor will ask about.)

So `crs: EPSG:4326` enables nothing. It removes a question, it tells a GIS
professional in one glance that they can use the file directly, and it gives a
future importer somewhere to say "this file is in State Plane — convert it."

## V9 — why `from` can't be a field name in Python

`from` is a reserved keyword (`from x import y`), so `path.from` is a syntax
error and the dataclass has to spell it `frm`. Most languages have this problem
somewhere — `from` is a keyword in Python and Rust, `to` and `type` are awkward
in others, and `class`/`for`/`in` bite constantly. There's no clean workaround:
you can carry a rename map between the YAML key and the field name (which is
what the code does now), but every consumer in every language pays that tax
forever, and the misspelled `frm` shows up in error messages.

`start` / `end` avoids the collision in every language I know of, and reads
better next to V8's `travel` — `from`/`to` sound like direction of travel, which
is now a different field.

## V10 — the status list

The rendering flexibility you point out is real: status is carried by line
*solidity*, so it's orthogonal to the type colours and there's room in dash
patterns, dot patterns and weight. But see D10's vocabulary rule — **status is
one of the closed vocabularies**, because unlike a treatment type it changes the
arithmetic. A reader that meets an unknown status can't know whether to count
those miles as built or as an ask, so it can't degrade safely. That means the
list has to be right now.

Proposed:

| status | meaning | counts as |
|---|---|---|
| `existing` | on the ground | context |
| `under_construction` | being built right now | context |
| `funded` | approved and designed, not started | context |
| `proposed` | the ask | the plan |

`under_construction` is the addition. It's asked about constantly, it's visibly
different from "funded" to anyone walking past, and it's free today. I'd stop
there — "aspirational" is tempting but V11's `proposed_by` plus `tags` covers
the same ground without another legend row.

## V8 — recording which side of the street

Worth adding, and the Spot Pond Brook Greenway is the right motivating case. The
argument for a field rather than just drawing the line on the correct side is
**snapping**: snap-to-road puts geometry on the street centreline, which erases
side information the moment it's used. A free-drawn line carries side
implicitly; a snapped one can't.

```yaml
travel: two_way        # one_way | two_way  — which way you can ride
sides: 1               # 1 | 2              — how many facilities exist
side: right            # left | right | both | median | off_street
```

`side` is defined **relative to the geometry's point order** — the same
convention the one-way chevron already uses, so there's only one rule to learn.

⚠️ **This creates a new gotcha for the Reverse button.** Reverse currently just
flips the point list. With `side` present it must *also* swap `left`↔`right`, or
reversing a path silently moves the greenway to the other side of the street.
That belongs in AGENTS.md's gotcha list the day it ships, with a test.

Nothing has to render it at first. Recording it costs one optional key and means
a future renderer (or a future viewer preference — you're right that it could be
per-viewer) can offset the line to the correct side of the centreline.

---

# D10 — One list or two? (the V13 deep dive)

## The argument that actually decides it

V12 and V13 are not two questions. They're one.

Today the split is clean because it's a **geometry** split: paths are lines,
spots are points. The moment V12 lands and street trees can run along a block,
ask what distinguishes the two lists:

- **Not geometry** — both can be lines.
- **Not category** — a shared-use path is a bike facility, street trees are an
  amenity, but `pedestrianized` is neither, and a modal filter is arguably
  infrastructure of exactly the same kind as a neighborway.
- **Not mileage** — a line of street trees has a length.
- **Not who builds it, not phasing, not status** — all shared already.

There is no definition left. The split survives today only because points and
lines happen to line up with it. So: **either drop V12, or take V13.** Keeping
both means maintaining a distinction whose rule you can no longer write down,
which is exactly how a spec gets confusing enough to need a v3.

Your instinct that it "feels clean" is, I think, detecting this.

## What unification actually buys

Not just "half the parser". The concrete list:

- **`upgrades` starts working for spots.** A HAWK replacing a flashing beacon,
  bollards replacing planters, a raised crosswalk replacing a painted one —
  all currently unrepresentable, all free once spots and paths share a schema.
- **`on_street` / `start` / `end` start working for spots.** "Main & Salem" is
  precisely `on_street` + a cross street. Today spots have a name and a dot.
- **D5's merge logic gets written once.** Area grouping, majority-length
  ownership, replace-this-area, id collision repair — currently all of it has
  to be built twice with slightly different rules for points.
- **One wire format.** The export stops needing two FeatureCollections, and the
  "a payload without a `spots` key must not wipe stored spots" hazard in
  `store.js` disappears with the second key.
- **One clip call site, one validator, one round-trip test.**

## What it honestly costs

- **The UI must keep the distinction users think in.** Draw-a-line and
  drop-a-pin are different gestures with different property panels, and Geoman
  already models them separately. The format not dictating the UI is fine — but
  there will be a temptation to "simplify" the UI to match the format, and that
  would be a real regression. Write that down as a non-goal now.
- **Renderers still branch on geometry kind.** Polyline vs glyph is unavoidable;
  unification moves the branch from "which list is it in" to "what geometry does
  it have". No saving, just a tidier question.
- **Line-only fields need a validator rule.** `travel`, `sides`, `side`,
  `directions`-descendants are meaningless on a point — "this field only applies
  to a line" is a new class of validation error.
- **Serialization order.** Two keys gave a natural grouping for free. One list
  needs a stable rule (preserve input order, or sort by geometry kind then name)
  or every save produces a noisy diff — which matters a lot for the agent
  round-trip guarantee.
- **The key needs a name.** `features:` is GeoJSON jargon that a human reading
  the YAML won't love; `improvements:` is friendlier but wrong for
  `status: existing`; `elements:` is OSM jargon. I lean `features:` on the
  grounds that the UI never shows it and every developer and agent knows the
  word — but it's a genuine naming decision, not an obvious one.

## Multi-treatment paths, and the bus lane you already want

Yes — paths should carry `treatments:` for the same reason spots do, and once
they do, unification is nearly complete anyway. But there's a trap worth naming
before you go near bus lanes.

**Centre St is not a complaint about *which* treatments are present. It's a
complaint about *arrangement*** — the lane sits between a bus lane and a traffic
lane. `treatments: [buffered_painted, bus_lane]` records both facts and captures
exactly none of what's wrong. So multi-treatment paths let you record
multimodality without expressing the thing that makes a design good or bad.

Three levels exist:

| level | expresses | cost |
|---|---|---|
| (a) unordered set | "this corridor has these" | ~free |
| (b) ordered, curb-outward | most real arrangements | needs `side` to be reliable; halfway to a cross-section model |
| (c) full cross-section | everything | a different product |

**Recommend (a) now — and explicitly declare list order insignificant in the
spec.** That one sentence is what keeps (b) reachable: if order is documented as
meaningless, you can later add an optional `arrangement:` key without changing
what any existing file meant. If you *don't* say it, people will write files
with meaningful order, and formal ordering becomes a break.

**The lane-mile trap.** "Bicycle lane miles" is the tool's headline number. The
moment a bus lane can appear in `treatments`, that number will silently inflate
unless treatments carry a **category**. So the registry — slug → `{category,
cost rate, render style, applies to point/line}` — stops being an
implementation detail and becomes the thing that keeps the headline honest. It
lives in code, not in the file.

## The rule that makes bus lanes a non-event

Here's the piece that matters most, and it generalises well past this question:

> **Strict about structure. Lenient-with-notice about vocabulary — but only
> where an unknown value can't change the arithmetic.**

- A file with a malformed geometry, a dangling `upgrades`, a phase that isn't
  declared: **error**, import blocked, exactly as today.
- A file using a treatment type this version doesn't know: **notice, not
  error.** Draw it in a neutral style, exclude it from costs and from bike lane
  miles, and say so plainly — *"This file uses 2 kinds of improvement this
  version doesn't know about. They're shown in grey and left out of the
  totals."*

That single rule means **adding bus lanes later is a registry entry, not a spec
change** — and a network file containing them still opens in an older copy of
the tool, degraded but honest. It's the same insurance V3's `tags` provides for
attributes, applied to vocabulary.

The exception, and it's why the rule needs its second clause: **`status` and
`level` must stay closed**, because an unknown status can't be bucketed as
built-or-asked-for, and getting that wrong silently corrupts the mileage. Hence
V10 being decided now rather than left open.

## A bonus: upgrades get cleaner

With treatments on a shared geometry, "quick-build in 2028, concrete in 2040"
can be **two treatments on one feature** rather than two features with duplicated
geometry. That's worth noticing, because AGENTS.md currently documents three
separate bugs that all trace to that duplication: chevron membership belonging
to `syncArrows()` alone, a replaced path being hidden only while its replacement
is actually shown, and a superseded path drawing a stale one-way arrow. One
geometry, two treatments, and that entire class of bug stops existing.

It doesn't cover every case — a rebuild that *extends* the corridor genuinely is
a different line — so `upgrades` still has to work across features. Make it a
reference to a **treatment id**, and both cases fall out of one mechanism.

## The scope-creep question you were joking about

Worth separating two axes that are easy to conflate:

- **V13 makes the spec smaller.** One schema, one validator, one merge path,
  fewer special cases. That's real and it's the reason to do it.
- **V13 makes the product surface bigger.** Treatments as a list is an open
  invitation to bus lanes, streetcars, sidewalks, greenways, freight loading —
  and you have already accepted the invitation in the same message you worried
  about it. 😄

They're independent decisions. My recommendation: **take V13 for the spec, and
write down that the product stays a bike network tool for now.** The registry
plus the warn-don't-error rule mean that decision is reversible at any time
without touching the format — which is exactly the position you want to be in,
given that neither of us can predict when the scope stops creeping.

If you want a guardrail: adding a treatment to the registry should require
answering three questions in the same commit — what category is it, what does it
cost per unit, and how does it render at every zoom on all four surfaces. Most
tempting additions die honestly at question three.

---

# Revisions after the D10 review

## V14 revised — one date field, no free text

Agreed, and it's the better call: a date that sorts is worth more than a phrase
that reads nicely, and the phase label already carries the human framing
("Core Network (quick-build spine)"). `deadline` is deleted; `target_date`
is the only field, and it's optional — a fantasy map with no dates at all is a
legitimate use.

**Granularity:** accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. Phases are almost
always argued in years, and forcing December 31 onto a plan that says "2029"
invents precision nobody agreed to.

### ⚠️ The YAML timestamp trap — verified, and it's a Python/JS divergence

YAML has an *implicit* timestamp type, so an unquoted date is not a string in
either implementation, and the two disagree about what it becomes:

| YAML | PyYAML | js-yaml |
|---|---|---|
| `target_date: 2029-12-31` | `datetime.date(2029, 12, 31)` | `Date` at **UTC midnight** |
| `target_date: 2029-12` | `'2029-12'` (str) | `'2029-12'` (string) |
| `target_date: 2029` | `2029` (**int**) | `2029` (**number**) |
| `target_date: '2029-12-31'` | `'2029-12-31'` (str) | `'2029-12-31'` (string) |

Two live bugs hide in that table:

1. **An off-by-one-day across the language boundary.** js-yaml produces a `Date`
   at UTC midnight. Format that in any timezone west of UTC — US Eastern, say —
   and `2029-12-31` renders as **December 30**. This is precisely the class of
   bug the Python/JS serialization-parity test exists to catch, and it would
   have shipped silently.
2. **A year-only date becomes an integer**, so `target_date: 2029` arrives as
   the number 2029 in both implementations and every downstream `.startsWith`
   or string slice breaks.

**The rule:** always serialize `target_date` as a **quoted string**, and parse
leniently — if a `date`/`datetime`/`Date`/number arrives, normalize it back to a
`YYYY[-MM[-DD]]` string at the parser boundary, never letting a date object into
the model. js-yaml already quotes the string on dump; PyYAML needs the value to
be a `str` going in. Worth a test in both suites with an explicitly non-UTC
timezone set.

### The v1 import: the one place the shim has to ask

Every other part of the v1 → v2 conversion is mechanical. This one isn't, and
that's worth knowing: it means the shim can otherwise run silently, with a
single interactive step.

```
This file's phases use written dates. Pick a target for each:

  Phase 1 · Core Network       “December 31, 2029”  →  [ 2029-12-31 ]  ✓
  Phase 2 · Connector Network  “December 31, 2032”  →  [ 2032-12-31 ]  ✓
  Phase 3 · Outer              “End of FY35”        →  [          ]  ☐ no target date

                                                          [ Use these ]
```

Parse what's parseable and pre-fill it; leave the rest blank with an explicit
"no target date" option so nothing is invented on the user's behalf. And **keep
the original words** in the phase's `tags` (`deadline_v1: "End of FY35"`) — the
first real use of V3, and it means the conversion is lossless even where it's
lossy.

## V8 follow-up — `side` on points, and geometry that changes kind

You're right, and the scattered-trees example is the interesting one, because it
isn't really about `side` — it's about a feature whose **geometry kind changes
between phases**. A few trees today, a continuous row after the upgrade. That's
a point-set becoming a line, as an upgrade relationship.

Two consequences:

- **`upgrades` must work across geometry kinds.** Three tree points superseded
  by one tree line is a legitimate upgrade, and V2's list-valued `upgrades`
  handles it exactly — the line lists all three point ids. This is a genuinely
  strong argument for D10's unification that I hadn't reached: with two lists,
  a point-set upgrading into a line is an upgrade *across* the paths/spots
  boundary, and there's no sane way to write that.
- **`side` applies to any geometry**, so it shouldn't be line-only.

The definitional wrinkle: on a line, `left`/`right` are well-defined relative to
point order (the same convention the one-way chevron already uses). A point has
no point order, so `left`/`right` has nothing to be relative to.

**Recommendation:** allow `side` on any feature with the same vocabulary
(`left | right | both | median | off_street`); define it relative to point order
for lines; and on a point treat it as **descriptive only** — recorded, shown in
the properties panel, never used to offset the drawn position, because the
point's own coordinates already say where it is. The validator notes rather than
errors. Resist the temptation to add compass values as a second vocabulary for
points: two ways to say the same thing is how a field stops being trustworthy,
and `tags` is there for the genuinely exotic case.

The Reverse-button gotcha from before still stands, and only for lines.

## Multimodal corridors — the case is stronger than the one I argued

I picked the wrong example. Your case isn't recording an existing bad
arrangement, it's **proposing a corridor that carries more than one mode at
once** — a bus lane and a bike lane on a street that has neither, or a streetcar
alongside the Northern Strand on the alignment that was a railroad before.

That's a better argument for treatments-as-a-list than mine was, and it lands
squarely on the nested treatment model:

```yaml
features:
  - name: Northern Strand Trail
    treatments:
      - {type: shared_use_path, status: existing}
      - {type: streetcar,       status: proposed, phase: long-term}
    geometry: [...]
```

One corridor, one geometry, two modes, **different phases** — which the flat
model couldn't express and which is exactly what a long-horizon corridor plan
looks like. The arrangement question I raised still exists, but it's a
*rendering* question for a much later day, and declaring list order
insignificant keeps that door open.

(Noted on Centre St — I used it as an arrangement example rather than as a claim
about what belongs on an existing-conditions map. Point taken that a lane you
wouldn't map is a lane you wouldn't map.)

## V21 (new) — `quantity`, and why car infrastructure isn't quite free

Loading zones and accessible parking do come almost free: they're point
features, the registry marks them a non-bike category so they stay out of
bicycle lane miles, and their capital cost is close to paint-and-a-sign. Nothing
new needed.

What *isn't* free is that **this class of infrastructure is usually about what
gets removed.** A protected lane gets built by taking parking, and loading zones
are the negotiation currency — "we lose 12 spaces and gain 3 loading zones" is
the sentence that decides whether a project survives its public meeting. The
format can already say a thing is proposed or existing, but it has no way to say
*how many*.

**Proposal: an optional `quantity` on a treatment, with its unit declared in the
registry.**

```yaml
treatments:
  - {type: street_trees,    status: proposed, phase: core, quantity: 34}
  - {type: parking_removal, status: proposed, phase: core, quantity: 12}
  - {type: bike_parking,    status: existing,              quantity: 8}
```

- The **registry** says what the unit is (`trees`, `spaces`, `racks`) and
  whether the treatment is counted or measured. Linear treatments don't need
  `quantity` — their geometry already is the quantity — so the registry marks
  each treatment as *counted* or *measured*, and the validator uses that.
- **Removal is just a registry entry.** `parking_removal` with a quantity needs
  no new mechanism, no `removes: true` flag, no negative numbers.
- The payoff is the summary line that ends up on a slide: *"plants 1,200 trees,
  adds 340 bike parking spaces, removes 210 parking spaces."* Those are the
  numbers people actually argue about, and today the tool can't produce any of
  them.

**The one real cost:** it introduces a second cost axis. Today cost is
$/corridor-mile; counted treatments want $/unit. That's a contained addition to
`costs:` (a `per_unit` table beside `per_km`), but it's a genuine addition and
should be on the v2 list rather than discovered later.

I'd take it. It's small, it's obviously right the moment you look at a real
project's negotiation, and — like most of this appendix — it's a break if it
comes later.

---

# Critical pass — what's still open

D7 is the only major open design question. Everything in D1–D6, D8–D10 and
V1–V21 is decided. Below: one genuine contradiction in what we've designed, one
undecided item I flagged and we never came back to, and seven work items that
exist but have never been written down as work.

## 🔴 The contradiction: "list order is insignificant" vs. "what colour is this line?"

We declared treatment order insignificant (D10) so that a meaningful
`arrangement:` key stays reachable later. We also gave every feature a list of
treatments. Those two decisions together break something all four renderers
currently rely on: **one path, one colour.**

A feature with `[shared_use_path, streetcar]` has to draw as *something*. The
obvious answer — "use the first treatment" — is exactly what we forbade by
declaring order insignificant. If any renderer reaches for `treatments[0]`, then
order silently becomes significant, files get authored to exploit it, and the
`arrangement:` door we were protecting quietly closes.

**Fix: the registry declares display precedence, not the file.** Each treatment
carries a precedence rank; the renderer draws the highest-ranked one present and
the legend reflects it. Order in the file stays genuinely meaningless, the
colour is deterministic and identical across the editor, PNG, HTML and GIF, and
two files that list the same treatments in different orders render identically —
which is the property that makes "order is insignificant" *true* rather than
merely stated.

Worth a test that pins it: same treatments, shuffled order, byte-identical
render.

(Related, smaller: the sibling session's spots already have a `type`/primary
notion for the same reason. Whatever it settles on should become the same
precedence mechanism, not a second one.)

## 🟡 Still undecided: `build.py` and `corridors.yaml`

Flagged in decision A as "decide separately", and we never did. It's the last
piece of Python whose fate is unclear.

The case for retiring it: D8's in-browser OSM importer covers the same ground
(resolve real geometry from OSM within a boundary), with a review step it never
had, available to every user rather than only to someone with a Python
environment.

The case for keeping it: corridor-by-intersection-name seeding
("Main Street, from Salem to Pleasant") is a genuinely different authoring
gesture from drawing or reviewing — it's how you go from a written plan to a map
without touching a mouse, and it's plausibly the best interface an **agent** has
for proposing a network. That's a stronger argument now than it was before the
agent conversation.

**My lean: keep it, retarget it.** Make it emit v2 `features:` and treat it as
the headless/agent entry point rather than as the seed path for the editor. It's
small, it's already written, and "describe a corridor in words, get geometry"
is a capability nothing else in the plan replaces.

## Work that exists but has never been written down

### 1. The treatment registry is load-bearing and unspecified

It has quietly accumulated five jobs: category (keeps bus lanes out of bicycle
lane miles), counted-vs-measured plus unit (V21's `quantity`), cost rate (two
axes now — `per_km` and `per_unit`), geometry kinds it applies to, and now
display precedence. Nothing in the plan says where it lives or what shape it is.

It should be **one JSON data file** with a documented schema, not constants in a
JS module — because that's what makes "adding bus lanes is a registry entry, not
a spec change" literally true. It also becomes the single artifact a contributor
reads to answer "what can this tool represent?".

### 2. We introduced a second id namespace without noticing

D10 made `upgrades` reference a **treatment** id (so that a same-geometry
quick-build → concrete upgrade works). Features also have ids. That's two
namespaces, and `upgrades` pointing into one of them while D5's merge logic
rewrites collisions in the other is a bug waiting to be written.

**Recommendation: one shared id namespace for anything referenceable** —
features, treatments, phases, areas, authorities. Uniqueness is validated once,
collision repair on import is written once, and a reference never has to say
what kind of thing it points at. Also decide now whether phase ids from two
merged files can collide (they can — "core" means different things in different
files) and get the same rewrite treatment as feature ids.

### 3. Prepare the *old* readers before v2 files exist

The static app is vendored into the MSS site, so there will be browsers running
a cached v1 copy when the first v2 file reaches them. Today's v1 validator
would emit **both** errors: `unrecognized format 'bike-network'; expected
'malden-bike-network'` *and* the genuinely helpful `format_version 2 is newer
than this tool understands. Update the tool.` The useful message arrives buried
under a confusing one.

**Cheap fix, and it has to happen first: ship a v1 patch release that improves
the error before v2 exists.** A reader that sees an unknown format id *and* a
higher format_version should say only "this file needs a newer version of the
tool" — one clear sentence. Ship that, let it propagate, then build v2. It costs
an afternoon and it's the difference between a confusing transition and an
invisible one.

Also worth stating as a non-feature: **there is no v2 → v1 downgrade export.**
Better to say so than to field the request later.

### 4. ODbL contamination from the OSM importer

D8's "import existing infrastructure from OpenStreetMap" pulls ODbL-licensed
data into a user's `network.yaml`, which they then share. ODbL is share-alike,
and derived databases inherit it. Nobody in this conversation has asked what
that means for a file that mixes OSM-derived existing infrastructure with
hand-drawn proposals — or for the future national server, where it matters
considerably more.

Not something to solve here, but it should be **named in the plan and answered
before the importer ships**, because it's much harder to unwind once files are
circulating. Practical mitigations exist and are cheap if designed in: record
per-feature provenance (`tags: {source: osm}`) so OSM-derived content is
identifiable, put attribution in V15's `meta:`, and decide the project's licence
posture deliberately rather than by accident.

### 5. The repo's own data has to migrate

`network.yaml` (61 KB), `data/base_network.yaml`, their byte-identical `web/`
copies, and every test fixture are all v1. That's a real conversion task nobody
has scheduled, plus a decision: **keep at least one v1 file checked in
permanently** as the shim's regression fixture. If every file in the repo is
v2, the v1 reader stops being tested the moment it's written, and it has to keep
working for years.

### 6. There is no undo, and this is the moment to add one

Autosave overwrites localStorage continuously; a user who deletes a path has
nothing to go back to. We papered over this for imports with "save a copy
first", but it's a general gap that gets worse as networks get bigger and more
shared. Since M5 moves storage to IndexedDB anyway, a rolling last-N snapshots
with a "restore an earlier version" entry is nearly free at that moment and
awkward to retrofit later. Worth folding into M5 rather than leaving implicit.

### 7. The manual burden lands on you, personally

`web/help.md` is human-authored by you, and this project adds an unusual amount
of user-facing surface: change area, import-and-merge, phase mapping,
multiselect treatments, side of street, quantity, units toggle, cost adjustment,
new statuses, and the v1 conversion prompt. That's a lot of writing, and it's on
one person.

**Suggestion: have each milestone produce its "what needs covering in help.md"
list as part of its own definition of done**, rather than arriving as one
enormous documentation debt at the end. It doesn't reduce the work, but it makes
it arrive in survivable pieces and keeps any single milestone from shipping
undocumented.

### 8. A placement rule, so the mobile UI doesn't grow

You've been consistent that mobile clutter is a real constraint, and this plan
adds a lot of controls. Worth one rule stated once, rather than re-litigated per
feature:

> Every new control is either (a) inside an existing menu, (b) a transient
> full-screen sheet that appears only during a task, or (c) behind an "Advanced"
> disclosure that is collapsed by default. **Nothing new lands in the resting
> panel.**

By that rule: area picker → existing menu; import/merge and phase mapping →
transient sheets; side, quantity, `proposed_by`, cost adjustment → Advanced;
units toggle → existing menu; per-area totals table → collapsed, as already
agreed.

### 9. Minor: keep personal data out of `contributors`

V15's `meta:` and the per-area `contributors` will end up in files that
circulate publicly and, eventually, sit on a server. Default them to
organisations and handles rather than personal names and email addresses, and
say so in the spec. One sentence now; a privacy cleanup later otherwise.

## Everything else

D1–D6, D8, D9, D10 and V1–V21 are settled. The remaining sequence is: ship the
v1 error-message patch → resolve D7 → M-1 (retire Python) → M0 → M1 → M4 → M3 →
M2 → M5.
