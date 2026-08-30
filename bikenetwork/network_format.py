"""The bike-network file format, v2 (`network.yaml`).

One YAML file describes a whole network: the areas it covers, who builds what,
the phases, and every FEATURE — a place — with its TREATMENTS — the facilities
built there. It is the tool's portable interchange format, and the contract
between the app, `build.py`, and anything else that reads it.

This module is self-contained (stdlib + PyYAML only) and is the reference
reader/validator. `web/js/network_format.js` is the other implementation;
parity tests keep them honest.

## The shape

    format: bike-network
    format_version: 2
    crs: 'EPSG:4326'          # WGS84 lat/lon degrees
    units: metric             # storage unit; display is a UI preference
    meta:        { title, description, created, updated, license, source_url,
                   contributors: [...], generated_by: {...} }
    areas:       [ {id, name, kind, context, default_authority, boundary, tags} ]
    authorities: [ {id, name, level, note} ]
    phases:      [ {id, number, label, target_date, tags} ]
    costs:       { currency, per_km, per_unit, by_area }
    features:    [ {id, name, on_street, start, end, notes, tags,
                    treatments: [...], geometry: [...] } ]

## The dividing rule

**Anything describing the PLACE lives on the feature. Anything describing the
FACILITY lives on the treatment.** Treatment fields may be defaulted at the
feature level and overridden per treatment, so the common single-treatment case
stays short.

## Invariants every consumer relies on

* **Lengths are derived, never stored.** Consumers measure and boundary-clip
  the geometry themselves, so a hand-edited file cannot disagree with itself.
* **Geometry is a list of PARTS.** A part with one coordinate is a point, two
  or more is a line. One feature may mix both. No polymorphism, no sniffing.
* **Treatment list order is INSIGNIFICANT.** Renderers order by the registry's
  `stack_rank`; nothing may treat `treatments[0]` as primary. This is what
  keeps a future `arrangement:` key reachable without another break.
* **One shared id namespace**, always assigned, so a reference never has to say
  what kind of thing it points at.
* **Strict about structure, lenient-with-notice about vocabulary** — but only
  where an unknown value can't change the arithmetic. An unknown treatment type
  is fine (reported, drawn neutrally, uncosted); an unknown `status` is an
  error, because it can't be bucketed as built-or-asked-for.
* **`target_date` is always a STRING.** YAML's implicit timestamp type turns an
  unquoted date into a date object in PyYAML and a UTC-midnight Date in
  js-yaml, which renders a day early west of UTC.
"""
from __future__ import annotations

import datetime as _dt
import secrets
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

import yaml

FORMAT_ID = "bike-network"
LEGACY_FORMAT_ID = "malden-bike-network"      # v1; accepted on read only
FORMAT_VERSION = 2

CRS = "EPSG:4326"          # WGS84 lat/lon degrees, what GPS and GeoJSON use
UNITS = ("metric",)        # imperial is a DISPLAY preference, not a storage one

# Closed vocabulary: an unknown status can't be bucketed as built-or-asked-for
# without silently corrupting the totals.
STATUSES = ("existing", "under_construction", "funded", "proposed")
# Statuses that describe the ground today rather than the ask.
CONTEXT_STATUSES = ("existing", "under_construction", "funded")

# Closed: used for rollups and defaults. The displayed name is always the
# free-text one, so nothing is mistranslated.
AUTHORITY_LEVELS = ("municipal", "county", "state", "federal", "special", "private")

TRAVEL = ("one_way", "two_way")
SIDES = (1, 2)
SIDE_VALUES = ("", "left", "right", "both", "median", "off_street")

# Fields that only mean something on a line. `side` is deliberately NOT here:
# on a point it is descriptive, recorded and shown but never used to move the
# drawn position, because the coordinates already say where the thing is.
LINE_ONLY_FIELDS = ("travel", "sides")

Point = Tuple[float, float]

_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"   # no l/1/0/o


