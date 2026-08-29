#!/usr/bin/env python3
"""Build a network file from corridors.yaml + OpenStreetMap.

    python build.py                 # build using cached OSM geometry (offline OK)
    python build.py --refresh       # re-fetch geometry from OpenStreetMap
    python build.py --offline       # never hit the network; fail if cache misses
    python build.py -o out.yaml     # write somewhere other than output/network.yaml

Output: one `network.yaml` in the portable format. Nothing else — rendering
lives in the web app, which is the only editor.

This is the HEADLESS path into the format: describe corridors in words
("Main Street, from Salem to Pleasant") and get real geometry back. That makes
it the natural entry point for scripts and for agents, which is why it survived
the retirement of the Python editor. Open the result in the web app (or import
it there) to draw, phase and export.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from bikenetwork.boundary import near_boundary
from bikenetwork.model import parse_seed, seed_to_network, validate_seed
from bikenetwork.network_format import serialize_network, validate_network
from bikenetwork.osm import resolve_network
from bikenetwork.place import load_place

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


def load_infra(path: Path, default_status: str) -> list:
    """Load infrastructure with preset geometry from GeoJSON, as v1-shaped
    path mappings (they go through the same upgrade as everything else).

    Used for both EXISTING facilities (Northern Strand) and COMMITTED/approved
    ones (Spot Pond Brook Greenway). Each feature's `status` property wins;
    `default_status` applies when absent. Same-named features — a trail split
    by street crossings — merge into ONE multi-part path, so the whole trail
    stays a single clean entry.
    """
    grouped: dict = {}
    if not path.exists():
        return []
    fc = json.loads(path.read_text(encoding="utf-8"))
    for feat in fc.get("features", []):
        props = feat.get("properties", {})
        coords = feat.get("geometry", {}).get("coordinates", [])
        pts = [[lat, lon] for lon, lat in coords]   # GeoJSON is [lon, lat]
        if len(pts) < 2:
            continue
        name = props.get("name", "Facility")
        entry = grouped.get(name)
        if entry is None:
            entry = grouped[name] = {
                "name": name, "on_street": name,
                "type": props.get("type", props.get("treatment", "shared_use_path")),
                "status": props.get("status", default_status),
                "notes": props.get("note", ""),
                "geometry": [],
            }
        entry["geometry"].append(pts)
    return list(grouped.values())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch all corridor geometry from OpenStreetMap")
    ap.add_argument("--offline", action="store_true",
                    help="use only cached geometry; do not contact the network")
    ap.add_argument("-o", "--out", type=Path, default=OUTPUT / "network.yaml",
                    help="where to write the network file "
                         "(default: output/network.yaml)")
    args = ap.parse_args(argv)

    seed = parse_seed((ROOT / "corridors.yaml").read_text(encoding="utf-8"))
    errors = validate_seed(seed)
    if errors:
        print("corridors.yaml has validation errors:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    # Assemble the area polygon first so corridor resolution can prefer an
    # in-area intersection (avoids locking onto a same-named junction in a
    # neighbouring town). BORDER_TOLERANCE is ~165 m, which keeps genuine
    # border crossings in play.
    BORDER_TOLERANCE = 0.0015
    place = load_place(ROOT)
    boundary = place.boundary()
    inside = None
    if boundary:
        def inside(lat, lon):
            return near_boundary(lat, lon, boundary, BORDER_TOLERANCE)

    client = None
    if args.offline:
        # A no-op client whose network methods are never reached because every
        # entry should be cached; if not, resolve_network records a warning.
        class _Offline:
            def __getattr__(self, _):
                raise RuntimeError("offline mode: geometry not in cache. Run once online "
                                   "or with --refresh to populate data/osm_cache.json.")
        client = _Offline()

    requested = len(seed.corridors)
    resolved, warnings, notices = resolve_network(
        seed.corridors, CACHE, refresh=args.refresh, client=client, inside=inside)

    # Attach geometry to each corridor; the ones that didn't resolve are
    # dropped (resolve_network already recorded a warning for them).
    NEAR_ZERO = 0.03  # miles (~150 ft)
    geometry_by_name = {}
    for c in seed.corridors:
        entry = resolved.get(c.name)
        if not entry:
            continue
        geometry_by_name[c.name] = [[tuple(p) for p in entry["geometry"]]]
        # Flag degenerate corridors (endpoints resolve to ~the same point).
        # They build fine but contribute ~0 length — usually a repointed segment.
        if entry["miles"] < NEAR_ZERO:
            warnings.append(
                f"{c.name}: resolved length is only {entry['miles']:.3f} mi — its "
                f"two endpoints are nearly the same point. Repoint one endpoint."
            )

    net = seed_to_network(
        seed, geometry_by_name,
        extra_paths=(load_infra(EXISTING_INFRA, "existing")
                     + load_infra(COMMITTED_INFRA, "funded")))

    problems = validate_network(net)
    if problems:
        print("the assembled network did not validate:", file=sys.stderr)
        for e in problems:
            print(f"  - {e}", file=sys.stderr)
        return 1

    # --- Write ---------------------------------------------------------
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(serialize_network(net), encoding="utf-8")

    # --- Report --------------------------------------------------------
    # Mileage is deliberately NOT summarized here. Lengths are derived, never
    # stored, and every consumer clips to the boundary itself, so the app is
    # the one place that reports totals and it cannot disagree with itself.
    print(f"Resolved {len(geometry_by_name)} of {requested} corridors; "
          f"wrote {len(net.features)} features to {args.out}.")
    if warnings:
        print(f"\n{len(warnings)} corridor(s) did not resolve and were skipped:")
        for w in warnings:
            print(f"  ! {w}")
        print("Fix the street/intersection names in corridors.yaml and re-run "
              "(use --refresh to retry the network).")
    if notices:
        print(f"\n{len(notices)} corridor(s) sit on the area border "
              f"(normal for border streets; the app clips them when counting):")
        for n in notices:
            print(f"  - {n}")
    print("\nOpen or import the file in the web app to draw, phase and export.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
