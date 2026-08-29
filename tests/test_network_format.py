"""The v2 format: areas, authorities, features, treatments.

v2 is the ONE compatibility break (V2_PLAN.md §4.2), so this file pins the
things that break and the invariants that must survive it:

  * a feature is a PLACE, a treatment is a FACILITY (§4.3)
  * geometry is a list of parts; one coordinate is a point, two or more a line
  * `target_date` is a QUOTED string in both YAML implementations (§4.7)
  * ids are one shared namespace and always assigned (§4.9)
  * round-trip stability: read, change one thing, write — one thing changes
"""
import pytest
import yaml

from bikenetwork.network_format import (FORMAT_ID, FORMAT_VERSION, LEGACY_FORMAT_ID,
                                        STATUSES, Area, Authority, Feature, Network,
                                        PhaseDef, Treatment, new_id, parse_network,
                                        serialize_network, superseded_ids,
                                        validate_network)

MINIMAL = """
format: bike-network
format_version: 2
areas:
  - id: test-area
    name: Testville
phases:
  - id: core
    number: 1
    label: Core
    target_date: '2029'
features:
  - id: f1
    name: Main Street
    treatments:
      - id: t1
        type: quick_build_separated
        status: proposed
        phase: core
    geometry:
      - [[10.0, 20.0], [10.01, 20.01]]
"""


def net():
    return parse_network(MINIMAL)


# --------------------------------------------------------------------------
# Identity and version
# --------------------------------------------------------------------------
def test_v2_is_the_declared_format():
    assert FORMAT_ID == "bike-network"
    assert FORMAT_VERSION == 2
    assert LEGACY_FORMAT_ID == "malden-bike-network"


def test_a_v2_file_round_trips_through_parse_and_serialize():
    a = net()
    b = parse_network(serialize_network(a))
    assert serialize_network(a) == serialize_network(b)


def test_serialize_writes_the_v2_header_keys():
    doc = yaml.safe_load(serialize_network(net()))
    assert doc["format"] == "bike-network"
    assert doc["format_version"] == 2
    assert doc["crs"] == "EPSG:4326"
    assert doc["units"] == "metric"


# --------------------------------------------------------------------------
# Feature vs treatment: the dividing rule
# --------------------------------------------------------------------------
def test_a_feature_describes_the_place_and_a_treatment_the_facility():
    f = net().features[0]
    assert f.name == "Main Street"           # place
    assert f.treatments[0].type == "quick_build_separated"   # facility
    assert f.treatments[0].status == "proposed"


def test_treatment_fields_inherit_from_the_feature_when_omitted():
    """So the common single-treatment case stays short."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: core, number: 1}]
features:
  - id: f1
    name: X
    status: existing
    authority: cityhall
    treatments:
      - {id: t1, type: shared_use_path}
      - {id: t2, type: street_trees, status: proposed, phase: core}
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
""")
    a, b = n.features[0].treatments
    assert a.status == "existing" and a.authority == "cityhall"   # inherited
    assert b.status == "proposed" and b.authority == "cityhall"   # own status


def test_one_feature_can_carry_several_treatments_in_different_phases():
    """A corridor that gets a bike lane now and a streetcar later is ONE
    feature with two treatments, not two features with duplicated geometry."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p4, number: 4}]
features:
  - id: f1
    name: Northern Strand
    treatments:
      - {id: t1, type: shared_use_path, status: existing}
      - {id: t2, type: streetcar, status: proposed, phase: p4}
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
""")
    f = n.features[0]
    assert len(f.treatments) == 2
    assert {t.phase for t in f.treatments} == {None, "p4"}


# --------------------------------------------------------------------------
# Geometry: parts, points and lines
# --------------------------------------------------------------------------
def test_a_one_coordinate_part_is_a_point_and_two_is_a_line():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: Corner
    treatments: [{id: t1, type: bike_parking, status: existing}]
    geometry: [[[10.0, 20.0]]]
  - id: f2
    name: Street
    treatments: [{id: t2, type: shared_use_path, status: existing}]
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
""")
    point, line = n.features
    assert point.geometry_kind == "point" and point.is_point
    assert line.geometry_kind == "line" and not line.is_point
    assert point.points() == [(10.0, 20.0)]
    assert line.lines() == [[(10.0, 20.0), (10.01, 20.01)]]


def test_a_feature_may_mix_points_and_lines():
    """Scattered trees plus a continuous row is one feature."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: Trees
    treatments: [{id: t1, type: street_trees, status: existing}]
    geometry:
      - [[10.0, 20.0]]
      - [[10.02, 20.0], [10.03, 20.0]]