def new_id(prefix: str = "") -> str:
    """A collision-resistant id. Always assigned, never lazy: a feature has to
    keep its identity across export -> edit -> re-import."""
    body = "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))
    return f"{prefix}{body}" if prefix else body


# --------------------------------------------------------------------------- #
# Value coercion
# --------------------------------------------------------------------------- #
def _s(value, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, bool):
        return default
    return str(value).strip() or default


def _to_int(value, default=None):
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_date_string(value) -> str:
    """Normalize whatever YAML produced back to `YYYY[-MM[-DD]]`.

    An unquoted `2029-12-31` parses as a date and an unquoted `2029` as an int,
    and the two YAML implementations disagree about the former's timezone. The
    model only ever holds a string, and the serializer only ever writes one.
    """
    if value is None or value is False:
        return ""
    if isinstance(value, _dt.datetime):
        return value.date().isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if isinstance(value, int):
        return str(value)
    return _s(value)


def _tags(value) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _parse_geometry(raw) -> List[List[Point]]:
    """`geometry` is a list of parts; a part is a list of [lat, lon] pairs.
    A malformed coordinate becomes None so validation can point at it."""
    parts: List[List[Point]] = []
    for raw_part in (raw if isinstance(raw, (list, tuple)) else []):
        if not isinstance(raw_part, (list, tuple)):
            continue
        pts: List[Point] = []
        for pt in raw_part:
            if (isinstance(pt, (list, tuple)) and len(pt) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                            for v in pt)):
                pts.append((float(pt[0]), float(pt[1])))
            else:
                pts.append(None)
        parts.append(pts)
    return parts


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #
@dataclass
class Authority:
    id: str = ""
    name: str = ""
    level: str = "municipal"
    note: str = ""


@dataclass
class Area:
    id: str = ""
    name: str = ""
    kind: str = "municipality"
    context: str = ""
    default_authority: str = ""
    updated: str = ""
    # A multipolygon: [polygon, ...]; polygon = [outer_ring, hole, ...].
    boundary: List[List[List[Point]]] = field(default_factory=list)
    contributors: List[dict] = field(default_factory=list)
    tags: dict = field(default_factory=dict)

    @property
    def display_name(self) -> str:
        return f"{self.name}, {self.context}" if self.context else self.name


@dataclass
class PhaseDef:
    id: str = ""
    number: int = 1
    label: str = ""
    target_date: str = ""        # 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' | ''
    tags: dict = field(default_factory=dict)


@dataclass
class Treatment:
    """What is being built. Fields omitted here inherit from the feature."""
    id: str = ""
    type: str = "other"
    status: str = "proposed"
    phase: Optional[str] = None          # a phase ID, not a number
    authority: str = ""
    travel: str = "two_way"
    sides: int = 2
    side: str = ""
    quantity: Optional[int] = None       # for `counted` treatments
    upgrades: List[str] = field(default_factory=list)   # treatment ids
    proposed_by: str = ""
    notes: str = ""
    tags: dict = field(default_factory=dict)

    @property
    def is_proposed(self) -> bool:
        return self.status == "proposed"


@dataclass
class Feature:
    """Where it is. One entry per place, however many treatments it carries."""
    id: str = ""
    name: str = ""
    on_street: str = ""
    start: str = ""
    end: str = ""
    notes: str = ""
    treatments: List[Treatment] = field(default_factory=list)
    # A list of parts; a part with 1 point is a point, 2+ is a line.
    geometry: List[List[Point]] = field(default_factory=list)
    tags: dict = field(default_factory=dict)
    # Derived (never serialized): set by whoever measures/clips the geometry.
    length_km: float = 0.0

    def points(self) -> List[Point]:
        return [p[0] for p in self.geometry if len(p) == 1 and p[0] is not None]

    def lines(self) -> List[List[Point]]:
        return [p for p in self.geometry if len(p) >= 2]

    @property
    def geometry_kind(self) -> str:
        has_pt, has_line = bool(self.points()), bool(self.lines())
        if has_pt and has_line:
            return "mixed"
        if has_pt:
            return "point"
        return "line" if has_line else "empty"

    @property
    def is_point(self) -> bool:
        return self.geometry_kind == "point"


