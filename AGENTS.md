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

`network.yaml` holds city metadata, phases, and EVERY path (existing / funded / proposed)
with `type`, `phase`, and full `[lat, lon]` geometry. Spec: `NETWORK_FORMAT.md`.
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
editor.py                   Flask backend (state/save/import/export/snap/regenerate)
build.py                    CLI seed: corridors.yaml + OSM -> output/network.yaml + maps
network.yaml                EDITABLE SOURCE OF TRUTH for the editor
corridors.yaml              seed network (street names, no geometry)
NETWORK_FORMAT.md           the shared format spec (canonical copy)
editor/                     index.html, app.js, style.css, help.md (Leaflet + Geoman)
data/                       malden_boundary / existing_infra / committed_infra .geojson,
                            osm_cache.json, base_network.yaml (fresh-user start),
                            street_graph.json (TRACKED here: the snap-to-road asset the
                            static web port ships; it doubles as the local snap cache)
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
- Help page at /help renders `editor/help.md`.

## Current state (2026-07)

**Done:** everything above; 94 offline pytest tests green; the Overpass User-Agent uses
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
  (render_all equivalent), `render_common.js` (the ONE palette copy on the JS side).
- `web/app.js` is `editor/app.js` with the fetch() calls swapped for Store/export calls;
  keep the two in step when editing UI behavior.
- js-yaml is vendored as an ES module (`web/vendor/js-yaml.mjs`) — works in browser AND
  `node --test`. Leaflet/Geoman stay on CDN like the desktop editor.
- Boundary clipping needs no shapely: `tools/export_boundary_polygon.py` precomputes the
  city polygon ring to `web/data/malden_boundary_polygon.json` (a test fails if stale).
- `web/data/` holds byte-identical copies of the data assets (test-enforced; identical
  blobs are free in git). The street graph (~4 MB) is fetched lazily on first snap.
- **Tests:** `cd web && node --test` — 75 offline tests mirroring the pytest suite.
  Serialization parity is real: Python parses JS-written YAML with zero errors and
  identical fields/geometry; clip/summarize totals match Python to 4 decimals on the
  full network.

**Deferred:** PyInstaller `.exe` packaging of `build.py` hasn't been redone since the split.
