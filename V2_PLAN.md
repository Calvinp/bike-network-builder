# bike-network-builder v2 — plan

Making the tool geography-agnostic, and taking the one backwards-compatibility
break that buys the room to do it properly. Malden stays the default throughout.

**Status:** design complete. **M-1, M0 and M1 are implemented and
green** (140 pytest + 195 node, cross-language parity included).
M4 is next; M2 is gated on the D7 work in §8.

**This document is the plan.** The turn-by-turn discussion that produced it,
including rejected alternatives and the reasoning behind each call, is in
`V2_DESIGN_NOTES.md`.

---

## 1. The problem

The tool doesn't have a "Malden setting" you can change. It has one implicit
"here", expressed in seven unrelated places that don't know about each other:
the display name, the boundary file, `jurisdiction: city|state`, the bundled
street graph, `MALDEN_BBOX`, the context layers, and the format magic string.

Becoming geography-agnostic isn't a find-and-replace on `Malden`. It's
introducing an explicit **area** that all seven hang off, and letting a network
reference more than one of them. Everything else in this plan follows from that,
plus the decision to spend one compatibility break well.

## 2. Architecture

Three parts, one contract between them:

| Part | What it is |
|---|---|
| **The spec** | `network.yaml` v2. The contract. Governs both other parts. |
| **The UI** | `web/` — the static, offline-capable, no-account editor. The product. |
| **`build.py`** | A headless Python path into the same spec: describe corridors in words, get geometry from OSM. The agent-friendly entry point. |

**The Flask editor is retired.** `web/` is a complete port — nothing the editor
does needs a server, and both versions need a CDN for Leaflet, so Flask isn't
even the more offline one. Retiring it roughly halves the cost of this project,
because every item below currently has to be built twice.

Retired: `editor.py`, `editor/`, `render_map.py`, `render_html.py`,
`pipeline.py`, `geojson.py`, `routing.py`, `boundary.py`, `geometry.py`,
`costs.py`, `tools/export_boundary_polygon.py`.

Kept: `build.py` + `corridors.yaml`, `bikenetwork/network_format.py`,
`bikenetwork/osm.py`, `fetch_layers.py`, `web/serve.py`.

**Keeping `build.py` preserves something the retirement would otherwise have
cost.** `network_format.py` stays alive and exercised as a second, independent
implementation of the spec — which is what has kept the format honest, and what
makes the Python↔JS serialization-parity test possible. That test survives.

**The nationwide server is a different repo.** This repo's entire contribution
to that future is the file format. Not sync, not accounts, not concurrency, not
moderation. Design as if the server will never exist; reserve the keys it would
need (§4.9).

## 3. What replaces shapely

Retiring Python's boundary code means porting real geometry to JS:

- **Ring assembly** — turning OSM boundary relations (member ways) into closed
  rings. Census returns polygons directly; OSM does not.
- **Multipolygons and holes.** Today the JS clipper understands exactly one
  ring. Census and OSM return MultiPolygons routinely — coastal cities with
  islands, towns with exclaves, and enclave municipalities that punch a hole in
  their neighbour.
- **A clipping bug fix.** `clipPolylineLatlon` keeps only the *single longest*
  in-boundary piece per segment, so a path that leaves the boundary and re-enters
  silently loses the shorter piece. Malden's outline hides this. A multi-area
  union, a hole, or any notched boundary will not.

This is the least glamorous and most load-bearing work in the project.

---

## 4. The v2 format

### 4.1 Principles

1. **One break, spent completely.** Every incompatible change worth making for
   the next several years lands in v2, together, once.
2. **Strict about structure. Lenient-with-notice about vocabulary — but only
   where an unknown value can't change the arithmetic.** A malformed geometry
   or a dangling reference is an error that blocks import. An unknown *treatment
   type* is a notice: draw it neutrally, exclude it from costs and lane-miles,
   and say so. This is what makes adding bus lanes later a registry entry rather
   than a spec change. `status` and `level` are the exceptions and stay closed —
   an unknown status can't be bucketed as built-or-asked-for without corrupting
   totals.
3. **Lengths are derived, never stored.** Every consumer measures and clips the
   geometry itself. A hand-edited file cannot disagree with its own geometry.
4. **Round-trip stability.** Read, change one thing, write — the diff shows one
   thing. Non-negotiable, and it's what makes the format safe for agents and
   downstream consumers alike.
5. **Fields you don't understand are preserved,** not dropped.

### 4.2 Shape

