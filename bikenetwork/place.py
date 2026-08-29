"""The deployment's default area, read from `data/place.json`.

Nothing in the code names a city, a boundary file, or a bounding box. Point
place.json at somewhere else — with its own boundary GeoJSON beside it — and
the whole pipeline follows, no code change. That is the whole of what
"geography-agnostic" means in practice; `tests/test_place.py` pins it with a
town that doesn't exist.

`web/js/place.js` is the browser's reader for the same file (fetched as a
static asset from `web/data/place.json`, which is a byte-identical copy — a
test enforces that, as it does for every other shared asset).

Shape:

    {
      "id":      "census:2510-0038805",     # stable id, for v2 `areas:`
      "name":    "Malden",
      "context": "Massachusetts",           # what to say after the name
      "kind":    "municipality",
      "authorities": [ {id, name, level}, ... ],
      "default_authority": "malden",
      "assets": { "boundary": "data/…", "street_graph": "data/…",
                  "layers": "data/…", "seed_network": "data/…" },
      "map":   { "center": [lat, lon], "zoom": 14 },
      "fetch": { "crash_city_name": "Malden" }   # for fetch_layers.py
    }

Every key except `name` is optional. Asset paths are relative to the repo root
on this side and to `web/` in the browser — the same string works for both,
because `web/data/` mirrors `data/`.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
# Two paddings, because the two uses want opposite things.
#
# OSM street/intersection resolution wants to reach BEYOND the line: a border
# intersection, or a street that only touches the town, still has to resolve.
# 0.009 deg (~1 km) is what the hand-tuned MALDEN_BBOX effectively used on
# every edge, and a test pins that the derived box never gets tighter than it.
#
# Reference layers want the opposite — a tight box, so a tree layer doesn't
# drag in a thousand trees from the next town over.
BBOX_PAD_OSM = 0.009
BBOX_PAD_LAYERS = 0.004

Point = Tuple[float, float]


def bbox_from_ways(ways: Sequence[Sequence[Point]], pad: float = BBOX_PAD_OSM):
    """(south, west, north, east) around a set of (lat, lon) polylines."""
    lats = [lat for way in ways for lat, _ in way]
    lons = [lon for way in ways for _, lon in way]
    if not lats:
        return None
    return (min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)


@dataclass
class Place:
    root: Path
    name: str = ""
    id: str = ""
    context: str = ""
    kind: str = "municipality"
    authorities: List[dict] = field(default_factory=list)
    default_authority: str = ""
    assets: Dict[str, str] = field(default_factory=dict)
    map_center: Optional[Point] = None
    map_zoom: int = 13
    fetch: Dict[str, str] = field(default_factory=dict)

    # -- identity ---------------------------------------------------------
    @property
    def display_name(self) -> str:
        """"Malden, Massachusetts" — or just the name when there's no context.
        Disambiguation matters more than it looks: there is a Malden in
        Massachusetts and another in Washington."""
        return f"{self.name}, {self.context}" if self.context else self.name

    def authority_name(self, authority_id: str) -> str:
        """The display name for an authority id, falling back to the id so a
        file that references an undeclared authority still renders something."""
        for a in self.authorities:
            if a.get("id") == authority_id:
                return a.get("name", authority_id)
        return authority_id

    # -- assets -----------------------------------------------------------
    def asset(self, key: str) -> Optional[Path]:
        """Resolved path for a named asset, or None when this deployment
        doesn't ship one. A missing street graph or seed network is a normal
        state, not an error — see V2_PLAN.md §7 and §8.4."""
        rel = self.assets.get(key)
        if not rel:
            return None
        path = self.root / rel
        return path if path.exists() else None

    # -- geography --------------------------------------------------------
    def boundary_ways(self) -> List[List[Point]]:
        """The boundary as raw (lat, lon) polylines, straight from the file."""
        path = self.asset("boundary")
        if path is None:
            return []
        fc = json.loads(path.read_text(encoding="utf-8"))
        ways = []
        for feat in fc.get("features", []):
            coords = feat.get("geometry", {}).get("coordinates", [])
            way = [(lat, lon) for lon, lat in coords]
            if len(way) >= 2:
                ways.append(way)
        return ways

    def boundary(self):
        """The assembled area polygon (see bikenetwork.boundary)."""
        from .boundary import boundary_from_ways
        return boundary_from_ways(self.boundary_ways())

    def bbox(self, pad: float = BBOX_PAD_OSM):
        """(south, west, north, east) for OSM queries — DERIVED from the
        boundary, never hardcoded, so another town needs no code change."""
        return bbox_from_ways(self.boundary_ways(), pad=pad)


def load_place(root: Optional[Path] = None) -> Place:
    """Read `<root>/data/place.json`. Defaults to this repo's own root, whose
    place is Malden."""
    root = Path(root) if root is not None else ROOT
    path = root / "data" / "place.json"
    raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    m = raw.get("map") or {}
    center = m.get("center")
    return Place(
        root=root,
        name=str(raw.get("name", "") or ""),
        id=str(raw.get("id", "") or ""),
        context=str(raw.get("context", "") or ""),
        kind=str(raw.get("kind", "municipality") or "municipality"),
        authorities=list(raw.get("authorities") or []),
        default_authority=str(raw.get("default_authority", "") or ""),
        assets=dict(raw.get("assets") or {}),
        map_center=(float(center[0]), float(center[1]))
        if isinstance(center, (list, tuple)) and len(center) == 2 else None,
        map_zoom=int(m.get("zoom", 13) or 13),
        fetch=dict(raw.get("fetch") or {}),
    )
