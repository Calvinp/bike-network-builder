"""Planning-grade construction cost ranges shown live in the editor.

ADJUST HERE for inflation or better local data — the editor UI picks the new
numbers up on the next page load, and exports/help should be regenerated so
they agree. Figures are ORDER-OF-MAGNITUDE ranges per corridor-mile (one mile
of street treated, regardless of how many directions of facility it carries),
drawn from published quick-build / separated-lane cost literature.

The static web editor has a JS copy of this table (web/js/costs.js) — if you
update one, update the other, or the two editors' live estimates will disagree.
"""
from __future__ import annotations

from typing import Dict, Tuple

# path type -> (low $/corridor-mile, high $/corridor-mile)
COST_PER_MILE: Dict[str, Tuple[int, int]] = {
    # Flex posts, paint, precast curb, planters. Cheap and fast — the heart of
    # a quick-build program.
    "quick_build_separated": (150_000, 500_000),
    # Permanent raised / concrete-protected lane (usually with reconstruction).
    "concrete_separated": (1_000_000, 3_500_000),
    # Off-street shared-use path construction.
    "shared_use_path": (1_000_000, 3_000_000),
    # Painted + buffer (interim treatment only).
    "buffered_painted": (50_000, 150_000),
    # Traffic-calmed shared street: signs, pavement markings, speed humps,
    # occasional diverters — no separated facility to build.
    "neighborway": (50_000, 250_000),
    # Car-free / car-light street conversion. Low end: bollards, planters,
    # signage over existing pavement. High end: full plaza-grade rebuild.
    # VERIFY against comparable local projects before publishing figures.
    "pedestrianized": (250_000, 2_000_000),
}
