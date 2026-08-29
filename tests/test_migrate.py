"""Upgrading a v1 file to v2.

Import only. The upgrade is mechanical except for phase dates, which is the
single place a UI has to ask (V2_PLAN.md §4.10). The v1 fixture below is kept
DELIBERATELY: if every file in the repo were v2, the shim would stop being
tested the day it was written, and it has to keep working for years.
"""
import yaml

from bikenetwork.migrate import (MUNICIPAL_AUTHORITY, STATE_AUTHORITY,
                                 apply_phase_dates, parse_v1_deadline,
                                 phases_needing_dates, upgrade_v1)
from bikenetwork.network_format import parse_network, serialize_network, validate_network

V1 = """
format: malden-bike-network
format_version: 1
city: Malden
state: Massachusetts
ordinance_chapter: Ch. 12.XX
phases:
  - phase: 1
    label: Core Network
    deadline: December 31, 2029
  - phase: 2
    label: Connectors
    deadline: End of FY32
paths:
  - name: Main Street
    type: quick_build_separated
    status: proposed
    jurisdiction: city
    id: main-qb
    phase: 1
    directions: 2
    on_street: Main Street
    from: Main Street & Salem Street
    to: Main Street & Pleasant Street
    notes: Downtown spine.
    geometry:
      - [42.428104, -71.071734]
      - [42.426829, -71.07253]
  - name: Main Street (rebuilt)
    type: concrete_separated
    status: proposed
    jurisdiction: city
    upgrades: main-qb
    phase: 2
    geometry:
      - [42.428104, -71.071734]
      - [42.426829, -71.07253]
  - name: Broadway
    treatment: buffered_painted
    status: existing
    jurisdiction: state
    directions: 1
    geometry:
      - - [42.42, -71.06]
        - [42.43, -71.06]
      - - [42.44, -71.06]
        - [42.45, -71.06]
spots:
  - name: Malden Square racks
    kind: bike_parking
    status: existing
    jurisdiction: city
    location: [42.4262, -71.0664]
"""


def upgraded():
    return upgrade_v1(yaml.safe_load(V1))


# --------------------------------------------------------------------------
# Detection and the whole-file path
# --------------------------------------------------------------------------
def test_parse_network_upgrades_a_v1_file_transparently():
    net = parse_network(V1)
    assert net.format_version == 2
    assert validate_network(net) == []


def test_a_v1_file_is_detected_by_its_format_id_or_its_version():
    for header in ("format: malden-bike-network\nformat_version: 1\n",
                   "format: bike-network\nformat_version: 1\n"):
        net = parse_network(header + "city: X\npaths: []\n")
        assert net.format_version == 2


# --------------------------------------------------------------------------
# City/state -> area; jurisdiction -> authorities
# --------------------------------------------------------------------------
def test_city_and_state_become_one_area():
    net = parse_network(V1)
    assert len(net.areas) == 1
    assert net.areas[0].name == "Malden"
    assert net.areas[0].context == "Massachusetts"
    assert net.areas[0].display_name == "Malden, Massachusetts"


def test_jurisdiction_becomes_a_declared_authority():
    net = parse_network(V1)
    assert net.authority(MUNICIPAL_AUTHORITY).name == "Malden"
    assert net.authority(MUNICIPAL_AUTHORITY).level == "municipal"
    assert net.authority(STATE_AUTHORITY).level == "state"
    by_name = {f.name: f for f in net.features}
    assert by_name["Main Street"].treatments[0].authority == MUNICIPAL_AUTHORITY
    assert by_name["Broadway"].treatments[0].authority == STATE_AUTHORITY


# --------------------------------------------------------------------------
# Paths -> features + treatments
# --------------------------------------------------------------------------
def test_each_path_becomes_a_feature_with_one_treatment():
    net = parse_network(V1)
    main = next(f for f in net.features if f.name == "Main Street")
    assert len(main.treatments) == 1
    assert main.treatments[0].type == "quick_build_separated"
    assert main.on_street == "Main Street"
    assert main.start == "Main Street & Salem Street"     # v1 `from`
    assert main.end == "Main Street & Pleasant Street"    # v1 `to`


def test_the_v1_treatment_alias_still_reads():
    net = parse_network(V1)
    bway = next(f for f in net.features if f.name == "Broadway")
    assert bway.treatments[0].type == "buffered_painted"


def test_the_old_path_id_lands_on_the_TREATMENT_so_upgrades_still_resolve():
    """v1's `upgrades` referenced a path id; v2's references a treatment id.
    Putting the old id anywhere else would dangle every upgrade in the file."""
    net = parse_network(V1)
    assert net.treatment("main-qb") is not None
    rebuilt = next(f for f in net.features if f.name == "Main Street (rebuilt)")
    assert rebuilt.treatments[0].upgrades == ["main-qb"]
    assert validate_network(net) == []


def test_directions_becomes_travel_and_sides():
    net = parse_network(V1)
    bway = next(f for f in net.features if f.name == "Broadway").treatments[0]
    assert bway.travel == "one_way" and bway.sides == 1
    main = next(f for f in net.features if f.name == "Main Street").treatments[0]
    assert main.travel == "two_way" and main.sides == 2


