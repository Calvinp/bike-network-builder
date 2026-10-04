# AGENTS.md — guide for AI agents (and humans) working on bike-network-builder

> **Keep this file current.** When you change the architecture, add a workflow, learn a new
> gotcha, or finish/defer something in "Current state," update AGENTS.md in the same change.
> It is the first thing the next session reads.

## What this is & why it exists

The PUBLIC-FACING tool of **Malden Safe Streets (MSS)**, a nonprofit advocating for safer
cycling/walking/transit in Malden, MA: a web editor for designing a protected-bike-lane
network on a real map — draw/edit paths, phase them, pick a color mode, import/export
`network.yaml`, export PNG/HTML/GeoJSON maps.

This repo was extracted from a private development monorepo in 2026-07; that private
archive holds the pre-split history (the public history starts at the initial release
commit).

## The format (the load-bearing decision)

`network.yaml` holds city metadata, phases, EVERY path (existing / funded / proposed) with
`type`, `phase`, and full `[lat, lon]` geometry, and an optional `spots:` list of point
improvements. Spec: `NETWORK_FORMAT.md`.
Implementation: `bikenetwork/network_format.py` (canonical; `web/js/network_format.js` is
its port — keep them in step). **Treat the format as a stable public contract**: exported
files circulate and get re-imported, and downstream consumers read them, so files written
by older versions must keep parsing, and a change old readers can't understand must bump
`format_version`. Lengths are never stored in the YAML — every consumer measures +
boundary-clips geometry itself, so mileage totals can never disagree with the geometry.
Preserve fields you don't use on round-trip (e.g. `ordinance_chapter` is carried through
untouched and never shown in the UI).

## Quick start

```bash
python -m venv .venv && .venv\Scripts\activate     # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt
python -m pytest -q                # all offline
python editor.py                   # the Flask web editor -> http://127.0.0.1:5000
```

## Two workflows

1. **The web editor (primary).** `python editor.py` serves a Leaflet+Geoman app from
   `editor/`. It edits **`network.yaml`** (repo root — the editable source of truth) via
   **debounced autosave** (~1.2 s after each edit, POST /api/state; `pagehide` sendBeacon
   flush — there are no Save/Regenerate buttons, the UI is built for public users). The
   header Export menu (YAML / PNG / HTML / GeoJSON) calls `bikenetwork/pipeline.render_all()`
   with the current color mode. Import validates the file and shows errors verbatim.
2. **`build.py` + `corridors.yaml` (seed path).** Resolves on-street corridors from
   OpenStreetMap (Overpass) by intersection names, caches to `data/osm_cache.json`, merges
   `data/existing_infra.geojson` + `data/committed_infra.geojson`, writes
   `output/network.yaml` + maps. The editor seeds its `network.yaml` from that output if its
   own file doesn't exist yet.

## Conventions

- **Red/green TDD for build/logic code.** Write a failing test first, watch it fail,
  implement until green, refactor. Pure logic lives in small, testable functions; network/IO
  is isolated behind seams and stubbed in tests. The whole suite runs **offline** — never
  add a test that needs the network. Run `python -m pytest -q`.
- Match the surrounding code's style; comments explain *why*, not *what*.
- Keep the colorblind-safe **Okabe-Ito** palette consistent across the PNG
  (`render_map.py`), the HTML (`render_html.py`), and the editor JS (`editor/app.js`) — the
  color constants exist in all three places on purpose.
- **Geometry travels WITH its path** (`BikePath.geometry`), never in a name-keyed dict.
  Duplicate path names are legal everywhere except the OSM seed.

## Code structure

```
editor.py                   Flask backend (state/save/import/export/snap/regenerate/layers)
build.py                    CLI seed: corridors.yaml + OSM -> output/network.yaml + maps
fetch_layers.py             CLI (networked, untested): refresh data/layers/ reference data
network.yaml                EDITABLE SOURCE OF TRUTH for the editor
corridors.yaml              seed network (street names, no geometry)
NETWORK_FORMAT.md           the shared format spec (canonical copy)
editor/                     index.html, app.js, style.css, help.html (Leaflet + Geoman)
                            — the manual itself is web/help.md, served at /help.md
data/                       malden_boundary / existing_infra / committed_infra .geojson,
                            osm_cache.json, base_network.yaml (fresh-user start),
                            street_graph.json (TRACKED here: the snap-to-road asset the
                            static web port ships; it doubles as the local snap cache)
  layers/                   context layers + layers.json manifest (fetch_layers.py);
                            copied to web/data/layers/ (a test enforces the copies)
bikenetwork/
  network_format.py         SHARED format module (canonical)
  geometry.py               haversine, bbox, Dijkstra, web-mercator (pure)
  osm.py                    ONLY networked module: Overpass client, throttle/cache
  routing.py                snap-to-road (pure)
  boundary.py               city polygon + clipping (shapely)
  geojson.py                BikePath <-> GeoJSON (browser wire format + export)
  render_map.py             matplotlib PNG; COLOR_MODES/palette live here
  render_html.py            folium interactive HTML
  pipeline.py               clip_paths + summarize + render_all (editor AND build.py)
  model.py                  corridors.yaml seed parse/validate
tests/                      incl. test_network_format, test_editor_api (Flask client)
```

