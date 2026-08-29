#!/usr/bin/env python3
"""Cut a street graph into roads tiles for the web app to fetch on demand.

    python tools/make_road_tiles.py data/street_graph.json web/data/tiles/roads

Snapping cannot ship as one bundled asset: Malden is 3.9 MB for 5.1 sq mi
(~0.77 MB per square mile), so Boston metro would be ~3.6 GB and the US ~3 TB
(V2_PLAN.md 8.1). But snapping only ever needs the streets around the click, so
the graph is served as TILES and the app merges the ones it needs.

Tiles are STATIC FILES. That is the whole point: static files cannot be DDoSed
by our own users the way a query API can, because there is no query — just
cacheable bytes with a flat cost curve. **The browser never calls a public
Overpass instance** (V2_PLAN.md 8.5); Overpass stays a batch tool, here and in
fetch_layers.py, where volume is bounded and a human is present.

Each tile is the same {"coord": ..., "adj": ...} shape as street_graph.json, so
the app needs no new decoder. A node goes in the tile containing it, and an
edge is written into BOTH endpoints' tiles — that overlap is what lets a route
cross a tile boundary once the app merges them.

Point this at a graph for any area. To build one for somewhere new, fetch it
once with build.py/osm.py (batch, throttled, with a reachable contact), then
cut it here.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path


def tile_for(lat: float, lon: float, z: int):
    """The standard slippy-map XYZ tile containing a point."""
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi)
            / 2.0 * n)
    return (max(0, min(n - 1, x)), max(0, min(n - 1, y)))


def cut(graph: dict, zoom: int):
    """{(x, y): {"coord": {...}, "adj": {...}}} for one graph."""
    coord = graph["coord"]
    adj = graph["adj"]
    home = {nid: tile_for(float(p[0]), float(p[1]), zoom) for nid, p in coord.items()}

    tiles = defaultdict(lambda: {"coord": {}, "adj": defaultdict(list)})
    for nid, tile in home.items():
        tiles[tile]["coord"][nid] = coord[nid]

    for a, nbrs in adj.items():
        for b, w in nbrs:
            b = str(b)
            ta, tb = home.get(a), home.get(b)
            if ta is None or tb is None:
                continue
            # Both endpoints, so the edge exists in each tile it touches and a
            # merged pair of tiles is connected across their shared border.
            for tile in {ta, tb}:
                t = tiles[tile]
                t["coord"].setdefault(a, coord[a])
                t["coord"].setdefault(b, coord[b])
                t["adj"][a].append([int(b), w])
    return tiles


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("graph", type=Path, help="a street_graph.json")
    ap.add_argument("out", type=Path, help="output directory for {z}/{x}/{y}.json")
    ap.add_argument("-z", "--zoom", type=int, default=14,
                    help="tile zoom (default: 14, ~2 km across at this latitude)")
    args = ap.parse_args(argv)

    graph = json.loads(args.graph.read_text(encoding="utf-8"))
    tiles = cut(graph, args.zoom)

    total = 0
    for (x, y), data in tiles.items():
        path = args.out / str(args.zoom) / str(x) / f"{y}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"coord": data["coord"], "adj": dict(data["adj"])}
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        total += path.stat().st_size

    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB total, "
          f"{total / max(len(tiles), 1) / 1e3:.0f} KB average")
    print(f"Point a deployment at them with, in data/place.json:\n"
          f'  "assets": {{ "street_tiles": "data/tiles/roads/{{z}}/{{x}}/{{y}}.json" }},\n'
          f'  "tile_zoom": {args.zoom}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
