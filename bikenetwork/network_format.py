"""The bike-network YAML format (`network.yaml`).

One YAML file describes the whole network: city metadata, the implementation
phases, and EVERY path — existing, funded, and proposed — with its type, phase,
and exact geometry. The file is the tool's portable interchange format: exports
can be re-imported here, and the format is deliberately simple so that other
software can read it too.

This module is intentionally self-contained (stdlib + PyYAML only). Treat the
format as a STABLE CONTRACT: files written by older versions must keep parsing,
and a change old readers can't understand must bump FORMAT_VERSION. The format
is documented for humans in NETWORK_FORMAT.md.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import yaml

FORMAT_ID = "malden-bike-network"
FORMAT_VERSION = 1

# Types of path and their rough build character ($/mile lives in each tool's
# costs.py).
PATH_TYPES = (
    "quick_build_separated",  # flex posts / paint / precast curb — cheap, fast
    "concrete_separated",     # permanent raised/concrete-protected lane
    "shared_use_path",        # off-street path (e.g. trail spur)
    "buffered_painted",       # painted + buffer (interim only)
    "neighborway",            # traffic-calmed shared street (signs/humps/diverters)
    "pedestrianized",         # car-free / car-light street conversion (bikes welcome)
)

STATUSES = (
    "proposed",   # in the plan, not built
    "funded",     # funded/under design
    "existing",   # already on the ground (shown for context)
)

JURISDICTIONS = (
    "city",   # Malden controls the street — the City can build it directly
    "state",  # MassDOT-controlled (a numbered state route) — needs state approval
)

# Point ("spot") improvements — single-location infrastructure that isn't a
# path: traffic calming, crossings, parking, greening.
SPOT_KINDS = (
    "speed_hump",
    "raised_crosswalk",
    "raised_intersection",
    "curb_extension",
    "bike_parking",
    "street_trees",
    "other",
)

# Spots are either on the ground or proposed — there's no funded pipeline
# tracking for small interventions.
SPOT_STATUSES = ("existing", "proposed")

Point = Tuple[float, float]  # (lat, lon) degrees


@dataclass
class PhaseDef:
    number: int
    label: str = ""
    deadline: str = ""


@dataclass
class BikePath:
    name: str
    type: str = "quick_build_separated"
    status: str = "proposed"
    jurisdiction: str = "city"
    # Optional stable identity ("" = none). Only needed when another path
    # upgrades this one; editors assign one lazily so plain files stay clean.
    id: str = ""
    # Id of the path this one replaces in a later phase (e.g. quick-build now,
    # concrete rebuild later). The upgraded path's corridor is counted once in
    # full-buildout mileage, but every phase's work still costs money.
    upgrades: str = ""
    # Implementation phase. Required for proposed paths; None for existing /
    # funded ones (they aren't part of the phased build).
    phase: Optional[int] = None
    # Number of separated bike facilities on the corridor: 2 = one each
    # direction (the usual two-way street case), 1 = a single one-way facility.
    # Drives "bicycle lane miles" (Cambridge/Somerville convention).
    directions: int = 2
    on_street: str = ""
    frm: str = ""       # "from" is a Python keyword; the YAML key is `from`
    to: str = ""
    notes: str = ""
    # One path can have several disjoint polylines (e.g. a trail interrupted
    # by street crossings, kept as ONE entry). Each segment is [(lat, lon)...].
    # The YAML key is `geometry`: a flat point list for one segment, or a list
    # of point lists for several.
    segments: List[List[Point]] = field(default_factory=list)
    # Derived (never serialized): set by whoever measures/clips the geometry.
    length_miles: float = 0.0


@dataclass
class Spot:
    name: str = ""
    kind: str = "other"
    status: str = "proposed"
    # Optional even for proposed spots — small interventions often aren't
    # tied to a network phase.
    phase: Optional[int] = None
    location: Optional[Point] = None   # (lat, lon); None = malformed/missing
    notes: str = ""


@dataclass
class Network:
    city: str = "Malden"
    state: str = "Massachusetts"
    ordinance_chapter: str = ""
    phases: List[PhaseDef] = field(default_factory=list)
    paths: List[BikePath] = field(default_factory=list)
    spots: List[Spot] = field(default_factory=list)
    format_id: str = FORMAT_ID
    format_version: int = FORMAT_VERSION

    def phase_map(self) -> Dict[int, PhaseDef]:
        return {p.number: p for p in self.phases}


def superseded_ids(paths: List[BikePath]) -> set:
    """Ids of paths that some other path upgrades (replaces in a later phase).
    Both tools use this to count an upgraded corridor once in full-buildout
    mileage while still costing every phase's work. A dangling reference
    supersedes nothing (validation reports it separately)."""
    ids = {p.id for p in paths if p.id}
    return {p.upgrades for p in paths if p.upgrades and p.upgrades in ids}


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def _to_int(value, default=None):
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_segments(raw_geom) -> List[List]:
    """Normalize the YAML `geometry` value into a list of segments. A flat
    list of [lat, lon] pairs is one segment; a list of such lists is several.
    Malformed points become None so validation can point at them."""
    if (isinstance(raw_geom, list) and raw_geom
            and all(isinstance(el, (list, tuple)) and el
                    and isinstance(el[0], (list, tuple)) for el in raw_geom)):
        seg_lists = raw_geom            # nested: several segments
    else:
        seg_lists = [raw_geom or []]    # flat: a single segment
    segments = []
    for seg in seg_lists:
        pts = []
        for pt in (seg if isinstance(seg, (list, tuple)) else []):
            if (isinstance(pt, (list, tuple)) and len(pt) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                            for v in pt)):
                pts.append((float(pt[0]), float(pt[1])))
            else:
                pts.append(None)
        segments.append(pts)
    return segments


def parse_network(text: str) -> Network:
    """Parse network.yaml text into a Network. Lenient: missing fields get
    defaults and malformed values become None/empty — run validate_network()
    afterwards to get human-readable errors before trusting the result."""
    raw = yaml.safe_load(text)
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("network.yaml must be a YAML mapping at the top level "
                         "(got a %s)." % type(raw).__name__)
    return network_from_dict(raw)


def network_from_dict(raw: dict) -> Network:
    """Build a Network from an already-loaded YAML/JSON mapping (same leniency
    as parse_network)."""
    phases = []
    for item in raw.get("phases") or []:
        if not isinstance(item, dict):
            continue
        phases.append(PhaseDef(
            number=_to_int(item.get("phase"), default=0) or 0,
            label=str(item.get("label", "") or ""),
            deadline=str(item.get("deadline", "") or ""),
        ))

    paths = []
    for item in raw.get("paths") or []:
        if not isinstance(item, dict):
            continue
        paths.append(BikePath(
            name=str(item.get("name", "") or "").strip(),
            # `treatment` is the pre-split name for `type`; accept it on read.
            type=str(item.get("type", item.get("treatment", "")) or "").strip(),
            status=str(item.get("status", "proposed") or "proposed").strip(),
            jurisdiction=str(item.get("jurisdiction", "city") or "city").strip(),
            id=str(item.get("id", "") or "").strip(),
            upgrades=str(item.get("upgrades", "") or "").strip(),
            phase=_to_int(item.get("phase"), default=None),
            directions=_to_int(item.get("directions"), default=2) or 2,
            on_street=str(item.get("on_street", "") or "").strip(),
            frm=str(item.get("from", "") or "").strip(),
            to=str(item.get("to", "") or "").strip(),
            notes=str(item.get("notes", "") or "").strip(),
            segments=_parse_segments(item.get("geometry")),
        ))

    spots = []
    for item in raw.get("spots") or []:
        if not isinstance(item, dict):
            continue
        loc = item.get("location")
        if (isinstance(loc, (list, tuple)) and len(loc) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                        for v in loc)):
            location = (float(loc[0]), float(loc[1]))
        else:
            location = None
        spots.append(Spot(
            name=str(item.get("name", "") or "").strip(),
            kind=str(item.get("kind", "other") or "other").strip(),
            status=str(item.get("status", "proposed") or "proposed").strip(),
            phase=_to_int(item.get("phase"), default=None),
            location=location,
            notes=str(item.get("notes", "") or "").strip(),
        ))

    return Network(
        city=str(raw.get("city", "Malden") or "Malden"),
        state=str(raw.get("state", "Massachusetts") or "Massachusetts"),
        ordinance_chapter=str(raw.get("ordinance_chapter", "") or ""),
        phases=phases,
        paths=paths,
        spots=spots,
        format_id=str(raw.get("format", FORMAT_ID) or FORMAT_ID),
        format_version=_to_int(raw.get("format_version"), default=FORMAT_VERSION),
    )


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_network(net: Network) -> List[str]:
    """Return a list of human-readable errors (empty == valid). Import UIs show
    these verbatim, so every message says which path/field is wrong and why."""
    errors: List[str] = []

    if net.format_id != FORMAT_ID:
        errors.append(f"unrecognized format {net.format_id!r}; expected {FORMAT_ID!r}.")
    if net.format_version is None or net.format_version > FORMAT_VERSION:
        errors.append(f"format_version {net.format_version!r} is newer than this tool "
                      f"understands (max {FORMAT_VERSION}). Update the tool.")

    phase_numbers = [p.number for p in net.phases]
    for p in net.phases:
        if p.number < 1:
            errors.append(f"phase {p.number!r}: 'phase' must be a positive integer.")
    dupes = {n for n in phase_numbers if phase_numbers.count(n) > 1}
    if dupes:
        errors.append(f"duplicate phase number(s): {sorted(dupes)}.")

    path_ids = [p.id for p in net.paths if p.id]
    dupe_ids = {i for i in path_ids if path_ids.count(i) > 1}
    if dupe_ids:
        errors.append(f"duplicate path id(s): {sorted(dupe_ids)}.")

    for i, path in enumerate(net.paths):
        label = path.name or f"path #{i + 1}"
        if not path.name:
            errors.append(f"path #{i + 1}: missing required field 'name'.")
        if path.type not in PATH_TYPES:
            errors.append(f"{label}: unknown type {path.type!r}; "
                          f"must be one of {', '.join(PATH_TYPES)}.")
        if path.status not in STATUSES:
            errors.append(f"{label}: unknown status {path.status!r}; "
                          f"must be one of {', '.join(STATUSES)}.")
        if path.jurisdiction not in JURISDICTIONS:
            errors.append(f"{label}: unknown jurisdiction {path.jurisdiction!r}; "
                          f"must be one of {', '.join(JURISDICTIONS)}.")
        if path.directions not in (1, 2):
            errors.append(f"{label}: 'directions' must be 1 or 2 "
                          f"(got {path.directions!r}).")
        if path.upgrades:
            if path.status != "proposed":
                errors.append(f"{label}: only a proposed path can have "
                              f"'upgrades' (status is {path.status!r}).")
            if path.upgrades == path.id:
                errors.append(f"{label}: a path cannot upgrade itself.")
            elif path.upgrades not in path_ids:
                errors.append(f"{label}: 'upgrades' references unknown path "
                              f"id {path.upgrades!r}.")
            else:
                # Walk the chain to catch loops (a upgrades b upgrades a).
                by_id = {p.id: p for p in net.paths if p.id}
                seen, cur = {path.id or object()}, path.upgrades
                while cur:
                    if cur in seen:
                        errors.append(f"{label}: 'upgrades' chain forms a loop.")
                        break
                    seen.add(cur)
                    nxt = by_id.get(cur)
                    cur = nxt.upgrades if nxt else ""

        if path.status == "proposed":
            if path.phase is None or path.phase < 1:
                errors.append(f"{label}: a proposed path needs a positive integer "
                              f"'phase' (got {path.phase!r}).")
            elif phase_numbers and path.phase not in phase_numbers:
                errors.append(f"{label}: phase {path.phase} is not declared in "
                              f"the top-level 'phases' list.")

        if not path.segments or all(len(s) < 2 for s in path.segments):
            errors.append(f"{label}: 'geometry' needs at least 2 [lat, lon] points.")
        for si, seg in enumerate(path.segments):
            where = f"segment #{si + 1} " if len(path.segments) > 1 else ""
            if path.segments and len(seg) < 2 and len(path.segments) > 1:
                errors.append(f"{label}: geometry {where.strip()} needs at "
                              f"least 2 [lat, lon] points.")
            for j, pt in enumerate(seg):
                if pt is None:
                    errors.append(f"{label}: geometry {where}point #{j + 1} is "
                                  f"not a [lat, lon] pair of numbers.")
                elif not (-90 <= pt[0] <= 90 and -180 <= pt[1] <= 180):
                    errors.append(f"{label}: geometry {where}point #{j + 1} "
                                  f"({pt[0]}, {pt[1]}) is out of range — points "
                                  f"are [lat, lon], in degrees.")

    for i, spot in enumerate(net.spots):
        label = f"spot #{i + 1}" + (f" ({spot.name})" if spot.name else "")
        if spot.kind not in SPOT_KINDS:
            errors.append(f"{label}: unknown kind {spot.kind!r}; "
                          f"must be one of {', '.join(SPOT_KINDS)}.")
        if spot.status not in SPOT_STATUSES:
            errors.append(f"{label}: unknown status {spot.status!r}; "
                          f"must be one of {', '.join(SPOT_STATUSES)}.")
        if spot.location is None:
            errors.append(f"{label}: needs a 'location' — one [lat, lon] "
                          f"pair of numbers.")
        elif not (-90 <= spot.location[0] <= 90
                  and -180 <= spot.location[1] <= 180):
            errors.append(f"{label}: location ({spot.location[0]}, "
                          f"{spot.location[1]}) is out of range — it is "
                          f"[lat, lon], in degrees.")
        if (spot.phase is not None and phase_numbers
                and spot.phase not in phase_numbers):
            errors.append(f"{label}: phase {spot.phase} is not declared in "
                          f"the top-level 'phases' list.")
    return errors


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #
def _path_dict(p: BikePath) -> dict:
    out: dict = {"name": p.name, "type": p.type, "status": p.status,
                 "jurisdiction": p.jurisdiction}
    # Optional identity/upgrade fields are omitted when unset so files that
    # never use them serialize exactly as they did before the fields existed.
    if p.id:
        out["id"] = p.id
    if p.upgrades:
        out["upgrades"] = p.upgrades
    if p.phase is not None:
        out["phase"] = p.phase
    out["directions"] = p.directions
    for key, value in (("on_street", p.on_street), ("from", p.frm),
                       ("to", p.to), ("notes", p.notes)):
        if value:
            out[key] = value
    # One segment serializes flat (the common case, and the pre-multi-segment
    # form); several serialize as a list of point lists.
    segs = [[[round(lat, 6), round(lon, 6)] for lat, lon in seg]
            for seg in p.segments]
    out["geometry"] = segs[0] if len(segs) == 1 else segs
    return out


def _spot_dict(s: Spot) -> dict:
    out: dict = {}
    if s.name:
        out["name"] = s.name
    out["kind"] = s.kind
    out["status"] = s.status
    if s.phase is not None:
        out["phase"] = s.phase
    if s.location is not None:
        out["location"] = [round(s.location[0], 6), round(s.location[1], 6)]
    if s.notes:
        out["notes"] = s.notes
    return out


def serialize_network(net: Network) -> str:
    """Serialize a Network to YAML text (stable key order; geometry points in
    compact [lat, lon] flow style)."""
    doc: dict = {
        "format": FORMAT_ID,
        "format_version": FORMAT_VERSION,
        "city": net.city,
        "state": net.state,
    }
    if net.ordinance_chapter:
        doc["ordinance_chapter"] = net.ordinance_chapter
    doc["phases"] = [{"phase": p.number, "label": p.label, "deadline": p.deadline}
                     for p in sorted(net.phases, key=lambda p: p.number)]
    doc["paths"] = [_path_dict(p) for p in net.paths]
    # Spot improvements are optional; files that don't use them keep
    # serializing exactly as they did before the key existed.
    if net.spots:
        doc["spots"] = [_spot_dict(s) for s in net.spots]
    header = ("# Bike network — written by bike-network-builder; re-importable there and\n"
              "# readable by any YAML tool. Geometry points are [latitude, longitude]\n"
              "# in degrees. See NETWORK_FORMAT.md.\n")
    return header + yaml.safe_dump(doc, sort_keys=False, default_flow_style=None,
                                   allow_unicode=True, width=100)
