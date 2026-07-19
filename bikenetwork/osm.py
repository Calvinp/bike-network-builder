"""OpenStreetMap resolution seam.

This is the ONLY module that touches the network. It resolves each corridor
(an on-street name + two intersection endpoints) into a real polyline by:

  1. finding the OSM node where on_street crosses each cross-street, then
  2. walking the shortest path along on_street between those two nodes.

Results are cached to data/osm_cache.json so ordinary runs and the entire test
suite work OFFLINE. Network calls are throttled and retried politely so we stay
within the public Overpass API's fair-use limits.

The pure helpers (parse_cross_street, build_graph_from_overpass) are unit
-tested; the networked functions are exercised by the end-to-end build.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .geometry import haversine_miles, shortest_path

# Bounding box for Malden, MA: (south, west, north, east). Padded slightly beyond
# the city's true extent (lat ~42.412-42.445, lon ~-71.089 to -71.020) so border
# intersections still resolve, but tight enough to avoid pulling in neighboring
# cities' same-named streets. Final geometry is clipped to the boundary anyway.
MALDEN_BBOX = (42.405, -71.098, 42.452, -71.012)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "MaldenBikeNetworkBuilder/0.2 (Malden Safe Streets; email@maldensafestreets.org)"

Point = Tuple[float, float]


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------- #
def parse_cross_street(on_street: str, endpoint: str) -> Optional[str]:
    """Given an endpoint like 'Main Street & Pleasant Street', return the cross
    street ('Pleasant Street'). Returns None if the endpoint isn't a parseable
    intersection on `on_street`."""
    parts = re.split(r"\s*(?:&|\band\b|/| at )\s*", endpoint, flags=re.IGNORECASE)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) != 2:
        return None
    on_lower = on_street.lower()
    others = [p for p in parts if p.lower() != on_lower]
    if len(others) != 1:
        return None
    # Confirm on_street is actually one of the two parts.
    if not any(p.lower() == on_lower for p in parts):
        return None
    return others[0]


def build_graph_from_overpass(elements: list) -> Tuple[Dict[int, List[Tuple[int, float]]], Dict[int, Point]]:
    """Turn Overpass 'elements' (ways with node ids + geometry) into a weighted
    adjacency graph and a node->(lat,lon) map."""
    adj: Dict[int, List[Tuple[int, float]]] = {}
    coord: Dict[int, Point] = {}
    for el in elements:
        if el.get("type") != "way":
            continue
        ids = el.get("nodes")
        geo = el.get("geometry")
        if not ids or not geo or len(ids) != len(geo):
            continue
        for nid, g in zip(ids, geo):
            coord[nid] = (g["lat"], g["lon"])
        for n1, n2 in zip(ids, ids[1:]):
            d = haversine_miles(coord[n1], coord[n2])
            adj.setdefault(n1, []).append((n2, d))
            adj.setdefault(n2, []).append((n1, d))
    return adj, coord


# --------------------------------------------------------------------------- #
# Networked functions (throttled, cached)
# --------------------------------------------------------------------------- #
class OverpassClient:
    def __init__(self, bbox=MALDEN_BBOX, min_interval: float = 2.0, max_retries: int = 4):
        self.bbox = bbox
        self.min_interval = min_interval
        self.max_retries = max_retries
        self._last_call = 0.0

    def _bbox_str(self) -> str:
        return ",".join(str(x) for x in self.bbox)

    def query(self, ql: str) -> dict:
        """POST an Overpass QL query, throttled with exponential backoff on 429/503."""
        for attempt in range(self.max_retries):
            wait = self.min_interval - (time.time() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            data = urllib.parse.urlencode({"data": ql}).encode()
            req = urllib.request.Request(
                OVERPASS_URL, data=data, headers={"User-Agent": USER_AGENT}
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    self._last_call = time.time()
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                self._last_call = time.time()
                if e.code in (429, 503, 504) and attempt < self.max_retries - 1:
                    backoff = self.min_interval * (2 ** (attempt + 1))
                    time.sleep(backoff)
                    continue
                raise
        raise RuntimeError("Overpass query failed after retries")

    def intersection_nodes(self, on_street: str, cross_street: str):
        """Return ALL OSM nodes where on_street meets cross_street, as
        [(node_id, lat, lon), ...]. There can be several when the same pair of
        street names crosses in more than one city (e.g. Malden AND Melrose)."""
        b = self._bbox_str()
        ql = (
            f'[out:json][timeout:90];'
            f'way["name"="{on_street}"]["highway"]({b})->.a;'
            f'way["name"="{cross_street}"]["highway"]({b})->.c;'
            f'node(w.a)(w.c);out;'
        )
        nodes = [e for e in self.query(ql).get("elements", []) if e.get("type") == "node"]
        return [(n["id"], n["lat"], n["lon"]) for n in nodes]

    def street_graph(self, on_street: str):
        """Fetch all ways named on_street in the bbox; return (adj, coord)."""
        b = self._bbox_str()
        ql = f'[out:json][timeout:90];way["name"="{on_street}"]["highway"]({b});out geom;'
        return build_graph_from_overpass(self.query(ql).get("elements", []))

    # Road types worth snapping to (streets + shared-use paths; skip driveways,
    # service roads, sidewalks, steps).
    SNAP_HIGHWAYS = ("primary|secondary|tertiary|residential|unclassified|"
                     "living_street|trunk|primary_link|secondary_link|"
                     "tertiary_link|cycleway|path|pedestrian|busway")

    def full_street_graph(self):
        """Fetch the whole Malden street/path network in the bbox as (adj, coord).
        Used for snap-to-road routing; fetched once and cached by the caller."""
        b = self._bbox_str()
        ql = (f'[out:json][timeout:180];'
              f'way["highway"~"^({self.SNAP_HIGHWAYS})$"]({b});out geom;')
        return build_graph_from_overpass(self.query(ql).get("elements", []))


def _cache_key(corridor) -> str:
    return f"{corridor.on_street}|{corridor.frm}|{corridor.to}"


def resolve_network(
    corridors: list,
    cache_path: str | Path,
    refresh: bool = False,
    client: Optional[OverpassClient] = None,
    inside=None,
) -> Tuple[Dict[str, dict], List[str]]:
    """Resolve every corridor to geometry + length, using a JSON cache.

    `inside`, if given, is a predicate inside(lat, lon) -> bool that is True for
    points within (a small buffer of) the Malden boundary. When the same street
    names intersect in more than one city, we pick the node inside Malden — this
    avoids silently locking onto a Melrose/Everett junction. If a pair only crosses
    at/over the border, the corridor is kept (and later clipped to the city line)
    but reported as a NOTICE so the user can verify intent.

    Returns ({corridor_name: {"geometry": [[lat,lon],...], "miles": float}},
             [warnings], [notices]). Corridors that can't be resolved at all are
             reported as warnings and omitted (the build continues so one bad
             entry doesn't sink the whole map).
    """

    def pick_node(on_street: str, cross_street: str):
        """Return (node_id, error) where error is None / 'missing' / 'outside'."""
        cands = client.intersection_nodes(on_street, cross_street)
        if not cands:
            return None, "missing"
        if inside is not None:
            in_malden = [c for c in cands if inside(c[1], c[2])]
            if in_malden:
                return in_malden[0][0], None
            # No in-Malden node: the pair only crosses at/over the border. Use it
            # anyway (the segment will be clipped to the city line) but flag it.
            return cands[0][0], "outside"
        return cands[0][0], None

    cache_path = Path(cache_path)
    cache: Dict[str, dict] = {}
    if cache_path.exists():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))

    resolved: Dict[str, dict] = {}
    warnings: List[str] = []
    notices: List[str] = []
    graph_cache: Dict[str, tuple] = {}
    client = client  # lazily created only if we actually need the network

    for c in corridors:
        key = _cache_key(c)
        if not refresh and key in cache:
            resolved[c.name] = cache[key]
            continue

        if client is None:
            client = OverpassClient()

        cross_from = parse_cross_street(c.on_street, c.frm)
        cross_to = parse_cross_street(c.on_street, c.to)
        if not cross_from or not cross_to:
            warnings.append(
                f"{c.name}: could not parse intersection endpoints "
                f"('{c.frm}', '{c.to}'). Use 'On Street & Cross Street'."
            )
            continue

        try:
            n_from, err_from = pick_node(c.on_street, cross_from)
            n_to, err_to = pick_node(c.on_street, cross_to)
        except Exception as e:  # network/Overpass failure
            warnings.append(f"{c.name}: Overpass lookup failed ({e}).")
            continue

        if n_from is None or n_to is None:
            cross = cross_from if n_from is None else cross_to
            warnings.append(
                f"{c.name}: no OSM intersection of '{c.on_street}' and '{cross}' "
                f"found anywhere. Check the street names."
            )
            continue

        # One or both endpoints only exist at/over the border: keep the corridor
        # (it gets clipped to Malden), but tell the user to confirm intent — this
        # is where an unintended out-of-city junction would otherwise slip in.
        outside = [cx for cx, e in ((cross_from, err_from), (cross_to, err_to))
                   if e == "outside"]
        if outside:
            notices.append(
                f"{c.name}: intersection with {' & '.join(outside)} sits OUTSIDE Malden "
                f"(likely Melrose/Everett); the in-city portion was kept — verify this is "
                f"the segment you meant, or repoint the endpoint."
            )

        if c.on_street not in graph_cache:
            try:
                graph_cache[c.on_street] = client.street_graph(c.on_street)
            except Exception as e:
                warnings.append(f"{c.name}: failed to fetch '{c.on_street}' geometry ({e}).")
                continue
        adj, coord = graph_cache[c.on_street]

        pts, miles = shortest_path(adj, coord, n_from, n_to)
        if pts is None:
            warnings.append(
                f"{c.name}: '{c.on_street}' segment between '{cross_from}' and "
                f"'{cross_to}' is not connected in OSM data."
            )
            continue

        entry = {"geometry": [list(p) for p in pts], "miles": miles}
        resolved[c.name] = entry
        cache[key] = entry

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return resolved, warnings, notices
