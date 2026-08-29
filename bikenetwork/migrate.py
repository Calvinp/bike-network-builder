"""Upgrade a v1 network file to v2.

Import only — the tool never writes v1, and there is no downgrade export
(V2_PLAN.md §4.10).

Everything here is mechanical except the phase dates: v1's `deadline` was free
text, and v2 wants a sortable `target_date`. Whatever parses is converted;
whatever doesn't is kept verbatim in the phase's `tags` (as `deadline_v1`) so
the conversion is lossless even where it is lossy, and `phases_needing_dates()`
reports the rest so a UI can ask. That is the single interactive step in the
whole upgrade — everything else runs silently.

Ids are assigned DETERMINISTICALLY (`f-1`, `t-1`, ... and `f-s1` for spots),
not randomly: two people upgrading the same v1 file must end up with the same
ids, or their files could never be merged. A v1 path that already carried an
`id` keeps it, because that is what its `upgrades` references point at.

The v1 shape, for reference:

    format: malden-bike-network
    format_version: 1
    city / state
    phases: [{phase: 1, label, deadline}]
    paths:  [{name, type|treatment, status, jurisdiction, id, upgrades, phase,
              directions, on_street, from, to, notes, geometry}]
    spots:  [{name, type|kind, status, jurisdiction, phase, location, notes}]
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .network_format import _s, _to_int

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}

# v1 jurisdiction -> the authority ids the shim synthesizes.
MUNICIPAL_AUTHORITY = "local"
STATE_AUTHORITY = "state-dot"


def parse_v1_deadline(text: str) -> Optional[str]:
    """Turn v1's free-text deadline into `YYYY[-MM[-DD]]`, or None.

    Deliberately conservative: it recognises the shapes the tool itself wrote
    ("December 31, 2029") and obvious ISO-ish ones, and gives up on anything
    else rather than guessing a date nobody agreed to.
    """
    s = _s(text)
    if not s:
        return None
    iso = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", s)
    if iso:
        return "-".join(p for p in iso.groups() if p)
    m = re.fullmatch(r"([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})", s)
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    m = re.fullmatch(r"([A-Za-z]+)\s+(\d{4})", s)
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(3) if False else m.group(2)}-{MONTHS[m.group(1).lower()]:02d}"
    m = re.fullmatch(r"(?:end of\s+)?(\d{4})", s, flags=re.I)
    if m:
        return m.group(1)
    return None


def phases_needing_dates(raw: dict) -> List[Tuple[int, str]]:
    """[(phase_number, the original words), ...] for v1 phases whose deadline
    didn't parse. A UI shows these and asks; headless callers can ignore them
    and the phase simply has no target date."""
    out = []
    for item in raw.get("phases") or []:
        if not isinstance(item, dict):
            continue
        text = _s(item.get("deadline"))
        if text and parse_v1_deadline(text) is None:
            out.append((_to_int(item.get("phase"), default=0) or 0, text))
    return out


def _geometry_v1_to_parts(raw_geom) -> list:
    """v1 `geometry` was polymorphic: a flat point list meant one segment, a
    nested list meant several. v2 always nests."""
    if not isinstance(raw_geom, (list, tuple)) or not raw_geom:
        return []
    first = raw_geom[0]
    nested = (isinstance(first, (list, tuple)) and first
              and isinstance(first[0], (list, tuple)))
    return [list(seg) for seg in raw_geom] if nested else [list(raw_geom)]


def _authority_for(jurisdiction: str) -> str:
    return STATE_AUTHORITY if _s(jurisdiction) == "state" else MUNICIPAL_AUTHORITY


def _travel_and_sides(directions) -> tuple:
    """v1 `directions` conflated "how many facilities" with "which way you can
    ride": 2 = one each way, 1 = a single one-way facility. Neither could
    express a two-way track on one side, which is why v2 splits them."""
    return ("one_way", 1) if _to_int(directions, default=2) == 1 else ("two_way", 2)


def upgrade_v1(raw: dict) -> dict:
    """A v1 mapping -> a v2 mapping. Pure; does not touch the filesystem."""
    city = _s(raw.get("city"), "Unnamed area")
    state = _s(raw.get("state"))

    area_id = "area-" + re.sub(r"[^a-z0-9]+", "-", city.lower()).strip("-")
    area = {"id": area_id, "name": city, "kind": "municipality"}
    if state:
        area["context"] = state
    area["default_authority"] = MUNICIPAL_AUTHORITY

    authorities = [
        {"id": MUNICIPAL_AUTHORITY, "name": city or "The municipality",
         "level": "municipal"},
        {"id": STATE_AUTHORITY,
         "name": f"{state} DOT" if state else "The state DOT", "level": "state"},
    ]

    phases, phase_id_by_number = [], {}
    for item in raw.get("phases") or []:
        if not isinstance(item, dict):
            continue
        number = _to_int(item.get("phase"), default=len(phases) + 1) or 1
        pid = f"phase-{number}"
        phase_id_by_number[number] = pid
        entry = {"id": pid, "number": number}
        if _s(item.get("label")):
            entry["label"] = _s(item.get("label"))
        text = _s(item.get("deadline"))
        parsed = parse_v1_deadline(text) if text else None
        if parsed:
            entry["target_date"] = parsed
        elif text:
            # Keep the original words rather than dropping them: the upgrade is
            # lossless even where it can't be exact.
            entry["tags"] = {"deadline_v1": text}
        phases.append(entry)

    features = []
    for index, item in enumerate(raw.get("paths") or [], start=1):
        if not isinstance(item, dict):
            continue
        travel, sides = _travel_and_sides(item.get("directions"))
        upgrades = _s(item.get("upgrades"))
        phase_num = _to_int(item.get("phase"), default=None)
        treatment = {
            # v1's path `id` was what `upgrades` referenced, and in v2 upgrades
            # reference TREATMENTS — so the old id belongs here, not on the
            # feature, or every upgrade reference would dangle.
            "id": _s(item.get("id")) or f"t-{index}",
            "type": _s(item.get("type")) or _s(item.get("treatment"), "other"),
            "status": _s(item.get("status"), "proposed"),
            "authority": _authority_for(item.get("jurisdiction")),
        }
        if phase_num and phase_num in phase_id_by_number:
            treatment["phase"] = phase_id_by_number[phase_num]
        if travel != "two_way":
            treatment["travel"] = travel
        if sides != 2:
            treatment["sides"] = sides
        if upgrades:
            treatment["upgrades"] = [upgrades]

        feature = {"id": f"f-{index}", "name": _s(item.get("name"))}
        for src, dst in (("on_street", "on_street"), ("from", "start"),
                         ("to", "end"), ("notes", "notes")):
            if _s(item.get(src)):
                feature[dst] = _s(item.get(src))
        feature["treatments"] = [treatment]
        feature["geometry"] = _geometry_v1_to_parts(item.get("geometry"))
        features.append(feature)

    for index, item in enumerate(raw.get("spots") or [], start=1):
        if not isinstance(item, dict):
            continue
        loc = item.get("location")
        if not (isinstance(loc, (list, tuple)) and len(loc) == 2):
            continue
        phase_num = _to_int(item.get("phase"), default=None)
        treatment = {
            "id": f"t-s{index}",
            "type": _s(item.get("type")) or _s(item.get("kind"), "other"),
            "status": _s(item.get("status"), "proposed"),
            "authority": _authority_for(item.get("jurisdiction")),
        }
        if phase_num and phase_num in phase_id_by_number:
            treatment["phase"] = phase_id_by_number[phase_num]
        feature = {"id": f"f-s{index}",
                   "name": _s(item.get("name")) or _s(item.get("type"), "Spot"),
                   "treatments": [treatment],
                   "geometry": [[list(loc)]]}
        if _s(item.get("notes")):
            feature["notes"] = _s(item.get("notes"))
        features.append(feature)

    out = {
        "format": "bike-network",
        "format_version": 2,
        "crs": "EPSG:4326",
        "units": "metric",
        "areas": [area],
        "authorities": authorities,
        "phases": phases,
        "features": features,
    }
    # Anything v1 carried that v2 doesn't interpret rides along untouched
    # (`ordinance_chapter` is the motivating case).
    for key, value in raw.items():
        if key not in ("format", "format_version", "city", "state",
                       "phases", "paths", "spots"):
            out.setdefault(key, value)
    return out


def apply_phase_dates(raw_v2: dict, dates: dict) -> dict:
    """Fill in target dates a human supplied: {phase_number: 'YYYY-MM-DD'}.
    An empty or missing value means "no target date", which is a legitimate
    answer — nothing is invented on the user's behalf."""
    for phase in raw_v2.get("phases") or []:
        chosen = _s(dates.get(phase.get("number")))
        if chosen:
            phase["target_date"] = chosen
    return raw_v2