```yaml
# Bike network — written by bike-network-builder. See NETWORK_FORMAT.md.
format: bike-network
format_version: 2
crs: 'EPSG:4326'          # WGS84 lat/lon degrees — what GPS and GeoJSON use
units: metric             # storage unit; display is a UI preference (defaults imperial)

meta:
  title: Malden Bike Network Vision
  description: The MSS proposed network, 2026 revision.
  created: '2026-08-23'
  updated: '2026-08-23'
  license: CC-BY-4.0
  source_url: https://maldensafestreets.org
  contributors:
    - {name: Malden Safe Streets, kind: organization}
  generated_by: {tool: claude-opus-5, automated: true}   # optional; see §4.9

areas:
  - id: 'census:2510-0038805'
    name: Malden
    kind: municipality              # municipality|county|tract|state|region|custom
    context: Massachusetts
    default_authority: malden
    updated: '2026-08-23'
    boundary:                       # list of polygons; polygon = [outer, hole...]
      - - [[42.4512, -71.0721], ...]        # outer ring
        - [[42.4400, -71.0600], ...]        # hole (optional)
    tags: {}

authorities:
  - {id: malden,  name: City of Malden, level: municipal}
  - {id: massdot, name: MassDOT,        level: state}
  - {id: dcr,     name: DCR,            level: special, note: parkways}

phases:
  - id: core                        # stable identity — never renumbered
    number: 1                       # display order
    label: Core Network (quick-build spine)
    target_date: '2029'             # QUOTED. See §4.7
    tags: {}

costs:
  currency: USD
  per_km:   {}                      # optional overrides of the built-in registry
  per_unit: {}
  by_area:
    'census:2510-0038805': {multiplier: 1.0}

features:
  - id: f-main-st
    name: Main Street (Salem to Pleasant)
    on_street: Main Street
    start: Main Street & Salem Street
    end: Main Street & Pleasant Street
    notes: Downtown spine.
    tags: {}
    treatments:
      - {id: t-main-qb, type: quick_build_separated, status: proposed,
         phase: core, authority: malden, travel: two_way, sides: 2}
      - {id: t-main-cc, type: concrete_separated, status: proposed,
         phase: long-term, upgrades: [t-main-qb], travel: two_way, sides: 2}
    geometry:
      - - [42.428104, -71.071734]
        - [42.426829, -71.072530]
```

### 4.3 Feature vs. treatment — the dividing rule

> **Anything describing the *place* lives on the feature. Anything describing
> the *facility* lives on the treatment.**

| Feature | Treatment |
|---|---|
| `id`, `name`, `notes`, `tags` | `id`, `type`, `status`, `phase`, `authority` |
| `on_street`, `start`, `end` | `travel`, `sides`, `side`, `quantity` |
| `geometry` | `upgrades`, `proposed_by`, `tags` |

Treatment fields may be defaulted at the feature level and overridden per
treatment, so the common single-treatment case stays short.

**`paths:` and `spots:` are merged into one `features:` list.** The split was
only ever a geometry split, and it stops having a definition the moment a spot
can be a line (street trees along a block). Unification also makes three things
possible that weren't: `upgrades` across geometry kinds (three tree points
superseded by one continuous row), `on_street`/`start`/`end` on point features
("Main & Salem" is exactly that), and D5's merge logic written once instead of
twice.

**Non-goal:** the UI must keep the draw-a-line / drop-a-pin distinction users
think in. The format not dictating the UI is the point; "simplifying" the UI to
match the format would be a regression.

### 4.4 Geometry

`geometry` is a list of **parts**. A part is a list of one or more `[lat, lon]`
coordinates: **one coordinate is a point, two or more is a line.** One feature
may mix both.

```yaml
geometry:
  - [[42.4251, -71.0662]]                          # a point
  - [[42.4280, -71.0717], [42.4268, -71.0725]]     # a line
```

No polymorphism, no sniffing, no flat-vs-nested ambiguity — v1's `geometry`
meant different things depending on its shape, which is a trap for any consumer
that meets a combined path (the 31-segment Northern Strand is one). Coordinates
are `[lat, lon]` degrees, rounded to 6 decimals (~10 cm). Line-only fields
(`travel`, `sides`) are a validation error on a point-only feature.

### 4.5 Treatments and the registry

`type` is a slug resolved against the **treatment registry** — one JSON data
file shipped with the tool, with a documented schema. The registry, not the
spec, defines what the tool can represent. That's what makes "adding bus lanes
is a registry entry, not a spec change" literally true.

Each entry declares:

| Field | Purpose |
|---|---|
| `category` | `bike` / `transit` / `pedestrian` / `calming` / `access` / `greening` / `parking`. **Keeps non-bike treatments out of "bicycle lane miles."** |
| `measure` | `linear` (geometry is the quantity) or `counted` (needs `quantity`) |
| `unit` | for counted treatments: `trees`, `spaces`, `racks`, … |
| `cost` | `per_km` for linear, `per_unit` for counted |
| `geometry_kinds` | which of point / line it may apply to |
| `stack_rank` | draw order — see §4.6 |
| `style`, `glyph`, `label` | rendering, mirrored across all surfaces |

**Treatment list order is insignificant.** Stated in the spec, because that's
what keeps a future `arrangement:` key (curb-outward ordering) reachable without
another break. If order were left undefined, files would be authored to exploit
it and formalising it would become a v3.

`quantity` is how the tool answers the sentence that decides real projects:
*"plants 1,200 trees, adds 340 bike parking spaces, removes 210 parking
spaces."* Removal needs no special mechanism — `parking_removal` is a registry
entry with a `spaces` unit.

### 4.6 Rendering multi-treatment features

A feature carries every treatment it has, and **draws all of them.** A corridor
with a shared-use path and a proposed streetcar shows both.