def test_flat_and_nested_v1_geometry_both_become_parts():
    net = parse_network(V1)
    main = next(f for f in net.features if f.name == "Main Street")
    bway = next(f for f in net.features if f.name == "Broadway")
    assert len(main.geometry) == 1 and len(main.geometry[0]) == 2   # was flat
    assert len(bway.geometry) == 2                                   # was nested
    assert main.geometry_kind == "line" and bway.geometry_kind == "line"


# --------------------------------------------------------------------------
# Spots -> point features
# --------------------------------------------------------------------------
def test_a_spot_becomes_a_point_feature():
    net = parse_network(V1)
    racks = next(f for f in net.features if f.name == "Malden Square racks")
    assert racks.geometry_kind == "point"
    assert racks.points() == [(42.4262, -71.0664)]
    assert racks.treatments[0].type == "bike_parking"      # v1 `kind` alias
    assert racks.treatments[0].status == "existing"


# --------------------------------------------------------------------------
# Phases and the one interactive step
# --------------------------------------------------------------------------
def test_a_parseable_deadline_becomes_a_target_date():
    net = parse_network(V1)
    core = next(p for p in net.phases if p.number == 1)
    assert core.target_date == "2029-12-31"
    assert core.label == "Core Network"


def test_an_unparseable_deadline_is_kept_verbatim_in_tags():
    """The conversion is lossless even where it is lossy."""
    net = parse_network(V1)
    connectors = next(p for p in net.phases if p.number == 2)
    assert connectors.target_date == ""
    assert connectors.tags["deadline_v1"] == "End of FY32"


def test_phases_needing_dates_reports_only_the_ones_that_did_not_parse():
    assert phases_needing_dates(yaml.safe_load(V1)) == [(2, "End of FY32")]


def test_apply_phase_dates_fills_in_what_a_human_chose():
    raw = apply_phase_dates(upgraded(), {2: "2032-06-30"})
    net = parse_network(yaml.safe_dump(raw))
    assert next(p for p in net.phases if p.number == 2).target_date == "2032-06-30"


def test_declining_to_pick_a_date_leaves_the_phase_without_one():
    """Nothing is invented on the user's behalf."""
    raw = apply_phase_dates(upgraded(), {2: ""})
    net = parse_network(yaml.safe_dump(raw))
    assert next(p for p in net.phases if p.number == 2).target_date == ""


def test_paths_reference_phases_by_id_after_the_upgrade():
    net = parse_network(V1)
    main = next(f for f in net.features if f.name == "Main Street")
    assert main.treatments[0].phase == "phase-1"
    assert net.phase_map()["phase-1"].number == 1


# --------------------------------------------------------------------------
# Deadline parsing
# --------------------------------------------------------------------------
def test_deadline_parsing_recognises_what_the_tool_wrote_and_gives_up_otherwise():
    assert parse_v1_deadline("December 31, 2029") == "2029-12-31"
    assert parse_v1_deadline("December 2029") == "2029-12"
    assert parse_v1_deadline("2029") == "2029"
    assert parse_v1_deadline("2029-12") == "2029-12"
    assert parse_v1_deadline("2029-12-31") == "2029-12-31"
    assert parse_v1_deadline("End of 2029") == "2029"
    # Guessing here would invent precision nobody agreed to.
    assert parse_v1_deadline("End of FY32") is None
    assert parse_v1_deadline("when funding allows") is None
    assert parse_v1_deadline("") is None


# --------------------------------------------------------------------------
# Preservation
# --------------------------------------------------------------------------
def test_unknown_v1_keys_ride_along_untouched():
    net = parse_network(V1)
    assert yaml.safe_load(serialize_network(net))["ordinance_chapter"] == "Ch. 12.XX"


def test_the_upgrade_is_stable_when_run_on_its_own_output():
    once = parse_network(V1)
    twice = parse_network(serialize_network(once))
    assert serialize_network(once) == serialize_network(twice)


def test_the_v1_fixture_upgrades_and_validates():
    """tests/fixtures/v1_network.yaml is Malden's real pre-v2 network, kept
    FOREVER. If every file in the repo were v2 the shim would stop being tested
    the day it was written, and it has to keep working for years."""
    from bikenetwork.place import ROOT
    net = parse_network(
        (ROOT / "tests" / "fixtures" / "v1_network.yaml").read_text(encoding="utf-8"))
    assert validate_network(net) == []
    assert len(net.features) == 29


def test_upgrading_the_v1_fixture_reproduces_the_v2_fixture_exactly():
    """The upgrade is deterministic — two people upgrading the same file get
    byte-identical output, which is what makes their work mergeable."""
    from bikenetwork.place import ROOT
    fx = ROOT / "tests" / "fixtures"
    upgraded = serialize_network(
        parse_network((fx / "v1_network.yaml").read_text(encoding="utf-8")))
    assert upgraded == (fx / "v2_network.yaml").read_text(encoding="utf-8")
