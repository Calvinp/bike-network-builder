# Bike Network Builder

A web app for designing a protected-bike-lane network for Malden, MA — draw
paths on a real map, phase them, and export shareable maps and a portable
`network.yaml` file. Built for **Malden Safe Streets (MSS)**, and meant to be
something the public can eventually play with on the MSS website.

The exported `network.yaml` (format: [NETWORK_FORMAT.md](NETWORK_FORMAT.md))
is a portable, human-readable file: share it, keep versions of it, or import
someone else's and build on their plan. The format is deliberately simple so
other software can read it too.

The tool is a fully **static browser app** (`web/`) — no server, no build step,
no account. It runs from any static host and is what's embedded on the MSS
website. Alongside it, `build.py` is a headless path into the same file format,
for scripts and agents.

## Quick start

```bash
cd web && python serve.py            # --no-browser to skip opening a tab
```

That's the whole app — nothing needs installing, and it opens at
http://127.0.0.1:8613. For the Python side (the headless build path, the
reference validator, and the tests):

```bash
python -m venv .venv && .venv\Scripts\activate     # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt                    # PyYAML + requests + pytest
python -m pytest -q                                # offline + deterministic
python build.py --offline -o out.yaml              # build from the OSM cache
```

## The editor

- **Click a line** to edit every field in the side panel — name, on-street,
  from/to, phase, **type** (quick-build / concrete / shared-use path / buffered
  painted), **status** (proposed / funded / existing), **jurisdiction**
  (city / state), directions, notes.
- **+ Add path** / **+ Add existing path** — draw a new line on the map.
- **Snap to roads** (checkbox, on by default) — a drawn path follows real
  streets between your clicks and ends at the city limit. The first snap
  fetches Malden's street network from OpenStreetMap and caches it to
  `data/street_graph.json`; after that it's instant. The **Snap to roads**
  button in the panel re-snaps a selected path after you've dragged it.
- **Edit shapes** — drag vertices to reshape any line.
- **Color by** — how the network is color-coded, on screen **and** in exported
  maps: by **phase** (the default), by **path type**, or the whole network in
  **one color**. The palette is colorblind-safe (Okabe-Ito).
- **Export** (menu) —
  - **Everything (.zip)** — one download containing all of the below.
  - **Network file (.yaml)** — the whole network in the portable format:
    share it, keep versions of it, or import it back later.
  - **Map image (.png)** — a ~3000 px print-quality map with a street basemap,
    route-name labels, legend, scale bar, and boundary.
  - **Interactive map (.html)** — a Leaflet map you can send to anyone.
  - **GeoJSON** — exact geometry for GIS tools / geojson.io.
  Map exports are regenerated with the current color mode, then downloaded.
- **Import** — load a network.yaml (or an exported .zip) someone else
  designed. The file is validated first and errors are reported plainly.
- **Phases & dates** — edit phase labels and deadlines.
- Live totals update as you edit: corridor-miles, bicycle-lane-miles,
  state-road miles, and a planning-grade **cost estimate** (city builds and
  MassDOT requests separately; rates in `web/js/costs.js`). Paths still
  carrying a default name get a warning chip that jumps you to them.
- **Help** (header link) renders `web/help.md` — the single copy of the user
  manual. Edit that file to change it.
- Works on phones: the layout stacks (map above the cards) below ~760 px.