@dataclass
class Network:
    areas: List[Area] = field(default_factory=list)
    authorities: List[Authority] = field(default_factory=list)
    phases: List[PhaseDef] = field(default_factory=list)
    features: List[Feature] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    costs: dict = field(default_factory=dict)
    units: str = "metric"
    crs: str = CRS
    format_id: str = FORMAT_ID
    format_version: int = FORMAT_VERSION
    # Top-level keys this version doesn't interpret, carried through untouched
    # (`ordinance_chapter` is the motivating case).
    extra: dict = field(default_factory=dict)

    # -- lookups ----------------------------------------------------------
    def phase_map(self) -> Dict[str, PhaseDef]:
        return {p.id: p for p in self.phases}

    def area(self, area_id: str) -> Optional[Area]:
        return next((a for a in self.areas if a.id == area_id), None)

    def authority(self, authority_id: str) -> Authority:
        """Always returns something: an undeclared id renders as itself rather
        than as a blank in the UI."""
        found = next((a for a in self.authorities if a.id == authority_id), None)
        return found or Authority(id=authority_id, name=authority_id or "")

    def treatments(self):
        for f in self.features:
            for t in f.treatments:
                yield f, t

    def treatment(self, treatment_id: str) -> Optional[Treatment]:
        return next((t for _, t in self.treatments() if t.id == treatment_id), None)

    def all_ids(self) -> List[str]:
        ids = [a.id for a in self.areas] + [a.id for a in self.authorities]
        ids += [p.id for p in self.phases]
        for f in self.features:
            ids.append(f.id)
            ids += [t.id for t in f.treatments]
        return [i for i in ids if i]

    def unknown_treatment_types(self, registry=None) -> List[str]:
        """Treatment types this build doesn't know. Not an error — the UI says
        "this file uses N kinds of improvement this version doesn't know
        about", draws them neutrally, and leaves them out of the totals."""
        from .registry import load_registry
        reg = registry or load_registry()
        return reg.unknown_ids([t.type for _, t in self.treatments()])

    @property
    def display_name(self) -> str:
        if not self.areas:
            return self.meta.get("title", "") or ""
        if len(self.areas) == 1:
            return self.areas[0].display_name
        return " + ".join(a.name for a in self.areas)


def superseded_ids(net: Network) -> Set[str]:
    """Treatment ids that some other treatment replaces in a later phase.

    Full-buildout totals count an upgraded corridor ONCE (the final facility),
    while per-phase rows and cost still include every phase's work — building
    in 2028 and rebuilding in 2040 is two projects. A dangling reference
    supersedes nothing; validation reports it separately.
    """
    known = {t.id for _, t in net.treatments() if t.id}
    out: Set[str] = set()
    for _, t in net.treatments():
        out.update(u for u in t.upgrades if u in known)
    return out


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
_KNOWN_TOP_LEVEL = {
    "format", "format_version", "crs", "units", "meta",
    "areas", "authorities", "phases", "costs", "features",
}

# Treatment fields a feature may default for its treatments.
_INHERITABLE = ("status", "phase", "authority", "travel", "sides", "side",
                "proposed_by")


def _parse_boundary(raw) -> List[List[List[Point]]]:
    """Normalize to a multipolygon, accepting a bare ring or a single polygon
    as a convenience for hand-written files."""
    def ring(r):
        return [(float(p[0]), float(p[1])) for p in r
                if isinstance(p, (list, tuple)) and len(p) == 2]

    if not isinstance(raw, (list, tuple)) or not raw:
        return []
    first = raw[0]
    if (isinstance(first, (list, tuple)) and len(first) == 2
            and all(isinstance(v, (int, float)) for v in first)):
        return [[ring(raw)]]                                    # a bare ring
    if (isinstance(first, (list, tuple)) and first
            and isinstance(first[0], (list, tuple))
            and first[0] and isinstance(first[0][0], (int, float))):
        return [[ring(r) for r in raw]]                          # one polygon
    return [[ring(r) for r in poly] for poly in raw]             # multipolygon


