"""Convert between BikePath lists and GeoJSON FeatureCollections.

network.yaml is the source of truth on disk; GeoJSON is (a) the wire format
between editor.py and the browser (Leaflet speaks it natively) and (b) an
export format for tools like geojson.io. Geometry always travels WITH its
path — nothing here is keyed by name, so duplicate names are harmless.
Single-segment paths are LineStrings; combined paths are MultiLineStrings.
"""
from __future__ import annotations

from typing import List

from .geometry import segments_miles
from .network_format import BikePath


def _geojson_geometry(segments) -> dict:
    coords = [[[lon, lat] for (lat, lon) in seg] for seg in segments]
    if len(coords) == 1:
        return {"type": "LineString", "coordinates": coords[0]}
    return {"type": "MultiLineString", "coordinates": coords}


def _segments_from_geometry(geom: dict) -> List[list]:
    gtype = (geom or {}).get("type")
    coords = (geom or {}).get("coordinates") or []
    if gtype == "MultiLineString":
        seg_lists = coords
    elif gtype == "LineString":
        seg_lists = [coords]
    else:
        return []
    segments = []
    for seg in seg_lists:
        pts = [(lat, lon) for lon, lat in seg]
        if len(pts) >= 2:
            segments.append(pts)
    return segments


def paths_to_geojson(paths: List[BikePath]) -> dict:
    """Build a GeoJSON FeatureCollection (one feature per path)."""
    features = []
    for p in paths:
        segments = [s for s in p.segments if len(s) >= 2]
        if not segments:
            continue
        features.append({
            "type": "Feature",
            "geometry": _geojson_geometry(segments),
            "properties": {
                "name": p.name,
                "type": p.type,
                "status": p.status,
                "jurisdiction": p.jurisdiction,
                "id": p.id,
                "upgrades": p.upgrades,
                "phase": p.phase,
                "directions": p.directions,
                "on_street": p.on_street,
                "from": p.frm,
                "to": p.to,
                "notes": p.notes,
                "miles": round(p.length_miles or segments_miles(segments), 4),
            },
        })
    return {"type": "FeatureCollection", "features": features}


def paths_from_geojson(fc: dict) -> List[BikePath]:
    """Build BikePath objects from a FeatureCollection whose features carry the
    full property set (the editor's save payload). LineString and
    MultiLineString both work; features with no usable segment are skipped."""
    paths: List[BikePath] = []
    for i, feat in enumerate(fc.get("features", [])):
        props = feat.get("properties") or {}
        segments = _segments_from_geometry(feat.get("geometry"))
        if not segments:
            continue
        try:
            phase = int(props.get("phase")) if props.get("phase") is not None else None
        except (TypeError, ValueError):
            phase = None
        try:
            directions = int(props.get("directions", 2) or 2)
        except (TypeError, ValueError):
            directions = 2
        p = BikePath(
            name=str(props.get("name") or f"Path {i + 1}"),
            # `treatment` is the pre-split property name; accept it on read.
            type=str(props.get("type") or props.get("treatment")
                     or "quick_build_separated"),
            status=str(props.get("status", "proposed") or "proposed"),
            jurisdiction=str(props.get("jurisdiction", "city") or "city"),
            id=str(props.get("id", "") or "").strip(),
            upgrades=str(props.get("upgrades", "") or "").strip(),
            phase=phase,
            directions=directions,
            on_street=str(props.get("on_street", "") or ""),
            frm=str(props.get("from", "") or ""),
            to=str(props.get("to", "") or ""),
            notes=str(props.get("notes", "") or ""),
            segments=segments,
        )
        p.length_miles = segments_miles(segments)
        paths.append(p)
    return paths
