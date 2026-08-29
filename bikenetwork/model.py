"""Parse and validate `corridors.yaml` — the OSM SEED file.

This is the headless bootstrap path: corridors are named by their PRECISE
cross-street intersections ("Main Street & Pleasant Street" — never
neighbourhood names) so `build.py` can resolve real geometry from
OpenStreetMap.

`corridors.yaml` is build.py's own INPUT, not the interchange format, so it
keeps its familiar v1-ish shape — people have written these by hand.
Converting it to v2 goes through the same `migrate.upgrade_v1` path the file
importer uses, which means there is exactly one conversion to get right and one
place it is tested.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import yaml

from .network_format import STATUSES, Network, network_from_dict
from .registry import load_registry

# corridors.yaml still speaks v1's two-value jurisdiction; the upgrade maps it
# onto declared authorities.
JURISDICTIONS = ("city", "state")


@dataclass
class Corridor:
    """One geometry-less corridor as written in corridors.yaml."""
    name: str = ""
    on_street: str = ""
    frm: str = ""            # the YAML key is `from`, a Python keyword
    to: str = ""
    type: str = "quick_build_separated"
    status: str = "proposed"
    jurisdiction: str = "city"
    phase: Optional[int] = None
    directions: int = 2
    notes: str = ""


@dataclass
class Seed:
    city: str = ""
    state: str = ""
    phases: List[dict] = field(default_factory=list)
    corridors: List[Corridor] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def _int_or_none(value):
    try:
        return None if isinstance(value, bool) else int(value)
    except (TypeError, ValueError):
        return None


def parse_seed(text: str) -> Seed:
    """Parse corridors.yaml. Lenient — run validate_seed() for the errors."""
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("corridors.yaml must be a mapping with city/phases "
                         "metadata and a 'corridors:' list.")
    corridors = []
    for item in raw.get("corridors") or []:
        if not isinstance(item, dict):
            continue
        corridors.append(Corridor(
            name=str(item.get("name", "") or "").strip(),
            on_street=str(item.get("on_street", "") or "").strip(),
            frm=str(item.get("from", "") or "").strip(),
            to=str(item.get("to", "") or "").strip(),
            type=str(item.get("type", item.get("treatment", "")) or "").strip()
                 or "quick_build_separated",
            status=str(item.get("status", "proposed") or "proposed").strip(),
            jurisdiction=str(item.get("jurisdiction", "city") or "city").strip(),
            phase=_int_or_none(item.get("phase")),
            directions=_int_or_none(item.get("directions")) or 2,
            notes=str(item.get("notes", "") or "").strip(),
        ))
    return Seed(
        city=str(raw.get("city", "") or "").strip(),
        state=str(raw.get("state", "") or "").strip(),
        phases=list(raw.get("phases") or []),
        corridors=corridors,
        raw=raw,
    )


def validate_seed(seed: Seed) -> List[str]:
    """Human-readable validation errors (empty == valid). Stricter than the
    network format: every corridor must name resolvable OSM intersections."""
    registry = load_registry()
    errors: List[str] = []
    seen_names = set()
    phase_numbers = {_int_or_none(p.get("phase")) for p in seed.phases
                     if isinstance(p, dict)}

    for i, c in enumerate(seed.corridors):
        label = c.name or f"corridor #{i + 1}"
        for field_name, value in (("name", c.name), ("on_street", c.on_street),
                                  ("from", c.frm), ("to", c.to)):
            if not value:
                errors.append(f"{label}: missing required field '{field_name}'.")

        if c.name in seen_names:
            errors.append(f"{label}: duplicate corridor name — OSM resolution "
                          f"is keyed by name, so names must be unique here.")
        seen_names.add(c.name)

        # Endpoints must reference the corridor street (precision lesson):
        # "Main Street & Pleasant Street" is fine; "Malden Center" is not.
        if c.on_street:
            for end_name, end_val in (("from", c.frm), ("to", c.to)):
                if end_val and c.on_street.lower() not in end_val.lower():
                    errors.append(
                        f"{label}: '{end_name}' = \"{end_val}\" should be a precise "
                        f"intersection on '{c.on_street}' "
                        f"(e.g. \"{c.on_street} & Cross Street\"), not a place name."
                    )

        if c.status == "proposed":
            if c.phase is None or c.phase < 1:
                errors.append(f"{label}: 'phase' must be a positive integer "
                              f"(got {c.phase!r}).")
            elif phase_numbers and c.phase not in phase_numbers:
                errors.append(f"{label}: phase {c.phase} is not declared in the "
                              f"top-level 'phases' list.")

        # The type is checked against the REGISTRY, so a corridors.yaml can use
        # any treatment the deployment knows about — including ones added since
        # this code was written.
        if not registry.is_known(c.type):
            errors.append(f"{label}: unknown type {c.type!r}; it is not in the "
                          f"treatment registry (data/treatments.json).")
        if c.status not in STATUSES:
            errors.append(f"{label}: unknown status {c.status!r}; "
                          f"must be one of {', '.join(STATUSES)}.")
        if c.directions not in (1, 2):
            errors.append(f"{label}: 'directions' must be 1 or 2 "
                          f"(got {c.directions!r}).")
        if c.jurisdiction not in JURISDICTIONS:
            errors.append(f"{label}: unknown jurisdiction {c.jurisdiction!r}; "
                          f"must be one of {', '.join(JURISDICTIONS)}.")
    return errors


def seed_to_network(seed: Seed, geometry_by_name: dict,
                    extra_paths: Optional[List[dict]] = None) -> Network:
    """Assemble a v2 Network from the seed plus resolved geometry.

    `geometry_by_name` maps a corridor name to its parts (a list of point
    lists). Corridors with no geometry are dropped — build.py has already
    recorded a warning for them. `extra_paths` are v1-shaped path mappings
    that already carry geometry (existing / committed infrastructure loaded
    from GeoJSON), appended as-is.

    The conversion runs through `migrate.upgrade_v1`, the same code path the
    file importer uses, so corridors.yaml and a v1 network file can't drift
    apart in how they map onto authorities, phases and treatments.
    """
    from .migrate import upgrade_v1

    paths = []
    for c in seed.corridors:
        parts = geometry_by_name.get(c.name)
        if not parts:
            continue
        paths.append({
            "name": c.name, "type": c.type, "status": c.status,
            "jurisdiction": c.jurisdiction, "phase": c.phase,
            "directions": c.directions, "on_street": c.on_street,
            "from": c.frm, "to": c.to, "notes": c.notes,
            "geometry": parts if len(parts) > 1 else parts[0],
        })
    return network_from_dict(upgrade_v1({
        "city": seed.city, "state": seed.state,
        "phases": seed.phases, "paths": paths + list(extra_paths or []),
    }))