def _parse_treatment(raw: dict, feature_defaults: dict) -> Treatment:
    def take(key, default):
        if key in raw and raw[key] is not None:
            return raw[key]
        return feature_defaults.get(key, default)

    upgrades = raw.get("upgrades")
    if isinstance(upgrades, str):
        upgrades = [upgrades]                    # a bare string is allowed
    elif not isinstance(upgrades, (list, tuple)):
        upgrades = []

    phase = take("phase", None)
    return Treatment(
        id=_s(raw.get("id")) or new_id("t-"),
        type=_s(raw.get("type"), "other"),
        status=_s(take("status", "proposed"), "proposed"),
        phase=_s(phase) or None,
        authority=_s(take("authority", "")),
        travel=_s(take("travel", "two_way"), "two_way"),
        sides=_to_int(take("sides", 2), default=2) or 2,
        side=_s(take("side", "")),
        quantity=_to_int(raw.get("quantity"), default=None),
        upgrades=[_s(u) for u in upgrades if _s(u)],
        proposed_by=_s(take("proposed_by", "")),
        notes=_s(raw.get("notes")),
        tags=_tags(raw.get("tags")),
    )


def _parse_feature(raw: dict) -> Feature:
    defaults = {k: raw[k] for k in _INHERITABLE if k in raw and raw[k] is not None}
    treatments = [_parse_treatment(t, defaults)
                  for t in (raw.get("treatments") or []) if isinstance(t, dict)]
    return Feature(
        id=_s(raw.get("id")) or new_id("f-"),
        name=_s(raw.get("name")),
        on_street=_s(raw.get("on_street")),
        start=_s(raw.get("start")),
        end=_s(raw.get("end")),
        notes=_s(raw.get("notes")),
        treatments=treatments,
        geometry=_parse_geometry(raw.get("geometry")),
        tags=_tags(raw.get("tags")),
    )


def network_from_dict(raw: dict) -> Network:
    """Build a Network from an already-loaded mapping. Lenient: missing fields
    take defaults and malformed values become None/empty — run
    validate_network() to get human-readable errors before trusting it."""
    areas = []
    for item in raw.get("areas") or []:
        if not isinstance(item, dict):
            continue
        areas.append(Area(
            id=_s(item.get("id")) or new_id("a-"),
            name=_s(item.get("name")),
            kind=_s(item.get("kind"), "municipality"),
            context=_s(item.get("context")),
            default_authority=_s(item.get("default_authority")),
            updated=_to_date_string(item.get("updated")),
            boundary=_parse_boundary(item.get("boundary")),
            contributors=list(item.get("contributors") or []),
            tags=_tags(item.get("tags")),
        ))

    authorities = []
    for item in raw.get("authorities") or []:
        if not isinstance(item, dict):
            continue
        authorities.append(Authority(
            id=_s(item.get("id")) or new_id("auth-"),
            name=_s(item.get("name")),
            level=_s(item.get("level"), "municipal"),
            note=_s(item.get("note")),
        ))

    phases = []
    for item in raw.get("phases") or []:
        if not isinstance(item, dict):
            continue
        phases.append(PhaseDef(
            id=_s(item.get("id")) or new_id("p-"),
            number=_to_int(item.get("number"), default=len(phases) + 1) or 1,
            label=_s(item.get("label")),
            target_date=_to_date_string(item.get("target_date")),
            tags=_tags(item.get("tags")),
        ))

    features = [_parse_feature(f) for f in (raw.get("features") or [])
                if isinstance(f, dict)]

    return Network(
        areas=areas,
        authorities=authorities,
        phases=phases,
        features=features,
        meta=dict(raw.get("meta") or {}),
        costs=dict(raw.get("costs") or {}),
        units=_s(raw.get("units"), "metric"),
        crs=_s(raw.get("crs"), CRS),
        format_id=_s(raw.get("format"), FORMAT_ID),
        format_version=_to_int(raw.get("format_version"), default=FORMAT_VERSION),
        extra={k: v for k, v in raw.items() if k not in _KNOWN_TOP_LEVEL},
    )