""")
    f = n.features[0]
    assert f.geometry_kind == "mixed"
    assert len(f.points()) == 1 and len(f.lines()) == 1


def test_geometry_is_never_polymorphic_on_the_way_out():
    """v1 sniffed flat-vs-nested; v2 always nests, so a consumer that assumes
    one shape can't be surprised by a combined feature."""
    doc = yaml.safe_load(serialize_network(net()))
    geom = doc["features"][0]["geometry"]
    assert isinstance(geom, list) and isinstance(geom[0], list)
    assert isinstance(geom[0][0], list) and len(geom[0][0]) == 2


# --------------------------------------------------------------------------
# Dates: the YAML timestamp trap
# --------------------------------------------------------------------------
@pytest.mark.parametrize("written,expected", [
    ("'2029'", "2029"),
    ("'2029-12'", "2029-12"),
    ("'2029-12-31'", "2029-12-31"),
    ("2029", "2029"),               # bare int, coerced back to a string
    ("2029-12-31", "2029-12-31"),   # bare date, coerced back to a string
])
def test_target_date_is_always_a_string_however_it_was_written(written, expected):
    n = parse_network(f"""
format: bike-network
format_version: 2
areas: [{{id: a, name: A}}]
phases: [{{id: core, number: 1, target_date: {written}}}]
features: []
""")
    assert n.phases[0].target_date == expected
    assert isinstance(n.phases[0].target_date, str)


def test_target_date_serializes_quoted_so_it_never_becomes_a_date_again():
    """An unquoted 2029-12-31 is a date object in PyYAML and a UTC-midnight
    Date in js-yaml, which renders as December 30 west of UTC."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: core, number: 1, target_date: '2029-12-31'}]
features: []
""")
    text = serialize_network(n)
    assert "target_date: '2029-12-31'" in text
    assert isinstance(yaml.safe_load(text)["phases"][0]["target_date"], str)


def test_a_phase_needs_no_target_date():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: core, number: 1}]
features: []
""")
    assert n.phases[0].target_date == ""
    assert "target_date" not in yaml.safe_load(serialize_network(n))["phases"][0]


# --------------------------------------------------------------------------
# Identity: one shared namespace, always assigned
# --------------------------------------------------------------------------
def test_ids_are_assigned_to_anything_missing_one():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{name: A}]
phases: [{number: 1}]
features:
  - name: X
    treatments: [{type: shared_use_path, status: existing}]
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
""")
    assert n.areas[0].id and n.phases[0].id
    assert n.features[0].id and n.features[0].treatments[0].id


def test_duplicate_ids_anywhere_are_an_error():
    """One namespace: a feature and a treatment cannot share an id, because a
    reference never says what kind of thing it points at."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: dup, name: A}]
phases: [{id: core, number: 1}]
features:
  - id: dup
    name: X
    treatments: [{id: t1, type: shared_use_path, status: existing}]
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
""")
    assert any("duplicate id" in e for e in validate_network(n))


def test_new_id_is_collision_resistant():
    assert len({new_id() for _ in range(2000)}) == 2000


# --------------------------------------------------------------------------
# Upgrades: a list, referencing treatments
# --------------------------------------------------------------------------
def test_upgrades_is_a_list_so_a_rebuild_can_consolidate_segments():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p2, number: 2}]
features:
  - id: f1
    name: A bit
    treatments: [{id: qa, type: quick_build_separated, status: proposed, phase: p1}]
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
  - id: f2
    name: Another bit
    treatments: [{id: qb, type: quick_build_separated, status: proposed, phase: p1}]
    geometry: [[[10.01, 20.0], [10.02, 20.0]]]
  - id: f3
    name: The whole corridor, rebuilt
    treatments:
      - {id: cc, type: concrete_separated, status: proposed, phase: p2,
         upgrades: [qa, qb]}
    geometry: [[[10.0, 20.0], [10.02, 20.0]]]
