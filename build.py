#!/usr/bin/env python3
"""Build (seed) the bike network from corridors.yaml + OpenStreetMap.

    python build.py                 # build using cached OSM geometry (offline OK)
    python build.py --refresh       # re-fetch geometry from OpenStreetMap
    python build.py --offline       # never hit the network; fail if cache misses

Outputs:
    output/network.yaml       the network in the portable YAML format (the
                              editor seeds itself from this)
    output/map.png            geographic network map
    output/map.html           interactive Leaflet map
    output/network.geojson    exact geometry (for review / geojson.io)

This is the bootstrap path: it resolves street-name corridors to real geometry
via OSM. Day-to-day editing happens in the web editor (`python editor.py`),
which owns `network.yaml` once it exists.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from bikenetwork.boundary import build_polygon
from bikenetwork.geometry import segments_miles
from bikenetwork.model import parse_seed, validate_seed
from bikenetwork.network_format import BikePath, serialize_network
from bikenetwork.osm import resolve_network
from bikenetwork.pipeline import render_all
from bikenetwork.render_map import COLOR_MODES

# When packaged with PyInstaller (--onefile), the editable data files live
# NEXT TO the .exe (so users can edit them), not inside the frozen bundle.
if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUTPUT = ROOT / "output"
CACHE = DATA / "osm_cache.json"
EXISTING_INFRA = DATA / "existing_infra.geojson"
COMMITTED_INFRA = DATA / "committed_infra.geojson"
BOUNDARY = DATA / "malden_boundary.geojson"


def load_boundary(path: Path):
    """Load the city boundary as a list of polylines [(lat, lon), ...]."""
    if not path.exists():
        return None
    fc = json.loads(path.read_text(encoding="utf-8"))
    rings = []
    for feat in fc.get("features", []):
        coords = feat.get("geometry", {}).get("coordinates", [])
        ring = [(lat, lon) for lon, lat in coords]
        if len(ring) >= 2:
            rings.append(ring)
    return rings or None


def load_infra(path: Path, default_status: str):
    """Load infrastructure features (geometry preset) as BikePath objects.

    Used for both EXISTING facilities (Northern Strand) and COMMITTED/approved
    ones (Spot Pond Brook Greenway). Each feature's `status` property wins;
    `default_status` ('existing' or 'funded') applies when absent. Same-named
    features (a trail split by street crossings) merge into ONE multi-segment
    path, so the whole trail is a single clean entry."""
    grouped: dict = {}
    if not path.exists():
        return []
    fc = json.loads(path.read_text(encoding="utf-8"))
    for feat in fc.get("features", []):
        props = feat.get("properties", {})
        coords = feat.get("geometry", {}).get("coordinates", [])
        pts = [(lat, lon) for lon, lat in coords]  # GeoJSON is [lon,lat]
        if len(pts) < 2:
            continue
        name = props.get("name", "Facility")
        p = grouped.get(name)
        if p is None:
            p = grouped[name] = BikePath(
                name=name, on_street=name,
                type=props.get("type", props.get("treatment", "shared_use_path")),
                status=props.get("status", default_status),
                notes=props.get("note", ""), phase=None, segments=[])
        p.segments.append(pts)
    for p in grouped.values():
        p.length_miles = segments_miles(p.segments)
    return list(grouped.values())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch all corridor geometry from OpenStreetMap")
    ap.add_argument("--offline", action="store_true",
                    help="use only cached geometry; do not contact the network")
    ap.add_argument("--color-mode", choices=COLOR_MODES, default="type",
                    help="map color coding: by phase (default), by path type, "
                         "or the whole network in a single color")
    args = ap.parse_args(argv)

    net = parse_seed((ROOT / "corridors.yaml").read_text(encoding="utf-8"))
    errors = validate_seed(net)
    if errors:
        print("corridors.yaml has validation errors:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    # Build the city polygon first so corridor resolution can prefer in-Malden
    # intersections (avoids locking onto a same-named junction in Melrose/Everett).
    boundary = load_boundary(BOUNDARY)
    polygon = build_polygon(boundary) if boundary else None
    inside = None
    if polygon is not None:
        from shapely.geometry import Point
        buffered = polygon.buffer(0.0015)  # ~165 m tolerance for true border crossings
        inside = lambda lat, lon: buffered.contains(Point(lon, lat))  # noqa: E731

    client = None
    if args.offline:
        # A no-op client whose network methods are never reached because every
        # entry should be cached; if not, resolve_network records a warning.
        class _Offline:
            def __getattr__(self, _):
                raise RuntimeError("offline mode: geometry not in cache. Run once online "
                                   "or with --refresh to populate data/osm_cache.json.")
        client = _Offline()

    resolved, warnings, notices = resolve_network(net.paths, CACHE, refresh=args.refresh,
                                                  client=client, inside=inside)

    # Attach geometry to each corridor; drop the ones that didn't resolve
    # (resolve_network already recorded a warning for them).
    NEAR_ZERO = 0.03  # miles (~150 ft)
    kept = []
    for c in net.paths:
        entry = resolved.get(c.name)
        if not entry:
            continue
        c.segments = [[tuple(p) for p in entry["geometry"]]]
        c.length_miles = entry["miles"]
        # Flag degenerate corridors (endpoints resolve to ~the same point). They
        # build fine but contribute ~0 miles — usually a repointed segment.
        if c.length_miles < NEAR_ZERO:
            warnings.append(
                f"{c.name}: resolved length is only {c.length_miles:.3f} mi — its two "
                f"endpoints are nearly the same point. Repoint one endpoint."
            )
        kept.append(c)

    # Existing + committed infrastructure (geometry preloaded from GeoJSON).
    net.paths = (kept + load_infra(EXISTING_INFRA, "existing")
                 + load_infra(COMMITTED_INFRA, "funded"))

    # Write the shared-format YAML (the editor seeds its own copy from this).
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "network.yaml").write_text(serialize_network(net), encoding="utf-8")

    # Clip, write GeoJSON, render maps (shared with the editor).
    summary = render_all(net, boundary, OUTPUT, basemap=not args.offline,
                         color_mode=args.color_mode,
                         warnings=warnings, notices=notices)
    warnings, notices = summary["warnings"], summary["notices"]

    # --- Report ------------------------------------------------------------
    print(f"Build network (city mandate): {summary['total_build_miles']:.2f} corridor-miles "
          f"({summary['total_lane_miles']:.1f} bike-lane-mi) across {len(summary['phases'])} phases.")
    if summary["state_miles"] > 0:
        print(f"State (MassDOT) corridors to request: {summary['state_miles']:.2f} corridor-miles.")
    if summary["committed_miles"] > 0:
        print(f"Committed / approved (not yet built): {summary['committed_miles']:.2f} miles.")
    print(f"Existing infrastructure shown: {summary['existing_miles']:.2f} miles.")
    if warnings:
        print(f"\n{len(warnings)} corridor(s) did not resolve and were skipped:")
        for w in warnings:
            print(f"  ! {w}")
        print("Fix the street/intersection names in corridors.yaml and re-run "
              "(use --refresh to retry the network).")
    if notices:
        print(f"\n{len(notices)} corridor(s) clipped to the city boundary (this is "
              f"normal for border streets — only the in-city portion is counted):")
        for n in notices:
            print(f"  - {n}")
    print("\nWrote: output/network.yaml, output/map.png, output/map.html, "
          "output/network.geojson")
    print("Open the editor (python editor.py) to refine the network by hand.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