**Where "here" comes from.** Nothing in the code names a city. `data/place.json`
declares the deployment's default area — its name, boundary, street graph, map
layers, road authorities and opening map view — and everything follows from it.
Point it somewhere else, drop in that town's boundary GeoJSON, and the whole
tool moves. A first-time user starts from whatever seed network that place
configures (for this deployment: Malden's existing + funded infrastructure).

There is no Save button: the app **autosaves** to your browser's local storage
about a second after every edit, and flushes once more when the tab closes — a
crash or power loss costs at most a moment of work. Editing is instant (all
client-side); PNG export takes a few seconds (it fetches map tiles). Needs
internet for the basemap and CDN libraries.

## Seeding a network from street names (`build.py`)

The original bootstrap path, useful for starting a network without drawing:
list corridors by their cross-street endpoints in `corridors.yaml` and run

```bash
python build.py                     # cached OSM geometry; offline OK
python build.py --refresh           # re-resolve geometry from OpenStreetMap
python build.py --offline           # never touch the network
python build.py -o somewhere.yaml   # default: output/network.yaml
```

It resolves real geometry from OpenStreetMap (cached in `data/osm_cache.json`),
merges the existing/committed infrastructure from `data/*.geojson`, and writes
one network file. Open or import it in the app to draw, phase and export —
build.py renders nothing itself, and reports no mileage, because lengths are
derived and boundary-clipped by whoever consumes the file.

Because it turns a written description of a corridor into real geometry, it is
also the most convenient entry point for scripts and agents.

Rules for `corridors.yaml` (validated, with clear errors): `from`/`to` must be
precise intersections **on** `on_street` ("Main Street & Salem Street", never
"Malden Center"), and names must be unique. When the same street names cross
in the area and a neighbour (Melrose/Everett), the resolver picks the in-area
node; border-only crossings are kept and flagged.

## Refreshing the map layers (`fetch_layers.py`)

The "Map layers" card shows reference data under your network — existing bike
parking and street trees (OpenStreetMap), and bike/pedestrian crash locations
(MassDOT). The files live in `data/layers/` and are checked in, so nobody
needs network access to use them. To refresh:

```bash
python fetch_layers.py                 # everything
python fetch_layers.py --skip-crashes  # just the OpenStreetMap layers
```

Each layer degrades on its own: if a source is unreachable the previously
checked-in file is kept and the script explains how to export that dataset by
hand. Adding a layer later = drop a `.geojson` in `data/layers/` and add an
entry to `layers.json` — no code change.

## How it works

```
                 ┌─ web/ (Leaflet + Geoman, ES modules, no build step)
network.yaml ────┤     draw / phase / import / export, all in the browser
                 └─► map.png · map.html · network.geojson · phases.gif

corridors.yaml ─► build.py ─► OSM resolve ─► network.yaml
```

Everything the user sees happens in `web/`. `web/js/` mirrors the format and
geometry modules and adds the browser-only pieces: `store.js` (localStorage +
static assets), `render_png.js` (a canvas map renderer), `render_html.js`,
`export.js`, `zip.js`, `gif.js`, and `render_common.js` — the one copy of the
colorblind-safe palette.

`bikenetwork/` is the **headless** side: small, pure, tested, stdlib + PyYAML.

- `network_format.py` — the YAML format: parse / validate / serialize. The
  reference implementation, and a second independent reading of the spec that
  keeps it honest (parity tests pin it against the JS one).
- `geometry.py` — haversine length, bbox, Dijkstra (pure).
- `boundary.py` — assemble an area polygon from raw ways; containment (pure
  Python, no shapely).
- `osm.py` — the **only** networked module: Overpass lookups, throttled + cached.
- `model.py` — parse/validate the `corridors.yaml` seed.

Every path carries its own geometry (nothing is keyed by name), so duplicate
names — six paths all called "New path" — are harmless everywhere.

## Tests

```bash
python -m pytest -q
```

Plus the app's own suite:

```bash
cd web && node --test
```

Written red/green test-first; **both** suites run offline (OSM calls are
stubbed, no test touches the network). The pytest suite also shells out to node
for the Python↔JS parity checks, and skips them if node isn't installed.

## The static web version (`web/`)

`web/` is a complete client-side port of the editor — plain HTML/CSS/JS ES
modules, no build step, no backend. State autosaves to the browser's
localStorage and every export (YAML / GeoJSON / print-quality PNG /
interactive HTML / zip) is generated in the browser. Serve the directory from
any static host, or locally with:

```bash
python web/serve.py          # -> http://127.0.0.1:8613 (opens your browser)
```

(Any static file server works — `file://` does not, because ES modules and
data fetches need HTTP.) Its offline test suite: `cd web && node --test`.