""")
    assert validate_network(n) == []
    assert superseded_ids(n) == {"qa", "qb"}


def test_upgrades_accepts_a_bare_string_for_convenience():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p2, number: 2}]
features:
  - id: f1
    name: X
    treatments:
      - {id: qa, type: quick_build_separated, status: proposed, phase: p1}
      - {id: cc, type: concrete_separated, status: proposed, phase: p2, upgrades: qa}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert n.features[0].treatments[1].upgrades == ["qa"]
    assert superseded_ids(n) == {"qa"}


def test_a_dangling_upgrade_reference_is_an_error():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p2, number: 2}]
features:
  - id: f1
    name: X
    treatments:
      - {id: cc, type: concrete_separated, status: proposed, phase: p2,
         upgrades: [nope]}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert any("unknown" in e and "nope" in e for e in validate_network(n))


def test_an_upgrade_loop_is_an_error():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p2, number: 2}]
features:
  - id: f1
    name: X
    treatments:
      - {id: t1, type: quick_build_separated, status: proposed, phase: p1, upgrades: [t2]}
      - {id: t2, type: concrete_separated, status: proposed, phase: p2, upgrades: [t1]}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert any("loop" in e for e in validate_network(n))


# --------------------------------------------------------------------------
# Vocabulary: strict where it changes arithmetic, lenient where it doesn't
# --------------------------------------------------------------------------
def test_the_status_vocabulary_is_closed_and_includes_under_construction():
    assert STATUSES == ("existing", "under_construction", "funded", "proposed")


def test_an_unknown_status_is_an_error_because_it_changes_the_arithmetic():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: X
    treatments: [{id: t1, type: shared_use_path, status: someday}]
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert any("status" in e and "someday" in e for e in validate_network(n))


def test_an_unknown_treatment_type_is_NOT_an_error():
    """A file from a newer tool still opens; the treatment is reported, drawn
    neutrally and left out of the totals."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: X
    treatments: [{id: t1, type: 'transit:bus_lane', status: existing}]
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert validate_network(n) == []
    assert n.unknown_treatment_types() == ["transit:bus_lane"]


# --------------------------------------------------------------------------
# Structure is still strict
# --------------------------------------------------------------------------
def test_geometry_with_no_coordinates_is_an_error():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features: [{id: f1, name: X, treatments: [{id: t1, type: other}], geometry: []}]
""")
    assert any("geometry" in e for e in validate_network(n))


def test_a_feature_with_no_treatments_is_an_error():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features: [{id: f1, name: X, treatments: [], geometry: [[[1.0, 2.0]]]}]
""")
    assert any("treatment" in e for e in validate_network(n))


def test_a_proposed_treatment_needs_a_declared_phase():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: core, number: 1}]
features:
  - id: f1
    name: X
    treatments: [{id: t1, type: shared_use_path, status: proposed, phase: nope}]
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert any("phase" in e and "nope" in e for e in validate_network(n))


def test_a_line_only_field_on_a_point_is_an_error():
    """`travel` and `sides` describe a line. Only a NON-DEFAULT value is
    flagged: a mixed feature may legitimately set them at the feature level,
    and an explicit `two_way` is indistinguishable from the default anyway."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: X
    treatments: [{id: t1, type: bike_parking, status: existing, travel: one_way}]
    geometry: [[[10.0, 20.0]]]
""")
    assert any("travel" in e for e in validate_network(n))


def test_side_is_allowed_on_a_point_because_it_is_descriptive_there():
    """Which side of the street a tree is on is worth recording; it just never
    moves the drawn position, since the coordinates already say where it is."""
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: A tree
    treatments: [{id: t1, type: street_trees, status: existing, side: north_side}]
    geometry: [[[10.0, 20.0]]]
""")
    assert any("side" in e for e in validate_network(n))     # not a known value
    n2 = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: A tree
    treatments: [{id: t1, type: street_trees, status: existing, side: right}]
    geometry: [[[10.0, 20.0]]]
""")
    assert validate_network(n2) == []


def test_a_newer_format_version_is_rejected():
    n = parse_network("format: bike-network\nformat_version: 99\nareas: []\nfeatures: []\n")
    assert any("newer" in e for e in validate_network(n))


# --------------------------------------------------------------------------
# travel / sides / side  (replacing v1 `directions`)
# --------------------------------------------------------------------------
def test_travel_and_sides_are_separate_so_a_two_way_track_on_one_side_fits():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
features:
  - id: f1
    name: Spot Pond Brook Greenway
    treatments:
      - {id: t1, type: shared_use_path, status: proposed, phase: p,
         travel: two_way, sides: 1, side: right}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
phases: [{id: p, number: 1}]
""")
    t = n.features[0].treatments[0]
    assert t.travel == "two_way" and t.sides == 1 and t.side == "right"


def test_defaults_match_the_common_case():
    t = net().features[0].treatments[0]
    assert t.travel == "two_way" and t.sides == 2 and t.side == ""


# --------------------------------------------------------------------------
# quantity
# --------------------------------------------------------------------------
def test_a_counted_treatment_can_carry_a_quantity():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
phases: [{id: p, number: 1}]
features:
  - id: f1
    name: Main Street
    treatments:
      - {id: t1, type: parking_removal, status: proposed, phase: p, quantity: 12}
      - {id: t2, type: street_trees, status: proposed, phase: p, quantity: 34}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    assert [t.quantity for t in n.features[0].treatments] == [12, 34]


# --------------------------------------------------------------------------
# tags: the pressure-release valve
# --------------------------------------------------------------------------
def test_tags_survive_a_round_trip_untouched_everywhere_they_are_allowed():
    n = parse_network("""