NETWORK_KEYS = ("format", "format_version", "features", "areas", "phases",
                "authorities")
NOT_A_NETWORK = (
    "This file doesn't look like a bike network: it declares no `format` and contains no areas, phases or features.")


def parse_network(text: str) -> Network:
    """Parse v2 YAML text into a Network. A v1 file is upgraded on the way in
    (see `migrate.py`), so callers never see a v1 shape."""
    raw = yaml.safe_load(text)
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("network.yaml must be a YAML mapping at the top level "
                         "(got a %s)." % type(raw).__name__)
    # An empty document used to sail through: yaml gives None, None became {},
    # and every field then took its default — including `format`. So importing
    # an empty or unrelated file reported SUCCESS and, on an empty map, replaced
    # the network with nothing. A file has to claim to be one of ours.
    if not any(k in raw for k in NETWORK_KEYS):
        raise ValueError(NOT_A_NETWORK)
    if _s(raw.get("format")) == LEGACY_FORMAT_ID or _to_int(
            raw.get("format_version"), default=FORMAT_VERSION) < 2:
        from .migrate import upgrade_v1
        raw = upgrade_v1(raw)
    return network_from_dict(raw)


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_network(net: Network) -> List[str]:
    """Human-readable errors (empty == valid). Import UIs show these verbatim,
    so every message says which thing is wrong and why.

    STRUCTURE is strict. VOCABULARY is lenient where an unknown value can't
    change the arithmetic — an unknown treatment type is reported elsewhere as
    a notice, not here as an error.
    """
    errors: List[str] = []

    if net.format_id not in (FORMAT_ID, LEGACY_FORMAT_ID):
        errors.append(f"unrecognized format {net.format_id!r}; expected {FORMAT_ID!r}.")
    if net.format_version is None or net.format_version > FORMAT_VERSION:
        errors.append(f"format_version {net.format_version!r} is newer than this tool "
                      f"understands (max {FORMAT_VERSION}). Update the tool.")
    if net.units not in UNITS:
        errors.append(f"unknown units {net.units!r}; this version stores "
                      f"{', '.join(UNITS)} (imperial is a display preference).")

    ids = net.all_ids()
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        errors.append(f"duplicate id(s): {', '.join(dupes)}. Areas, authorities, "
                      f"phases, features and treatments share one namespace.")

    for a in net.authorities:
        if a.level not in AUTHORITY_LEVELS:
            errors.append(f"authority {a.id!r}: unknown level {a.level!r}; "
                          f"must be one of {', '.join(AUTHORITY_LEVELS)}.")

    phase_ids = {p.id for p in net.phases}
    for p in net.phases:
        if p.number < 1:
            errors.append(f"phase {p.id!r}: 'number' must be a positive integer.")

    treatment_ids = {t.id for _, t in net.treatments() if t.id}

    for i, f in enumerate(net.features):
        label = f.name or f.id or f"feature #{i + 1}"
        if not f.name:
            errors.append(f"feature #{i + 1}: missing required field 'name'.")
        if not f.treatments:
            errors.append(f"{label}: has no treatments — a place with nothing "
                          f"built or proposed there isn't part of the network.")
        if not f.geometry or all(not part for part in f.geometry):
            errors.append(f"{label}: 'geometry' needs at least one part with "
                          f"at least one [lat, lon] coordinate.")
        for pi, part in enumerate(f.geometry):
            where = f"part #{pi + 1} " if len(f.geometry) > 1 else ""
            for j, pt in enumerate(part):
                if pt is None:
                    errors.append(f"{label}: geometry {where}point #{j + 1} is "
                                  f"not a [lat, lon] pair of numbers.")

        is_point_only = f.geometry_kind == "point"
        for t in f.treatments:
            tl = f"{label} / {t.type}"
            if t.status not in STATUSES:
                errors.append(f"{tl}: unknown status {t.status!r}; must be one "
                              f"of {', '.join(STATUSES)}.")
            if t.travel not in TRAVEL:
                errors.append(f"{tl}: 'travel' must be one of {', '.join(TRAVEL)} "
                              f"(got {t.travel!r}).")
            if t.sides not in SIDES:
                errors.append(f"{tl}: 'sides' must be 1 or 2 (got {t.sides!r}).")
            if t.side not in SIDE_VALUES:
                errors.append(f"{tl}: unknown side {t.side!r}; must be one of "
                              f"{', '.join(v for v in SIDE_VALUES if v)}.")
            if t.quantity is not None and t.quantity < 0:
                errors.append(f"{tl}: 'quantity' cannot be negative — removal is "
                              f"its own treatment type, not a negative count.")
            if is_point_only:
                for fname in LINE_ONLY_FIELDS:
                    # Only complain when it was actually set to a non-default.
                    if fname == "travel" and t.travel != "two_way":
                        errors.append(f"{tl}: 'travel' only applies to a line; "
                                      f"this feature is a point.")
                    if fname == "sides" and t.sides != 2:
                        errors.append(f"{tl}: 'sides' only applies to a line; "
                                      f"this feature is a point.")
            if t.status == "proposed":
                if not t.phase:
                    errors.append(f"{tl}: a proposed treatment needs a 'phase'.")
                elif phase_ids and t.phase not in phase_ids:
                    errors.append(f"{tl}: phase {t.phase!r} is not declared in "
                                  f"the top-level 'phases' list.")
            elif t.phase and t.phase not in phase_ids:
                errors.append(f"{tl}: phase {t.phase!r} is not declared in the "
                              f"top-level 'phases' list.")
            for u in t.upgrades:
                if u == t.id:
                    errors.append(f"{tl}: a treatment cannot upgrade itself.")
                elif u not in treatment_ids:
                    errors.append(f"{tl}: 'upgrades' references unknown "
                                  f"treatment id {u!r}.")

    errors.extend(_upgrade_loop_errors(net))
    return errors