## Domain knowledge / gotchas (learned the hard way)

- **OSM for Malden MA needs a bbox**, not `area["name"="Malden"]` (that matches Malden, WA).
  Bbox is in `osm.MALDEN_BBOX`.
- **Intersection resolution prefers the in-Malden node** when the same street names cross in
  both Malden and a neighbor (Melrose/Everett). Border-only crossings are kept, clipped, and
  reported as a *notice* (not dropped).
- **Everything is clipped to the Malden boundary** so mileage/cost only count in-city street.
- **State roads matter a lot.** Route 60 (Pleasant/Centre/Eastern/Salem) and Route 99
  (Broadway) are ~half the draft network. `jurisdiction: state` paths are drawn solid
  magenta in phase mode and excluded from the city cost totals.
- **"Bicycle lane miles"** (each direction counts) = corridor-miles × `directions`
  (default 2). Cost is per corridor-mile. Keep them distinct.
- `phase` is None (omitted in YAML) for `funded`/`existing` paths; required positive for
  `proposed`. Old GeoJSON used phase 0 for these — the parser tolerates it, the editor
  normalizes it.
- Cost rates live in `bikenetwork/costs.py`; the web editor has its own copy
  (`web/js/costs.js`) — keep them in sync when rates change.
- Python here is **3.14**; heavy GIS wheels can be finicky but the current stack installs
  clean. On this machine Python lives at `%LOCALAPPDATA%\Programs\Python\Python314`.
- **multi-segment paths**: one YAML entry = 1+ polyline segments (flat geometry = 1 segment,
  nested = several); Combine… in the editor merges paths; the Northern Strand is one
  31-segment entry.
- **neighborway** is the 5th path type (sky blue, own cost rate).
- One-way paths (`directions: 1`) draw a direction chevron in editor/PNG/HTML — geometry
  point order IS the direction; the Reverse button flips it. Chevrons are rotated dark
  glyphs with a white halo on ALL surfaces (editor/HTML DivIcon = PNG rotated "▶" text with
  a patheffects white stroke — never matplotlib arrow patches, NO leaflet-polylinedecorator,
  NO folium TextPath — the latter crashed map.html at runtime).
- PNG labels place themselves (candidates slide along the route, scored by other paths' ink
  under the box; crowded/downtown labels are dropped, not overlapped) and avoid chevrons.
- `snap_route` measures nearness to road EDGES (not nodes — straight OSM ways have sparse
  vertices) and leaves waypoints >~30 m off-street, so backlot/park/cut-through clicks stay
  free-drawn while street clicks snap.
- GOTCHA: never add decorator/plain LayerGroups to `networkGroup` — FeatureGroup.getBounds()
  throws on layers without getBounds and kills editor init; arrows live in `arrowsGroup`.
