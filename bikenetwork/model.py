"""Parse and validate `corridors.yaml` — the OSM SEED file.

This is the advanced/bootstrap path: corridors are named by their PRECISE
cross-street intersections (e.g. "Main Street & Pleasant Street" — never
neighborhood names) so build.py can resolve real geometry from OpenStreetMap.
The result is written to network.yaml, which the editor then owns.

The file is a mapping: city/state/phases metadata at the top, then a
`corridors:` list of geometry-less paths.
"""
from __future__ import annotations

from typing import List

import yaml

from .network_format import (JURISDICTIONS, PATH_TYPES, STATUSES, Network,
                             network_from_dict)


def parse_seed(text: str) -> Network:
    """Parse corridors.yaml into a Network whose paths have no geometry yet."""
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("corridors.yaml must be a mapping with city/phases "
                         "metadata and a 'corridors:' list.")
    # Same item coercions as the network format; the seed just names its path
    # list 'corridors' and omits geometry.
    raw = dict(raw)
    raw["paths"] = raw.pop("corridors", [])
    return network_from_dict(raw)


def validate_seed(net: Network) -> List[str]:
    """Return human-readable validation errors (empty == valid). Stricter than
    the network format: every corridor must name resolvable OSM intersections."""
    errors: List[str] = []
    seen_names = set()
    for i, c in enumerate(net.paths):
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

        if c.status == "proposed" and (c.phase is None or c.phase < 1):
            errors.append(f"{label}: 'phase' must be a positive integer (got {c.phase!r}).")

        if c.type not in PATH_TYPES:
            errors.append(f"{label}: unknown type {c.type!r}; "
                          f"must be one of {', '.join(PATH_TYPES)}.")
        if c.status not in STATUSES:
            errors.append(f"{label}: unknown status {c.status!r}; "
                          f"must be one of {', '.join(STATUSES)}.")
        if c.directions not in (1, 2):
            errors.append(f"{label}: 'directions' must be 1 or 2 (got {c.directions!r}).")
        if c.jurisdiction not in JURISDICTIONS:
            errors.append(f"{label}: unknown jurisdiction {c.jurisdiction!r}; "
                          f"must be one of {', '.join(JURISDICTIONS)}.")
    return errors