def _upgrade_loop_errors(net: Network) -> List[str]:
    by_id = {t.id: t for _, t in net.treatments() if t.id}
    out = []
    for f, t in net.treatments():
        seen, stack = {t.id}, list(t.upgrades)
        while stack:
            cur = stack.pop()
            if cur in seen:
                out.append(f"{f.name or f.id} / {t.type}: 'upgrades' chain "
                           f"forms a loop.")
                break
            seen.add(cur)
            nxt = by_id.get(cur)
            if nxt:
                stack.extend(nxt.upgrades)
    return out


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #
def _treatment_dict(t: Treatment, defaults: dict) -> dict:
    out: dict = {"id": t.id, "type": t.type}
    if t.status != defaults.get("status"):
        out["status"] = t.status
    if t.phase and t.phase != defaults.get("phase"):
        out["phase"] = t.phase
    if t.authority and t.authority != defaults.get("authority"):
        out["authority"] = t.authority
    if t.travel != "two_way":
        out["travel"] = t.travel
    if t.sides != 2:
        out["sides"] = t.sides
    if t.side:
        out["side"] = t.side
    if t.quantity is not None:
        out["quantity"] = t.quantity
    if t.upgrades:
        out["upgrades"] = list(t.upgrades)
    if t.proposed_by:
        out["proposed_by"] = t.proposed_by
    if t.notes:
        out["notes"] = t.notes
    if t.tags:
        out["tags"] = dict(t.tags)
    return out


