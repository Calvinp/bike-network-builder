#!/usr/bin/env python3
"""Precompute the city boundary POLYGON ring for the static web editor.

The Python tools assemble Malden's polygon from raw boundary ways with
shapely's polygonize at runtime. The browser port has no shapely, and the
boundary never changes — so this script runs the same build_polygon() once
and writes the resulting exterior ring to web/data/malden_boundary_polygon.json
as [[lat, lon], ...]. Re-run it if data/malden_boundary.geojson ever changes
(a test compares the two).

    python tools/export_boundary_polygon.py
"""
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bikenetwork.boundary import build_polygon  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def exterior_ring_latlon():
    fc = json.loads((ROOT / "data" / "malden_boundary.geojson")
                    .read_text(encoding="utf-8"))
    rings = []
    for feat in fc.get("features", []):
        coords = feat.get("geometry", {}).get("coordinates", [])
        ring = [(lat, lon) for lon, lat in coords]
        if len(ring) >= 2:
            rings.append(ring)
    poly = build_polygon(rings)
    # shapely rings are (x=lon, y=lat) and closed (first == last point).
    return [[lat, lon] for lon, lat in poly.exterior.coords]


if __name__ == "__main__":
    ring = exterior_ring_latlon()
    out = ROOT / "web" / "data" / "malden_boundary_polygon.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(ring), encoding="utf-8")
    print(f"wrote {out} ({len(ring)} points)")
