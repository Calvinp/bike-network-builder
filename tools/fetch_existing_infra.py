#!/usr/bin/env python3
"""Pull existing bike infrastructure from OpenStreetMap into a network file.

    python tools/fetch_existing_infra.py -o networks/malden-existing.yaml

Bootstrapping a new area is the hardest part of starting: you have to draw
what's already on the ground before you can propose anything. This fetches the
cycleways and paths OSM already knows about inside the deployment's boundary
and writes them as a normal v2 network file with `status: existing`.

## This is a BATCH tool, on purpose

**The browser never calls a public Overpass instance** (V2_PLAN.md 8.5). A
national tool making live Overpass queries from thousands of browsers is an
abuse of a donated public resource. Overpass work happens here and in
fetch_layers.py, where volume is bounded, the existing throttle and cache
apply, and a human is present.

## Nothing is imported blind

The output is a file you IMPORT, and the import sheet shows every candidate
with a checkbox before anything enters your network. That matters: OSM's idea
of a bike lane is not always yours. A painted strip between a bus lane and a
traffic lane is tagged `cycleway=lane` and is not a facility anyone would call
protected. You see it, you untick it, it never lands.

Every feature carries `tags: {source: osm}`, so the import sheet can open the
review list automatically and OSM-derived content stays identifiable later.

## Licence

OSM is ODbL. Extracting geometry into a file you then share makes a derivative
database, which carries share-alike and attribution (V2_PLAN.md 8.6). The
output declares `license: ODbL-1.0` and credits OpenStreetMap in `meta`. That
is the honest default and it is aligned with what this project wants anyway: a
community-built network map that stays open to the community that built it.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bikenetwork.boundary import point_in_boundary  # noqa: E402
from bikenetwork.network_format import (  # noqa: E402
    Area, Authority, Feature, Network, Treatment, serialize_network,
    validate_network,
)
from bikenetwork.osm import OverpassClient  # noqa: E402
from bikenetwork.place import load_place  # noqa: E402

# What OSM tagging maps onto which treatment. Deliberately CONSERVATIVE: an
# unprotected painted lane is recorded as `buffered_painted`, never as
# anything "separated", because calling paint protection is how a map starts
# lying about what exists.
# NOTE: `cycleway=track` means "physically separated" in OSM and says NOTHING
# about what separates it. It used to arrive as `concrete_separated`, which
# invents a curb that may be a line of flex posts — the same over-claiming this
# table exists to avoid, just pointed the other way.
TAG_RULES = [
    # (predicate over tags, treatment id)
    (lambda t: t.get("highway") == "cycleway", "shared_use_path"),
    (lambda t: t.get("highway") == "path" and t.get("bicycle") == "designated",
     "shared_use_path"),
    (lambda t: t.get("cycleway") == "track"
     or t.get("cycleway:left") == "track" or t.get("cycleway:right") == "track",
     "quick_build_separated"),
    (lambda t: t.get("cycleway") in ("lane", "opposite_lane")
     or t.get("cycleway:left") == "lane" or t.get("cycleway:right") == "lane",
     "buffered_painted"),
    # Spot improvements. Opt-in in the browser, always fetched here — a batch
    # run has nobody waiting on it and no review list to swamp.
    (lambda t: t.get("amenity") == "bicycle_parking", "bike_parking"),
    (lambda t: t.get("amenity") == "bicycle_rental", "bikeshare_dock"),
    (lambda t: t.get("traffic_calming") == "table", "raised_crosswalk"),
    (lambda t: t.get("traffic_calming") in ("hump", "bump", "cushion"),
     "speed_hump"),
    (lambda t: t.get("barrier") == "bollard", "bollards"),
    (lambda t: t.get("natural") == "tree_row", "street_trees"),
    (lambda t: t.get("highway") == "crossing"
     and t.get("crossing:island") == "yes", "pedestrian_island"),
]

PATH_CLAUSES = [
    'way["highway"="cycleway"]',
    'way["highway"="path"]["bicycle"="designated"]',
    'way["cycleway"~"lane|track|opposite_lane"]',
    'way["cycleway:left"~"lane|track"]',
    'way["cycleway:right"~"lane|track"]',
]
SPOT_CLAUSES = [
    'node["amenity"~"^(bicycle_parking|bicycle_rental)$"]',
    'node["traffic_calming"~"hump|bump|table|cushion"]',
    'node["barrier"="bollard"]',
    'node["highway"="crossing"]["crossing:island"="yes"]',
    'way["natural"="tree_row"]',
]

QUERY = "[out:json][timeout:90];\n(\n" + "\n".join(
    f"  {c}({{bbox}});" for c in PATH_CLAUSES + SPOT_CLAUSES) + "\n);\nout geom;"


def treatment_for(tags: dict) -> str | None:
    for predicate, treatment in TAG_RULES:
        if predicate(tags):
            return treatment
    return None


def features_from_osm(result: dict, boundary, place_name: str):
    """OSM ways -> v2 Features with status: existing, clipped to the area."""
    features = []
    for i, el in enumerate(result.get("elements", []), start=1):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        pts = [(float(g["lat"]), float(g["lon"])) for g in geom
               if "lat" in g and "lon" in g]
        if len(pts) < 2:
            continue
        # Keep a way with any part inside; the app clips properly on import.
        if boundary and not any(point_in_boundary(lat, lon, boundary)
                                for lat, lon in pts):
            continue
        tags = el.get("tags") or {}
        treatment = treatment_for(tags)
        if treatment is None:
            continue
        name = tags.get("name") or tags.get("ref") or f"Unnamed path {i}"
        features.append(Feature(
            id=f"osm-w{el.get('id', i)}",
            name=name,
            on_street=tags.get("name", ""),
            notes=tags.get("description", ""),
            treatments=[Treatment(
                id=f"osm-t{el.get('id', i)}",
                type=treatment,
                status="existing",
                # Recorded so OSM-derived content stays identifiable — for the
                # review list, and for the licence question later.
                tags={"source": "osm", "osm_way": str(el.get("id", ""))},
            )],
            geometry=[pts],
            tags={"source": "osm"},
        ))
    return features


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", type=Path,
                    default=ROOT / "networks" / "existing-infra.yaml",
                    help="where to write the network file")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be fetched, without contacting OSM")
    args = ap.parse_args(argv)

    place = load_place(ROOT)
    bbox = place.bbox()
    if bbox is None:
        raise SystemExit("no boundary to search within — check the 'boundary' "
                         "asset in data/place.json")
    boundary = place.boundary()

    print(f"Area: {place.display_name}")
    print(f"Bounding box: {', '.join(f'{v:.4f}' for v in bbox)}")
    if args.dry_run:
        print("--dry-run: not contacting OpenStreetMap.")
        return 0

    client = OverpassClient(bbox=bbox)
    result = client.query(QUERY.format(bbox=",".join(str(v) for v in bbox)))
    features = features_from_osm(result, boundary, place.name)

    net = Network(
        areas=[Area(id=place.id or f"area-{place.name.lower()}", name=place.name,
                    context=place.context,
                    default_authority=place.default_authority,
                    boundary=boundary)],
        authorities=[Authority(id=a.get("id", ""), name=a.get("name", ""),
                               level=a.get("level", "municipal"))
                     for a in place.authorities],
        phases=[],
        features=features,
        meta={
            "title": f"{place.display_name} — existing bike infrastructure",
            "description": "Pulled from OpenStreetMap. Review before importing: "
                           "OSM's idea of a bike lane may not be yours.",
            # ODbL is share-alike and attribution; see the module docstring.
            "license": "ODbL-1.0",
            "source_url": "https://www.openstreetmap.org/",
            "contributors": [{"name": "OpenStreetMap contributors",
                              "kind": "organization"}],
        },
    )
    errors = validate_network(net)
    if errors:
        print("the assembled network did not validate:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(serialize_network(net), encoding="utf-8")

    by_type: dict = {}
    for f in features:
        by_type[f.treatments[0].type] = by_type.get(f.treatments[0].type, 0) + 1
    print(f"\nWrote {len(features)} candidates to {args.out}:")
    for treatment, n in sorted(by_type.items()):
        print(f"  {n:4d}  {treatment}")
    print("\nImport it in the app. Every candidate is listed with a checkbox "
          "before anything\nenters your network — untick what you would not "
          "call existing infrastructure.")
    print("\nThe file is ODbL-1.0 and credits OpenStreetMap contributors; "
          "keep that\nattribution on anything you share or publish from it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