format: bike-network
format_version: 2
crs: 'EPSG:4326'
areas: [{id: a, name: A, tags: {gnis: '12345'}}]
phases: [{id: p, number: 1, tags: {deadline_v1: End of FY35}}]
features:
  - id: f1
    name: X
    tags: {source: osm, city_project_id: TIP-12345}
    treatments:
      - {id: t1, type: shared_use_path, status: existing, tags: {width_m: 2.4}}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
""")
    out = yaml.safe_load(serialize_network(n))
    assert out["areas"][0]["tags"] == {"gnis": "12345"}
    assert out["phases"][0]["tags"] == {"deadline_v1": "End of FY35"}
    assert out["features"][0]["tags"]["city_project_id"] == "TIP-12345"
    assert out["features"][0]["treatments"][0]["tags"] == {"width_m": 2.4}


def test_empty_tags_are_omitted_so_plain_files_stay_plain():
    assert "tags" not in yaml.safe_load(serialize_network(net()))["features"][0]


# --------------------------------------------------------------------------
# Areas, authorities, meta, costs
# --------------------------------------------------------------------------
def test_areas_carry_a_multipolygon_boundary():
    n = parse_network("""
format: bike-network
format_version: 2
areas:
  - id: a
    name: A
    boundary:
      - - [[10.0, 20.0], [10.0, 21.0], [11.0, 21.0], [11.0, 20.0], [10.0, 20.0]]
        - [[10.4, 20.4], [10.4, 20.6], [10.6, 20.6], [10.6, 20.4], [10.4, 20.4]]
features: []
""")
    boundary = n.areas[0].boundary
    assert len(boundary) == 1 and len(boundary[0]) == 2      # outer + hole
    from bikenetwork.boundary import point_in_boundary
    assert point_in_boundary(10.2, 20.2, boundary)
    assert not point_in_boundary(10.5, 20.5, boundary)       # in the hole


def test_authorities_are_declared_not_enumerated():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A, default_authority: dcr}]
authorities:
  - {id: dcr, name: DCR, level: special, note: parkways}
  - {id: nassau, name: Nassau County DPW, level: county}
features: []
""")
    assert n.authority("dcr").name == "DCR"
    assert n.authority("nassau").level == "county"
    assert n.authority("unheard-of").name == "unheard-of"   # never blank


def test_an_unknown_authority_level_is_an_error():
    n = parse_network("""
format: bike-network
format_version: 2
areas: [{id: a, name: A}]
authorities: [{id: x, name: X, level: galactic}]
features: []
""")
    assert any("level" in e for e in validate_network(n))


def test_meta_and_costs_survive_a_round_trip():
    n = parse_network("""
format: bike-network
format_version: 2
units: metric
meta:
  title: A plan
  license: ODbL-1.0
  contributors: [{name: MSS, kind: organization}]
  generated_by: {tool: claude-opus-5, automated: true}
areas: [{id: a, name: A}]
costs:
  currency: USD
  by_area:
    a: {multiplier: 1.15}
features: []
""")
    out = yaml.safe_load(serialize_network(n))
    assert out["meta"]["title"] == "A plan"
    assert out["meta"]["generated_by"]["automated"] is True
    assert out["costs"]["by_area"]["a"]["multiplier"] == 1.15
    assert out["costs"]["currency"] == "USD"


def test_units_default_to_metric_and_only_metric_is_implemented():
    assert net().units == "metric"
    n = parse_network("format: bike-network\nformat_version: 2\nunits: cubits\n"
                      "areas: []\nfeatures: []\n")
    assert any("units" in e for e in validate_network(n))


# --------------------------------------------------------------------------
# Round-trip stability (the agent guarantee)
# --------------------------------------------------------------------------
def test_changing_one_field_changes_one_line():
    before = serialize_network(net())
    n = net()
    n.features[0].name = "Renamed Street"
    after = serialize_network(n)
    diff = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
    assert len(diff) == 1
    assert "Renamed Street" in diff[0][1]


def test_unknown_top_level_keys_are_preserved():
    """`ordinance_chapter` is the motivating case: carried through untouched,
    never interpreted."""
    n = parse_network(MINIMAL + "ordinance_chapter: Ch. 12.XX\n")
    assert yaml.safe_load(serialize_network(n))["ordinance_chapter"] == "Ch. 12.XX"
