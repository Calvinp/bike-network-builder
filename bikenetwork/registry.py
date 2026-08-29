"""The treatment registry: what the tool can represent.

`data/treatments.json` — not the format spec — holds the vocabulary. That is
what makes "adding a bus lane is a registry entry, not a spec change" literally
true (V2_PLAN.md §4.5).

Two rules carry most of the weight:

* **Unknown treatments degrade, they don't fail.** A file written by a newer
  tool still opens: the unknown treatment draws neutrally, contributes nothing
  to costs or bike totals, and is reported so the UI can say so. Structure is
  still strict — a malformed geometry or a dangling reference is an error.
* **`stack_rank` is draw order only, never semantics.** A feature draws EVERY
  treatment it carries, lowest rank first so the highest ends up on top.
  Nothing may treat `treatments[0]` as primary: list order is declared
  insignificant precisely so an `arrangement:` key stays reachable later.

`web/js/registry.js` is the browser's reader for the same file.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
KM_PER_MILE = 1.609344

# Where an unknown treatment sorts: after everything shipped, so a file from a
# newer tool can't reorder what this one draws underneath.
UNKNOWN_RANK = 10_000


@dataclass
class Treatment:
    id: str
    label: str = ""
    category: str = "other"
    measure: str = "counted"          # "linear" | "counted"
    unit: str = ""
    geometry: Tuple[str, ...] = ("point", "line")
    cost: Optional[dict] = None
    style: dict = field(default_factory=dict)
    unknown: bool = False

    # -- rendering --------------------------------------------------------
    @property
    def color(self) -> str:
        return self.style.get("color", "")

    @property
    def glyph(self) -> str:
        return self.style.get("glyph", "")

    @property
    def stack_rank(self) -> int:
        return int(self.style.get("stack_rank", UNKNOWN_RANK))

    # -- semantics --------------------------------------------------------
    def applies_to(self, geometry_kind: str) -> bool:
        return geometry_kind in self.geometry

    @property
    def is_bike(self) -> bool:
        """Whether this counts toward the bicycle lane-distance headline. A
        transit or greening treatment on the same corridor must not inflate it."""
        return self.category == "bike"

    @property
    def cost_per_km(self) -> Optional[Tuple[int, int]]:
        rng = (self.cost or {}).get("per_km")
        return (rng[0], rng[1]) if rng else None

    @property
    def cost_per_unit(self) -> Optional[Tuple[int, int]]:
        rng = (self.cost or {}).get("per_unit")
        return (rng[0], rng[1]) if rng else None


def unknown_treatment(treatment_id: str) -> Treatment:
    """A placeholder for an id this version doesn't know. Readable label, no
    cost (never invent a figure), neutral style, and it applies to any geometry
    so it can still be drawn wherever the file put it."""
    return Treatment(
        id=treatment_id,
        label=str(treatment_id).replace("_", " ").replace(":", ": "),
        category="unknown",
        measure="counted",
        unit="items",
        geometry=("point", "line"),
        cost=None,
        style={"color": "#8c8c8c", "glyph": "?", "stack_rank": UNKNOWN_RANK},
        unknown=True,
    )


class Registry:
    def __init__(self, treatments: Sequence[Treatment], version: int = 1):
        self._by_id: Dict[str, Treatment] = {t.id: t for t in treatments}
        self.version = version

    @classmethod
    def from_doc(cls, doc: dict) -> "Registry":
        out = []
        for raw in (doc or {}).get("treatments") or []:
            if not isinstance(raw, dict) or not raw.get("id"):
                continue
            out.append(Treatment(
                id=str(raw["id"]),
                label=str(raw.get("label", "") or ""),
                category=str(raw.get("category", "other") or "other"),
                measure=str(raw.get("measure", "counted") or "counted"),
                unit=str(raw.get("unit", "") or ""),
                geometry=tuple(raw.get("geometry") or ("point", "line")),
                cost=raw.get("cost"),
                style=dict(raw.get("style") or {}),
            ))
        return cls(out, version=int((doc or {}).get("registry_version", 1) or 1))

    # -- lookup -----------------------------------------------------------
    def get(self, treatment_id: str) -> Treatment:
        """Always returns a Treatment — a synthesized `unknown` one when the id
        isn't shipped. Callers never have to branch on None."""
        return self._by_id.get(treatment_id) or unknown_treatment(treatment_id)

    def is_known(self, treatment_id: str) -> bool:
        return treatment_id in self._by_id

    def all(self) -> List[Treatment]:
        return list(self._by_id.values())

    def unknown_ids(self, used: Sequence[str]) -> List[str]:
        """The ids in `used` this version doesn't recognise, sorted — the UI
        turns these into "this file uses N kinds of improvement this version
        doesn't know about"."""
        return sorted({t for t in used if t and t not in self._by_id})

    def sorted_for_draw(self, treatment_ids: Sequence[str]) -> List[Treatment]:
        """Treatments in draw order: lowest `stack_rank` first, so the highest
        is drawn last and ends up on top. Ties (only possible among unknowns)
        break on id, so the result never depends on input order."""
        return sorted((self.get(t) for t in treatment_ids),
                      key=lambda t: (t.stack_rank, t.id))


_cached: Optional[Registry] = None


def load_registry(path: Optional[Path] = None) -> Registry:
    """Read the shipped registry (cached). Pass a path to read another."""
    global _cached
    if path is not None:
        return Registry.from_doc(json.loads(Path(path).read_text(encoding="utf-8")))
    if _cached is None:
        doc = json.loads((ROOT / "data" / "treatments.json").read_text(encoding="utf-8"))
        _cached = Registry.from_doc(doc)
    return _cached