Mechanism: **stacked strokes.** Draw each treatment on the same geometry,
widest first, narrowest last, ordered by the registry's `stack_rank`. A dashed
overlay on a solid base gives an alternating read where that's clearer. Both are
two draw calls with no parallel-offset geometry maths, and both work identically
in the editor, the exported HTML, the PNG and the GIF frames.

`stack_rank` is **z-order only, never semantics.** It decides what's drawn on
top; it never designates a "primary" treatment, and nothing may consult
`treatments[0]`. Two files listing the same treatments in different orders must
render identically — worth a test that pins exactly that.

**Degradation:** below a zoom threshold, or past ~3 treatments, stacked strokes
turn to mush. Fall back to the highest `stack_rank` alone. The legend lists
treatments, never combinations.

### 4.7 Dates ⚠️

`phases[].target_date` replaces v1's free-text `deadline` entirely. Optional (a
map with no dates is legitimate), and accepts `YYYY`, `YYYY-MM` or `YYYY-MM-DD`
— phases are argued in years, and forcing December 31 onto "2029" invents
precision nobody agreed to.

**YAML has an implicit timestamp type, and the two implementations disagree.**
Verified:

| YAML | PyYAML | js-yaml |
|---|---|---|
| `target_date: 2029-12-31` | `datetime.date` | `Date` at **UTC midnight** |
| `target_date: 2029` | `2029` (**int**) | `2029` (**number**) |
| `target_date: '2029-12-31'` | `str` | `string` |

Two bugs hide there: a js-yaml `Date` at UTC midnight, formatted anywhere west
of UTC, renders `2029-12-31` as **December 30**; and a year-only value arrives
as an integer in both.

**Rule: always serialize quoted; normalize any date object or number back to a
`YYYY[-MM[-DD]]` string at the parser boundary; never let a date object into the
model.** Test in both suites with a non-UTC timezone set.

### 4.8 Vocabularies

**Status** (closed — it changes arithmetic):

| status | meaning | counts as |
|---|---|---|
| `existing` | on the ground | context |
| `under_construction` | being built now | context |
| `funded` | approved and designed, not started | context |
| `proposed` | the ask | the plan |

**Authority `level`** (closed): `municipal | county | state | federal | special
| private`. Used only for rollups and defaults; the displayed name is always the
free-text one, so nothing is mistranslated. `city|state` was already lossy in
Malden's own back yard — DCR owns the parkways and is not MassDOT.

**Travel and sides** (closed):

```yaml
travel: two_way        # one_way | two_way  — which way you can ride
sides: 1               # 1 | 2              — how many facilities exist
side: right            # left | right | both | median | off_street
```

This replaces v1's `directions`, which conflated "how many facilities" with
"which way you can ride" and so couldn't express a **two-way cycle track on one
side of the street** — one facility, both directions — or a contraflow lane.
Lane-mileage comes from `sides`; the map arrow comes from `travel`.

`side` is relative to the geometry's point order for lines (the same convention
the one-way chevron uses) and **descriptive-only on points**, where the
coordinates already say where the thing is. It exists because snap-to-road puts
geometry on the centreline and erases side information.

> ⚠️ **Reverse must swap `left`↔`right`.** Reversing currently just flips the
> point list; with `side` present it must also flip the value, or reversing
> silently moves the facility across the street. Goes in AGENTS.md with a test
> the day it ships.

**Treatment types** are open, per §4.1 principle 2.

### 4.9 Identity and references

**One shared id namespace** for everything referenceable — areas, authorities,
phases, features, treatments. Uniqueness is validated once, import collision
repair is written once, and a reference never has to say what kind of thing it
points at.

- **Ids are always assigned**, not lazily when something needs one. A feature
  keeps its identity across export → edit → re-import.
- **`upgrades` is a list of treatment ids.** A concrete rebuild routinely
  consolidates two quick-build segments, and three tree points can be superseded
  by one continuous row. Referencing *treatments* means a same-geometry upgrade
  is two treatments on one feature — which deletes a whole class of bug, since
  AGENTS.md documents three separate gotchas that all trace to upgrades
  duplicating geometry (chevron membership, hidden-only-while-replacement-shown,
  stale one-way arrows).
- **Phase ids can collide across merged files** — "core" means different things
  in different files — and get the same rewrite treatment as feature ids.