def _feature_dict(f: Feature) -> dict:
    out: dict = {"id": f.id, "name": f.name}
    for key, value in (("on_street", f.on_street), ("start", f.start),
                       ("end", f.end), ("notes", f.notes)):
        if value:
            out[key] = value
    # Hoist a field to the feature when EVERY treatment agrees on it, so a
    # single-treatment feature reads as it did in v1.
    defaults: dict = {}
    if f.treatments:
        for key in ("status", "phase", "authority"):
            values = {getattr(t, key) for t in f.treatments}
            if len(values) == 1:
                only = values.pop()
                if only:
                    defaults[key] = only
    out.update(defaults)
    out["treatments"] = [_treatment_dict(t, defaults) for t in f.treatments]
    if f.tags:
        out["tags"] = dict(f.tags)
    out["geometry"] = [[[round(lat, 6), round(lon, 6)] for lat, lon in part]
                       for part in f.geometry]
    return out


def _area_dict(a: Area) -> dict:
    out: dict = {"id": a.id, "name": a.name, "kind": a.kind}
    if a.context:
        out["context"] = a.context
    if a.default_authority:
        out["default_authority"] = a.default_authority
    if a.updated:
        out["updated"] = a.updated
    if a.contributors:
        out["contributors"] = list(a.contributors)
    if a.tags:
        out["tags"] = dict(a.tags)
    if a.boundary:
        out["boundary"] = [[[[round(lat, 6), round(lon, 6)] for lat, lon in ring]
                            for ring in poly] for poly in a.boundary]
    return out


def _phase_dict(p: PhaseDef) -> dict:
    out: dict = {"id": p.id, "number": p.number}
    if p.label:
        out["label"] = p.label
    if p.target_date:
        out["target_date"] = p.target_date
    if p.tags:
        out["tags"] = dict(p.tags)
    return out


class _QuotedStr(str):
    """A string that must survive YAML's implicit timestamp/int types."""


def _quoted_representer(dumper, data):
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style="'")


yaml.SafeDumper.add_representer(_QuotedStr, _quoted_representer)


def serialize_network(net: Network) -> str:
    """Serialize to YAML text with a stable key order — reading a file,
    changing one thing and writing it back must produce a one-line diff."""
    doc: dict = {
        "format": FORMAT_ID,
        "format_version": FORMAT_VERSION,
        "crs": net.crs or CRS,
        "units": net.units or "metric",
    }
    if net.meta:
        doc["meta"] = dict(net.meta)
    doc["areas"] = [_area_dict(a) for a in net.areas]
    if net.authorities:
        doc["authorities"] = [
            {k: v for k, v in
             (("id", a.id), ("name", a.name), ("level", a.level), ("note", a.note))
             if v} for a in net.authorities]
    if net.phases:
        doc["phases"] = [_phase_dict(p) for p in
                         sorted(net.phases, key=lambda p: p.number)]
    if net.costs:
        doc["costs"] = dict(net.costs)
    doc["features"] = [_feature_dict(f) for f in net.features]
    # Keys this version doesn't interpret, carried through untouched.
    for k, v in net.extra.items():
        doc.setdefault(k, v)

    doc = _quote_dates(doc)
    header = ("# Bike network — written by bike-network-builder; re-importable there\n"
              "# and readable by any YAML tool. Geometry points are [latitude,\n"
              "# longitude] in degrees (WGS84). See NETWORK_FORMAT.md.\n")
    return header + yaml.safe_dump(doc, sort_keys=False, default_flow_style=None,
                                   allow_unicode=True, width=100)


def _quote_dates(doc: dict) -> dict:
    """Force every date-ish value to a quoted string on the way out. Without
    this, `2029-12-31` round-trips as a date object in PyYAML and a
    UTC-midnight Date in js-yaml — a day early anywhere west of UTC."""
    for phase in doc.get("phases") or []:
        if phase.get("target_date"):
            phase["target_date"] = _QuotedStr(phase["target_date"])
    for area in doc.get("areas") or []:
        if area.get("updated"):
            area["updated"] = _QuotedStr(area["updated"])
    meta = doc.get("meta")
    if isinstance(meta, dict):
        for key in ("created", "updated"):
            if meta.get(key):
                meta[key] = _QuotedStr(_to_date_string(meta[key]))
    return doc