- **Basemap = OpenFreeMap "Bright" vector tiles, drawn by MapLibre GL inside Leaflet**
  (maplibre-gl-leaflet plugin) in both editors and both map.html exports. The JS side's
  one setting is `web/js/basemap.js`; `editor/app.js` and `bikenetwork/render_html.py`
  carry copies of the style URL and `web/test/basemap.test.js` keeps them in step.
  - *Why:* in 2026-10 CARTO started answering keyless tile requests with an "API KEY
    REQUIRED" image **with status 200**, so nothing errored, the map just went blank (and
    the PNG exporters happily baked the watermark in). The deployed builder is a static
    site, so a CARTO key could never be kept private there. OpenFreeMap needs no key or
    sign-up and sets no request limits.
  - *MapLibre is pinned to 5.x* — 6.x ships only as an ES module; the plugin needs the
    `maplibregl` global from the 5.x UMD build. Load order: Leaflet, maplibre-gl, plugin.
  - *folium has no vector-tile layer:* render_html.py passes `tiles=None` and injects the
    layer — scripts into the BODY (folium adds leaflet.js to the header at render time,
    after anything we add there) and `addTo(map)` inside DOMContentLoaded (see below).
  - *Being a good citizen / scaling plan* (Calvin's call: start small, grow gracefully):
    1. Now: OpenFreeMap's public instance. It runs on donations — MSS should sponsor it
       (GitHub Sponsors) rather than ration use. Keep the attribution visible.
    2. If the tool grows: self-host a **Malden-only** tile file. Planetiler (OpenMapTiles
       schema, same as Bright expects) can build `--area=massachusetts
       --output=….pmtiles`; cut it to Malden + margin, serve it as a static file beside
       the app, point a copy of the Bright style (plus its fonts/sprites) at it, and set
       `maxBounds` so nobody pans off the edge. Rebuild a few times a year.
    3. If it gets popular: a free CDN in front of that static file.

- **`web/help.md` is the ONE copy of the manual, and it is human-authored (Calvin writes
  it) — do NOT edit it.** It has to live inside `web/` because that folder is vendored into
  the MSS site as a self-contained app; the Flask editor serves that same file at `/help.md`
  rather than keeping a second copy in step. When you add a user-facing feature, list what
  needs covering in your summary instead of writing it yourself.

## Current state (2026-08)

**New in 2026-08** — four features, all backwards compatible (`format_version` stays 1,
every new key is optional and omitted when empty, so files written by older versions
re-save with no value changes and no new keys; `tests/test_network_format.py` pins that
against the checked-in base network):

1. **`pedestrianized`** — 6th path type, Okabe-Ito reddish purple `#CC79A7`. That color is
   deliberately shared with `STATE_COLOR`, which only draws in phase mode where type
   colors never apply — don't "fix" the collision.
2. **Phased upgrades.** Optional `id` + `upgrades` on a path: B `upgrades` A means B
   replaces A in a later phase (quick-build now, concrete rebuild later — also upgrades OF
   existing infra). **The math:** full-buildout mileage counts the corridor ONCE
   (superseded paths excluded, via `superseded_ids()` / `supersededIds()`), while
   per-phase rows and cost include EVERY phase's work — building twice costs twice. The
   editors add "↑ Plan an upgrade" (clones the geometry into the next phase) and a header
   "Show" menu previewing the network as of Today / Phase N / full. That preview is
   **visual only — totals always describe the full plan**, because numbers that shift with
   a view dropdown read as a bug to non-technical users.
   Exports gain cumulative `map-phase-N.png` per phase, `phases.gif`, and a slider in
   `map.html` (hand-injected; no folium time plugins — see the TextPath history above).
3. **Spot infrastructure.** Optional top-level `spots:` (`type` from `SPOT_TYPES`, status
   existing|proposed, `jurisdiction` city|state, optional phase, `location: [lat, lon]`).
   The field is `type` to match paths; `kind` is accepted on read for files written before
   the rename, as `treatment` is for paths. Spots carry no cost today — `jurisdiction` is
   recorded so a future cost model can bill the right body. The wire format is a SEPARATE
   `spots` FeatureCollection so every polyline-only path stays polyline-only. Drawn as
   glyph markers (`SPOT_GLYPHS`, mirrored across render_map.py / render_html.py / editor
   JS / render_common.js) using the white-halo text idiom.
4. **Context layers.** Reference data — NOT part of network.yaml — in
   `data/layers/<id>.geojson` + a `layers.json` manifest, served by `/api/layers` and read
   as a static asset by the web app. The "Map layers" card lazy-fetches on first toggle and
   draws points on a shared `L.canvas`, so layers cost nothing while off and stay smooth
   with ~1300 trees. Shipped: bike-parking + street-trees (OSM), crashes-bike-ped +
   crashes-fatal-serious (MassDOT, 2021 on). Adding a layer later needs no code — drop the
   file in both `data/layers/` and `web/data/layers/`, add a manifest entry.

**Gotchas from that work:**
- **Nothing injected into folium's map.html may touch the map at parse time.**
  `get_root().script` children are emitted BEFORE the `var map_… = L.map(…)`
  assignment, so `map_….on(...)` there throws and takes the whole `<script>`
  block — the map with it — leaving a blank page. Wrap injected code in
  `DOMContentLoaded` (both the phase slider and the chevron-zoom handler do).
  `test_html_never_touches_the_map_before_it_exists` pins this; it is the same
  trap as the TextPath crash, and the chevron handler fell into it once.
- **A replaced path is hidden only while its replacement is actually shown.**
  In map.html that means consulting `map.hasLayer(replacement)` as well as the
  slider position, so unticking the upgrade's phase falls back to the path it
  replaced instead of blanking the corridor; the slider therefore re-asserts
  phase groups on `input` only, never on `overlayadd`/`overlayremove` (which
  would fight the checkbox the reader just clicked).
- **Chevron membership belongs to `syncArrows()` alone** in both editors. Arrows are
  rebuilt on load, on shape edits and on import, so any other place that adds them
  resurrects a replaced path's chevron; and `init()` must call `applyPhaseView()`
  itself, or the first paint ignores upgrades until the Show menu is touched (that
  shipped once — the fix lived only in the menu handler). `web/test/app_structure.
  test.js` guards both, plus the legend rebuild, since app.js has no DOM harness.
- **A superseded path draws no one-way chevron** when its replacement is on the
  same map: the upgrade covers the old line exactly, so only the stale arrow
  would show, claiming the new lane is one-way.
- `fetch_layers.py` derives its bbox from `data/malden_boundary.geojson` (not
  `osm.MALDEN_BBOX`) so another city needs no code change, and it renames raw fields to
  plain language AT FETCH TIME — MassDOT's `NON_MTRST_TYPE_CL`, epoch-ms dates and KABCO
  codes mean nothing to a resident, and popups show property names verbatim. The
  serious-injury signal is in `MAX_INJR_SVRTY_CL`, NOT `CRASH_SEVERITY_DESCR` (which only
  says fatal / non-fatal / property damage).
- Animation frames must be pixel-stable: `render_map.render_map(tight=False)` uses a fixed
  canvas AND fixed axes box (tight_layout resizes the axes around whatever decorations a
  frame happens to have), and captions are padded to a constant line count.
- `web/js/gif.js` is a small GIF89a+LZW encoder (the web app has no Pillow). Two traps it
  already fell into: never spread a frame's bytes into `Array.push` (argument limit), and
  median cut allocates palette slots by area — a pale basemap will crowd the network's own
  colors out unless `reserved` is passed (export.js passes `MAP_PALETTE`).

## Current state (2026-07)

**Done:** everything above; 141 offline pytest tests green; the Overpass User-Agent uses
the MSS contact address (keep it that way — Overpass etiquette wants a reachable contact).

**Done (2026-07): the static client-side port** — `web/` is a complete, framework-free
port of the editor that runs with no server (vendored into the MSS Astro website at
maldensafestreets.org; also servable from any static host). Key facts:

- ES modules under `web/js/` mirror `bikenetwork/` module-for-module (network_format,
  geometry, boundary, geojson, costs, pipeline, routing) plus web-only pieces: `store.js`
  (localStorage persistence + asset fetching — the Flask API equivalent), `zip.js`
  (dependency-free zip read/write on native (De)CompressionStream), `render_html.js`
  (standalone map.html string), `render_png.js` (canvas port of render_map: CARTO tiles
  drawn with CORS, label auto-placement, chevrons, legend/scale/north), `export.js`
  (render_all equivalent), `render_common.js` (the ONE palette copy on the JS side),
  `basemap.js` (the ONE basemap setting — see "Basemap" under gotchas).
- `web/app.js` is `editor/app.js` with the fetch() calls swapped for Store/export calls;
  keep the two in step when editing UI behavior.
- js-yaml is vendored as an ES module (`web/vendor/js-yaml.mjs`) — works in browser AND
  `node --test`. Leaflet/Geoman stay on CDN like the desktop editor.
- Boundary clipping needs no shapely: `tools/export_boundary_polygon.py` precomputes the
  city polygon ring to `web/data/malden_boundary_polygon.json` (a test fails if stale).
- `web/data/` holds byte-identical copies of the data assets (test-enforced; identical
  blobs are free in git). The street graph (~4 MB) is fetched lazily on first snap.
- `web/serve.py` serves with **caching disabled** on purpose. Browsers cache ES
  modules hard, and a plain reload revalidates the HTML but not always its module
  graph — so after an edit the page can keep running the previous `app.js` and look
  like it ignored the change. If you serve `web/` some other way, disable caching
  there too or you will chase ghosts.
- **Tests:** `cd web && node --test` — 121 offline tests mirroring the pytest suite.
  Serialization parity is real: Python parses JS-written YAML with zero errors and
  identical fields/geometry; clip/summarize totals match Python to 4 decimals on the
  full network.

**Deferred:** PyInstaller `.exe` packaging of `build.py` hasn't been redone since the split.