**Reserved for the other repo** (present, optional, omitted when empty,
invisible in the UI): area ids from a public registry (Census GEOID / OSM
relation), a per-treatment `version` (OSM-style optimistic concurrency needs it
and can't invent it later), area `updated`, and `contributors` / `generated_by`
/ `license` / `source_url`.

`contributors` accepts personal names as well as organizations — people who did
the work may want the credit, and the spec shouldn't rule that out. The UI
should not pre-fill a real name by default, and the field's documentation should
say plainly that these files circulate publicly.

`generated_by` exists because a future server that can't distinguish hand-drawn
from generated content has no way to moderate fairly — and by then the files are
already circulating. OSM's automated-edits code of conduct is the precedent.
Nothing in this repo needs to act on it.

### 4.10 The v1 shim

Import-only. The tool never writes v1, and **there is no v2 → v1 downgrade
export.**

Mechanical conversions: `city`/`state` → one synthesized area (with the
deployment's boundary if the name matches, otherwise a named area with no
boundary — draw everything, clip nothing, say so); `jurisdiction: city|state` →
the area's municipal / state authority; `paths` + `spots` → `features`;
singular `type` → a one-element `treatments` list; `directions` → `travel` +
`sides`; flat-or-nested `geometry` → parts; `treatment` and `kind` aliases
resolved and dropped; ids assigned where missing.

**One interactive step** — everything else runs silently:

```
This file's phases use written dates. Pick a target for each:

  Phase 1 · Core Network       “December 31, 2029”  →  [ 2029-12-31 ]  ✓
  Phase 2 · Connector Network  “December 31, 2032”  →  [ 2032-12-31 ]  ✓
  Phase 3 · Outer              “End of FY35”        →  [          ]  ☐ no target date
```

Pre-fill what parses; leave the rest blank with an explicit "no target date"
option so nothing is invented. **Keep the original words** in the phase's
`tags` (`deadline_v1: "End of FY35"`) — the conversion is then lossless even
where it's lossy.

**Old readers:** a v1 reader meeting a v2 file emits both "unrecognized format"
and the genuinely useful "format_version 2 is newer than this tool understands."
A small v1 patch collapsing those into one clear sentence is worth shipping —
**separate session, low priority**, since the app isn't vendored into the MSS
site yet and the stale-reader population is currently one machine.

---

## 5. Areas, authorities, and totals

**Boundaries come from three sources behind one abstraction:**

1. **US Census (TIGERweb)** — states, counties, county subdivisions, places,
   tracts as queryable GeoJSON over ArcGIS REST. Verify layer ids and CORS
   against the live service at implementation time. In New England, **county
   subdivisions** are the right unit, not "places"; elsewhere "places" miss
   unincorporated territory.
2. **OpenStreetMap boundary relations** — worldwide. The escape hatch that keeps
   the tool from being US-only. Needs the ring assembly from §3.
3. **Upload a GeoJSON** — always works, works offline, covers "our advocacy area
   is these six neighbourhoods", which no registry has.

**Areas are derived, not configured.** The deployment's `place.json` names a
default area, so the common user never picks anything. Drawing past its edge
behaves exactly as it does today — the line is clipped at the boundary with the
existing notice — except the notice now carries a one-click **"Add Medford"**.
Nothing is auto-added silently (that would quietly change what the totals mean),
and nothing has to be chosen up front. The picker in the menu exists for people
who deliberately want a different or wider area.

The area list is **additive**: Malden, then Medford, then Everett. That, not one
giant selection, is how a metro network actually gets assembled — and it makes
the import model in §6 fall out for free. Selecting a whole state or
country stays legal; it degrades honestly (§9) rather than being forbidden.

**The boundary travels inside the file**, so a shared network is
self-describing: whoever receives Somerville's network gets Somerville's outline
and can draw and clip it with no lookup and no network call. Simplify to ~2–5 m
for municipal areas (a 10 m tolerance can move a border street to the wrong
side); simplify harder only for state/national extents, where nothing is being
clipped precisely anyway. Always record the source id so full resolution is
re-fetchable.

**Totals** default to one combined figure, with a collapsible table that groups
by **area** or by **authority** — "how many miles are in Medford" and "how many
miles need MassDOT to say yes" are both questions people actually ask, and
declared authorities make both one `group by` away.

---

## 6. Import: whole-area replace

The unit of replacement is a whole area. No per-path merge, no conflict UI, no
three-way anything. This maps onto how the work is actually divided — one group
owns one town — and it's why the feature can be explained in a sentence.

```
This file covers 3 areas.

  Malden       142 features in the file · you have 138   ( ) Use theirs  (•) Keep mine
  Somerville    87 features in the file · you have none  (•) Add theirs
  Medford       31 features in the file · you have 40    ( ) Use theirs  (•) Keep mine

  Everett — not in this file. Your 40 features are untouched.

  ▸ Advanced: choose individual features

                                     [ Use theirs everywhere ]   [ Bring it in ]
```

- Areas you don't have default to **add**; areas you do have default to **keep
  mine**. Import never destroys work silently.
- **Vocabulary:** add, keep mine, use theirs, areas. Never commit, merge,
  branch, diff, conflict, revision.
- **"Use theirs everywhere" confirms**, naming the cost — *"This replaces 138
  features in Malden and 40 in Medford. There's no undo."* — with a **"Save a
  copy of my network first"** button in the dialog.
- **Advanced** expands each area into a per-feature checklist, defaulting to the
  area-level choice, labelled *"Most people won't need this — it's easy to end
  up with two versions of the same street."*
- **Seam-crossing features** belong to the area holding the majority of their
  length, so exactly one side owns them. The summary says so: *"3 features cross
  into areas you're keeping — they stay as you have them."*

### Phase mapping

Skipped entirely when either side has one phase, or the phases already match by
number and label — the fantasy-map user who put everything in Phase 1 should
never learn this screen exists. Otherwise it defaults to identity mapping, so
the common case is one confirmation:

```
Their plan has 2 phases. Yours has 3.
Keeping: (•) my phases   ( ) their phases

  Their “Quick-build spine” (2030)  →  [ my Phase 1 — Core Network, 2029  ▾ ]
  Their “Connectors” (2034)         →  [ my Phase 3 — Outer, 2035         ▾ ]
                                        …or add it as a new phase at the end

                                                  [ Back ]     [ Looks right ]
```

Phases show **labels and dates, not numbers** — "Phase 2" isn't a choice anyone
can make. Many-to-one is allowed silently. Only **order inversion** warns:
*"Their later phase is going into an earlier phase than their earlier one.
That's allowed, but their sequencing won't survive the import."*

---

## 7. Reference data

**No network data ships in the repo.** `data/base_network.yaml` and its `web/`
copy are removed; the convention is **import what already exists**. Existing
infrastructure is just a v2 file with `status: existing` treatments, passed
around per geography — which needs no new concept and no special handling.

Consequences:

- **A deployment may configure its own seed** via `place.json`, so the MSS
  deployment still opens on Malden's existing conditions without the repo
  carrying network data.
- **The user never imports to get started.** Import is how groups share work
  with each other, not how anyone begins. A configured deployment opens exactly
  as it does today — Malden, its boundary, its existing conditions, no
  questions asked. A deployment with no seed opens on a blank map at its default
  area, which is still not a setup step: you can just draw.
- **The first-run card is an offer, not a gate** — a dismissible "start from
  what's already on the ground?" with the OSM review-import behind it. Never a
  modal, never blocking.
- **Test fixtures stay** — small and synthetic, plus **one v1 file kept
  permanently** as the shim's regression fixture. If every file in the repo is
  v2, the v1 reader stops being tested the day it's written, and it has to keep
  working for years.

**"Import existing infrastructure from OpenStreetMap"** presents candidates as a
**review list with checkboxes**, never a blind import — you see the candidate,
you untick it, it never enters your file. The same mechanism seeds point
treatments, which map onto OSM tags nearly one-to-one
(`amenity=bicycle_parking`, `barrier=bollard`, `traffic_calming=hump`,
`natural=tree`). Refuge islands are reasonably tagged; **HAWK/PHB tagging is not
settled** — verify against current wiki practice rather than assuming, and be
willing to leave HAWKs out of the importer while keeping them as a treatment
type.

**Context layers gain an `extent`.** A layer whose bbox doesn't intersect your
boundary is hidden rather than shown empty — that's how the MassDOT crash layers
stop being a lie outside Massachusetts. For a national floor, NHTSA **FARS**
publishes fatal crashes with coordinates nationwide; serious-injury data stays
state-by-state. `fetch_layers.py` already derives its bbox from the boundary
file, so it mainly needs its `--city-name` default and boundary path
unhardcoded.

---

## 8. D7 — snapping at scale, and the licence question

Resolved. Two problems that look intractable become tractable once each is
reframed: the thing that doesn't scale isn't *snapping*, it's **a globally
connected routing graph**; and the licence problem isn't a constraint to escape,
it's a licence to **adopt**.

### 8.1 The reframe

Snapping needs, at the moment of a click: the street geometry within ~30 m of
the point, and a way to follow the street between consecutive waypoints,
typically a few hundred metres to a couple of kilometres apart.

**It never needs the whole city, let alone the whole country.** It needs a local
window. The current implementation loads a 3.9 MB graph for all of Malden
because Malden is small enough to get away with it — that's an accident, not a
design.

So the requirement is: *road geometry for the current viewport, from somewhere
that can absorb unlimited traffic.* Which is a solved problem — it's how every
map on the internet works.

### 8.2 The data source: roads-only vector tiles on your own static storage

**Decision: a roads-only PMTiles archive, served as static files, read by HTTP
range requests.**

- **PMTiles** is a single-file tile archive designed to sit on dumb static
  storage. The browser fetches byte ranges for the tiles it needs; there is no
  tile server, no database, no process to keep alive.
- Generated from **Geofabrik regional extracts** — free, and exactly the input
  this needs.
- Hosted on object storage without egress fees (Cloudflare R2 or similar), or
  any static host. **Static files cannot be DDoSed by your own users** in the
  way a query API can, because there is no query — just cacheable bytes with a
  flat cost curve.
- Cached in IndexedDB after first fetch, so repeat drawing in an area is free
  and works offline.

**Roads-only matters.** Strip everything that isn't routable geometry — no
names beyond what tracing needs, no buildings, no landuse, no POIs. The
tool needs connectivity and shape, nothing else.

**Size is the open number, and it's cheap to settle.** Malden's 3.9 MB is
uncompressed JSON with string keys — a fat representation. Packed binary tiles
with delta-encoded coordinates should be roughly an order of magnitude smaller,
which would put Massachusetts comfortably under a gigabyte and a metro area in
the tens of megabytes. **First implementation step is a spike: generate a
roads-only PMTiles for Massachusetts and measure it.** A day's work, and it
turns the central unknown of this section into a fact before anything depends
on it.

**Regions are opt-in, and that's consistent with the rest of the plan.**
Generating an extract for your region is exactly the kind of thing a regional
advocacy group can do for itself — the same "region pack" model already adopted
for existing infrastructure (§7). MSS hosts New England; nobody is obliged to
host the planet; `place.json` points at whichever archive a deployment uses.

### 8.3 The algorithm: route over a bounded local window

Build the graph **from the tiles already loaded**, not from a global asset.

1. Road features arrive as tile geometry, clipped at tile edges. Reconstruct
   local connectivity by matching segment endpoints within and across the loaded
   tiles.
2. Route between consecutive waypoints inside that local graph — the same
   Dijkstra that exists today, over a window instead of a city.
3. If a route would leave the loaded window, load the covering tiles and retry
   once; if it still fails, fall back to a straight segment, exactly as today.

This preserves the current UX for the corridor lengths people actually draw. It
also keeps the existing rule that a waypoint more than ~30 m from any road edge
stays deliberately free-drawn, so park interiors and cut-throughs still behave.

Two honest caveats: tile geometry is **generalized** for display, so snapped
lines are a few metres less precise than raw OSM — negligible at the zoom levels
where anyone draws carefully. And minor roads drop out at low zoom, so
**snapping requires being zoomed in**, which the UI should say plainly rather
than failing silently.

### 8.4 Degradation ladder

Snapping never blocks drawing. It gets better as data is available:

| Situation | Behaviour |
|---|---|
| Deployment ships a bundled graph (Malden today) | Full routing, offline, instant |
| A roads archive covers the area | Tiles fetched and cached; local-window routing |
| No archive for this area | Free-draw, with a plain note: *"Snapping isn't available here yet"* |
| Zoomed too far out | Snapping off, with the reason shown |

The bundled-graph path stays supported. It's the offline story, it keeps the
test suite offline, and it costs nothing to keep.

### 8.5 The rules that keep this ethical

1. **The browser never calls a public Overpass instance.** Not at draw time, not
   on pan, not as a fallback. Overpass's usage policy discourages exactly this
   pattern, and a browser tool cannot bound its own user count.
2. **Overpass stays a batch tool** — `build.py` and `fetch_layers.py`, where
   volume is controlled, a human is present, the existing throttle and cache
   apply, and the User-Agent carries a reachable contact. Keep it that way.
3. **The OSM import (§7) runs through the same batch path or against the tile
   archive**, never as a live browser query loop.
4. **Basemap tiles get the same scrutiny.** PNG export currently draws CARTO
   raster tiles under a free tier that was never sized for national use. If the
   roads archive lands, self-hosting a basemap becomes cheap by the same
   mechanism — worth doing together.

> A tool whose growth is a burden on a donated public resource has a bug, not a
> success. Static self-hosted tiles turn scale from someone else's problem into
> a line item you control.

### 8.6 The licence question: adopt ODbL rather than route around it

OSM data is ODbL. Extracting substantial geometry into a file you then
distribute produces a *derivative database*, which carries share-alike and
attribution. That applies to imported existing infrastructure, and — more
subtly — to **any line drawn with snapping on**, since its geometry is traced
from OSM.

The instinct is to treat this as a constraint. It isn't. **A community-built,
freely shareable network map is what ODbL is for**, and it's what this project
already wants. Share-alike keeps a contributed regional network open to the
community that built it, which is the same instinct behind the whole plan.

**Decision:**

- **Default `meta.license` to ODbL-1.0** for any network containing OSM-derived
  content, and say so plainly in one paragraph of help.md.
- **Attribute** — "© OpenStreetMap contributors" in `meta:`, on every exported
  map, and in the editor's credit line. Non-negotiable and nearly free.
- **Tag provenance per feature** (`tags: {source: osm}`), which the spec already
  reserves. This keeps OSM-derived content identifiable and separable, so a user
  who needs a differently-licensed artifact can export their own work alone.
- **Produced works are fine.** The exported PNG and HTML maps are produced
  works; attribute them and move on. Share-alike bites the data file, not the
  picture.
- Get a real read from someone qualified before the national server exists.
  The stakes there are higher than they are here, and this plan's job is only to
  keep the option open and the provenance recorded.

### 8.7 Defusing Google by making the legal path the easy one

You're right that people and agents will consult *something*. If the tool offers
nothing, they reach for Google satellite view, whose terms prohibit deriving
data from it — a worse outcome than the problem being avoided.

The mitigation is provision, not prohibition:

- **Ship an open aerial imagery option.** US federal **NAIP** imagery is public
  domain and nationwide; many states and municipalities publish open
  orthoimagery, and **MassGIS** does for Massachusetts. An optional imagery
  basemap, sourced per region like context layers, removes the reason to go
  looking.
- **Make the OSM path obviously blessed** — the review-list importer of §7 is
  the sanctioned way to bring in what already exists, and it should be easy to
  find.
- **Say it once, plainly, in help.md**: don't trace from Google or other
  proprietary imagery; here's what to use instead. A single clear sentence does
  more than a policy.

### 8.8 Regardless of any of the above

`nearestNode` linear-scans all 30,516 nodes per waypoint and `nearRoad` scans
every edge per point. Both need a grid index. Already borderline in Malden, and
required by every option above.

### 8.9 How much hosting, and what stays portable

**Hosting is one object-storage bucket holding one file. There is no server, no
database, and no process to keep alive.**

Rough costs, pending the spike in §8.2 (object storage at ~$0.015/GB-month with
no egress fees):

| Coverage | Est. size | Storage cost |
|---|---|---|
| Greater Boston | tens of MB | free, effectively |
| New England | ~1 GB | ~$0.02 / month |
| Whole US | tens of GB | well under $1 / month |

Range requests bill per million and stay in single-dollar territory even at
optimistic usage. **Call it under $10/month in a growth scenario, and $0 today.**
The real cost isn't money, it's occasionally re-running a batch job to
regenerate the archive.

**The app stays static.** Tiles are static files too — nothing in this plan
introduces a dynamic component. What changes is that one asset may live at a
different origin, which is not a new kind of dependency: the app already loads
Leaflet and Geoman from a CDN and basemap tiles from CARTO. Self-hosting road
data makes it *less* dependent on third parties, not more.

Anyone can still take `web/` and run it anywhere. Three options, in descending
order of effort:

1. **Point `place.json` at MSS's archive.** A URL. Works immediately.
2. **Host your own.** Same file, your bucket.
3. **Bundle a graph for your area** — today's Malden mechanism, kept supported —
   or ship no snapping at all.

**Hosting is therefore optional.** If MSS never wants to run a bucket, Malden
keeps working exactly as it does now, and snapping simply doesn't extend past
the bundled area. That is a legitimate end state, not a failure mode.

One honest regression: today's bundled graph works fully offline once loaded,
whereas tiles work offline only for areas already cached in IndexedDB. Keeping
the bundled path supported is what covers that.

### 8.10 Nothing here becomes the user's problem

Checked against the simplicity rule, because it would be easy to let this leak:

| Concern | What the user actually experiences |
|---|---|
| Choosing a region | Never. The deployment has a default; you open the app and draw. |
| Region borders | The same "clipped at the city line" notice that exists today, now with an **Add Medford** button on it. |
| Importing to get started | Never. A configured deployment opens with existing conditions already present. |
| Exporting to save | Never. Autosave is unchanged. Export is for sharing. |
| Snapping not available | Behaves identically to today's off-street click — the line stays where you put it. A quiet status note, never a dialog. |
| Hosting, tiles, licences | Invisible. Deployment configuration and a credit line. |

The only genuinely new visible surface is the merge sheet (§6), and that appears
only when someone deliberately opens a file another group sent them.

### 8.11 What this changes elsewhere in the plan

- **M2 is unblocked**, and gains the PMTiles spike as its first step.
- **M3's OSM importer** inherits the provenance tagging and the batch-only rule.
- **M5's rendering work** may be partly pre-empted if a vector basemap arrives —
  worth revisiting then, not now. (A later move to MapLibre would fold basemap,
  snapping data and large-scale rendering into one stack; the blocker is that
  Geoman is Leaflet-specific, so verify what editing tooling exists there before
  treating it as a plan.)
- **`meta.license` and `tags.source`** are already in the v2 spec. No spec change
  is needed for any of this — as you predicted.

## 9. Milestones

| | Milestone | Contents |
|---|---|---|
| **M-1** | Retire the Flask editor | §2. Port ring assembly, multipolygons, holes and the clipping fix to JS (§3). Retarget `build.py` at v2. Update AGENTS.md, which currently says "keep the two in step" throughout. |
| **M0** | De-Maldenize | `data/place.json` — the deployment's default area, boundary, street graph, layers manifest, display name, default authorities. `MALDEN_BBOX` derives from the boundary. Remove `base_network.yaml` (§7). |
| **M1** | The v2 format | §4 in full, plus §5. The spec, the validator, `network_format.py`, `network_format.js` and the round-trip test move together. |
| **M2** | Snapping anywhere | §8. Starts with the PMTiles size spike, then the roads archive, local-window routing, and the grid index. |
| **M3** | Bring your own context | §7 — layer extents, the OSM importer with its review list, FARS. |
| **M4** | Additive import | §6. Depends on M1 and nothing else. Since M2 is blocked, this is probably the more urgent path. |
| **M5** | Scale hardening | Below. |

**M0's acceptance test is the definition of done for the whole project:** a
synthetic `place.json` for a fake town boots the app and the whole pipeline with
no code change. Write it first; let every milestone move it toward green.

**M5 contents:**

- **localStorage → IndexedDB, stored per area.** At ~2.1 KB per feature, a
  100-town metro network is ~6 MB against a ~5 MB quota. Per-area records also
  stop autosave re-serializing everything every 1.2 s.
- **Undo/redo** — a real stack with toolbar buttons plus ctrl-Z / ctrl-Y, since
  there is currently no undo at all. An import is one undo step. Note the
  scaling shape: a bounded stack of serialized states is trivial for a
  single-town network and untenable at metro scale, so this wants command-based
  undo, not state snapshots. Mobile needs the buttons regardless.
- **Canvas renderer + viewport culling** for the network layer. Context layers
  already share an `L.canvas`; the network is still SVG, which stops being
  viable in the low thousands of features.
- **Export scales by area** — past a threshold the bundle becomes one file per
  area plus an index, and PNG/GIF export gets an area picker. A nationwide PNG
  is not a document anyone wants.

---

## 10. UI rule

> Every new control is either **(a)** inside an existing menu, **(b)** a
> transient full-screen sheet that appears only during a task, or **(c)** behind
> an "Advanced" disclosure collapsed by default. **Nothing new lands in the
> resting panel.**

Someone who wants to draw lines on a map should never have to understand more
than "button? click." Someone who goes looking for complexity should find it.

| Control | Placement |
|---|---|
| Area picker, units toggle | existing menu |
| Import / merge, phase mapping, first-run, v1 date prompt | transient sheet |
| `side`, `quantity`, `proposed_by`, cost adjustment, treatment multiselect beyond the first | Advanced |
| Per-area / per-authority totals | collapsed by default |

---

## 11. Non-features (decided against, with reasons)

- **Stored lengths.** The derive-never-store rule is what makes it impossible
  for a hand-edited file to disagree with its own geometry. Permanent.
- **A palette carried in the file.** Colourblind-safe consistency across four
  surfaces is a project value; making it file-overridable invites exactly the
  regression the shared constants prevent. Renderer concern.
- **Multiple scenarios in one file.** Two files plus a compare view is better,
  and the import model already combines files.
- **Localized names.** Street names generally aren't translated — "Cedar St" in
  French is "Cedar St". i18n belongs in the UI chrome, not the data.
- **Per-feature merging on import.** Advanced mode is per-feature *selection*,
  which is a different and much simpler thing.
- **Ordinance tooling beyond Malden.** Municipal code structure varies too much.
  `ordinance_chapter` is carried through untouched and never interpreted — the
  right treatment, and it needs no work here.
- **A v2 → v1 downgrade export.**
- **Multi-user concurrency, accounts, moderation, sync.** The other repo.
- **Real regional cost modelling.** Doomed. Multipliers that travel with the
  file are the honest ceiling.

**Scope guardrail:** adding a treatment to the registry requires answering three
questions in the same commit — what category, what cost per unit, and how it
renders at every zoom on all four surfaces. Most tempting additions die honestly
at question three.

---

## 12. Testing

The suite stays offline. Four things carry this project:

1. **A synthetic non-Malden fixture** — "Testville", a square boundary, a few
   features, its own `place.json` — run through every test that currently
   assumes Malden. If Testville passes, the tool is geography-agnostic. If it
   doesn't, it isn't, whatever the code looks like.
2. **A multi-area fixture** with a feature crossing the seam and an area with a
   hole — pinning the ownership rule, the both-pieces clipping fix, multipolygon
   support, and the import-and-replace outcome.
3. **A permanent v1 fixture** for the shim, kept forever.
4. **Parity and stability:** Python↔JS serialization agreement (preserved by
   keeping `build.py`), round-trip with no value changes, shuffled-treatment
   render equality (§4.6), and the date handling of §4.7 under a non-UTC
   timezone.

---

## 13. `help.md` outline

The manual is human-authored by Calvin and is written at the end. This is the
structure to write into — new sections marked **new**, changed ones **changed**.

1. **Getting started**
   - **new** First run: choosing your area
   - **new** Starting from existing conditions (import, or pull from OSM)
   - Drawing your first line
2. **Your area** — **new**
   - Picking from the Census list, searching OpenStreetMap, uploading your own
   - Adding a second town; what "areas" means for totals
   - Why things get clipped at the line
3. **Drawing the network** — **changed**
   - Features and treatments: one place, one or more things being built
   - Adding more than one treatment (and why the order doesn't matter)
   - Which way you can ride, how many sides, which side of the street
   - Points and lines; when a row of trees is which
4. **Planning over time** — **changed**
   - Phases, labels and target dates
   - Upgrades: building now and rebuilding later
   - The Show menu, and why totals never change with it
5. **Who builds it** — **changed**
   - Authorities; adding one; what "level" is for
   - What the cost estimate does and doesn't mean
   - **new** Adjusting costs for your area (Advanced)
6. **Sharing** — **new**
   - Exporting, and what's in the file
   - Bringing in someone else's network: add, keep mine, use theirs
   - When phases don't line up
   - Advanced: picking individual features
   - Saving a copy before a big import
7. **Reference data** — **changed**
   - Map layers, and why some are only available in some places
8. **Reference**
   - **changed** Units (miles or kilometres)
   - **new** Undo and redo
   - **changed** Opening a file made in an older version
   - Exporting maps, images and GIFs

---

## 14. Sequence

**M-1** (retire Flask) → **M0** (de-Maldenize) → **M1** (v2 format) →
**M4** (import) → **M3** (context) → **M2** (snapping, if D7 allows) → **M5**
(scale + undo). The v1 error-message patch is a separate low-priority session
whenever convenient.

The one experiment worth running before any of it: **generate a roads-only
PMTiles for Massachusetts and measure it** (§8.2). It settles the only number
this plan is still guessing at.
