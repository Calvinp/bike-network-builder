"""The treatment registry: what the tool can represent.

The registry, not the format spec, holds the vocabulary. The two rules that
matter are pinned here:

  * An UNKNOWN treatment degrades — neutral style, no cost, out of the totals,
    and flagged — rather than failing an import (V2_PLAN.md 4.1).
  * `stack_rank` is draw order only. Nothing may treat treatments[0] as
    primary, because list order is declared insignificant.
"""
import json

import pytest

from bikenetwork.registry import (KM_PER_MILE, Registry, load_registry,
                                  unknown_treatment)


@pytest.fixture
def reg():
    return load_registry()


def test_a_known_treatment_carries_everything_a_renderer_needs(reg):
    t = reg.get("quick_build_separated")
    assert t.label == "Quick-build separated lane"
    assert t.category == "bike"
    assert t.measure == "linear"
    assert t.color == "#0072B2"
    assert t.applies_to("line") and not t.applies_to("point")
    assert t.cost_per_km[0] < t.cost_per_km[1]


def test_an_unknown_treatment_degrades_instead_of_failing(reg):
    t = reg.get("transit:bus_lane")
    assert t.unknown is True
    assert t.label == "transit: bus lane"       # readable, not a crash
    assert t.category == "unknown"
    assert t.cost_per_km is None                # never invents a figure
    assert t.applies_to("line") and t.applies_to("point")
    assert reg.is_known("transit:bus_lane") is False


def test_unknown_ids_are_reported_so_the_ui_can_say_so(reg):
    used = ["quick_build_separated", "transit:bus_lane", "streetcar", "bollards"]
    assert reg.unknown_ids(used) == ["streetcar", "transit:bus_lane"]


def test_only_bike_treatments_count_toward_bike_lane_totals(reg):
    """The lane-mile headline is the tool's most public number; a bus lane
    must not inflate it."""
    assert reg.get("quick_build_separated").category == "bike"
    assert reg.get("pedestrianized").category != "bike"
    assert reg.get("street_trees").category != "bike"
    assert reg.get("transit:bus_lane").category != "bike"


def test_counted_treatments_declare_a_unit_and_linear_ones_do_not(reg):
    trees = reg.get("street_trees")
    assert trees.measure == "counted" and trees.unit == "trees"
    lane = reg.get("shared_use_path")
    assert lane.measure == "linear" and lane.unit == ""


def test_removal_is_just_a_registry_entry(reg):
    """No `removes: true` flag, no negative numbers — the thing being removed
    is a treatment with a quantity like any other."""
    t = reg.get("parking_removal")
    assert t.measure == "counted" and t.unit == "spaces"
    assert t.category == "parking"


def test_stack_rank_orders_treatments_deterministically(reg):
    """Two files listing the same treatments in different orders must render
    identically — that is what makes 'order is insignificant' true rather than
    merely stated."""
    a = reg.sorted_for_draw(["concrete_separated", "street_trees", "bollards"])
    b = reg.sorted_for_draw(["bollards", "concrete_separated", "street_trees"])
    assert [t.id for t in a] == [t.id for t in b]
    # Lowest rank first: it is drawn first, so the highest ends up on top.
    assert [t.stack_rank for t in a] == sorted(t.stack_rank for t in a)


def test_unknown_treatments_sort_last_and_stay_stable(reg):
    a = reg.sorted_for_draw(["zzz_unknown", "quick_build_separated"])
    b = reg.sorted_for_draw(["quick_build_separated", "zzz_unknown"])
    assert [t.id for t in a] == [t.id for t in b]


def test_costs_are_metric_and_convert_back_to_the_documented_dollars(reg):
    """Rates are stored per kilometre because v2 stores metric, but they are
    exact conversions of the published per-mile figures — so the imperial
    display still reads $150K-$500K, not $149K-$501K."""
    low, high = reg.get("quick_build_separated").cost_per_km
    assert round(low * KM_PER_MILE, -3) == 150_000
    assert round(high * KM_PER_MILE, -3) == 500_000
    lo2, hi2 = reg.get("concrete_separated").cost_per_km
    assert round(lo2 * KM_PER_MILE, -3) == 1_000_000
    assert round(hi2 * KM_PER_MILE, -3) == 3_500_000


def test_uncosted_treatments_report_nothing_rather_than_zero(reg):
    """Zero would read as 'free'. None reads as 'we don't know', which is
    true — spot treatments have never been costed."""
    assert reg.get("street_trees").cost_per_km is None
    assert reg.get("street_trees").cost_per_unit is None


def test_every_shipped_entry_answers_the_three_questions(reg):
    """The scope guardrail from V2_PLAN.md 11, enforced: category, cost
    (possibly explicitly null), and a way to render."""
    for t in reg.all():
        assert t.category, f"{t.id} has no category"
        assert t.measure in ("linear", "counted"), f"{t.id} has a bad measure"
        assert t.geometry, f"{t.id} declares no geometry kinds"
        assert t.color or t.style.get("glyph"), f"{t.id} has no way to draw"
        assert isinstance(t.stack_rank, int), f"{t.id} has no stack_rank"
        if t.measure == "counted":
            assert t.unit, f"{t.id} is counted but declares no unit"


def test_stack_ranks_are_unique_so_draw_order_is_total(reg):
    ranks = [t.stack_rank for t in reg.all()]
    assert len(ranks) == len(set(ranks)), "duplicate stack_rank: draw order is ambiguous"


def test_ids_are_unique(reg):
    ids = [t.id for t in reg.all()]
    assert len(ids) == len(set(ids))


def test_a_registry_can_be_built_from_a_document_for_tests(reg):
    """A caller can supply its own registry — that is what makes 'adding a
    treatment is a data change' literally true."""
    custom = Registry.from_doc({"treatments": [
        {"id": "bus_lane", "label": "Bus lane", "category": "transit",
         "measure": "linear", "geometry": ["line"],
         "cost": {"per_km": [100, 200]}, "style": {"color": "#123456",
                                                   "stack_rank": 5}},
    ]})
    t = custom.get("bus_lane")
    assert t.unknown is False and t.category == "transit"
    assert custom.get("quick_build_separated").unknown is True   # not in this doc


def test_unknown_treatment_helper_is_usable_without_a_registry():
    t = unknown_treatment("mystery")
    assert t.unknown and t.category == "unknown" and t.cost_per_km is None


def test_the_shipped_file_is_valid_json_with_a_version():
    from bikenetwork.place import ROOT
    doc = json.loads((ROOT / "data" / "treatments.json").read_text(encoding="utf-8"))
    assert doc["registry_version"] >= 1
    assert len(doc["treatments"]) > 10
