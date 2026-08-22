"""Tests for the network.yaml format: parse/serialize round-trip and
validation messages (pure, no network access)."""
import pytest
from bikenetwork.network_format import (BikePath, Network, PhaseDef,
                                        parse_network, serialize_network,
                                        validate_network)


def _net():
    return Network(
        city="Malden", state="Massachusetts", ordinance_chapter="Ch. 12.XX",
        phases=[PhaseDef(1, "Core", "December 31, 2029"),
                PhaseDef(2, "Connectors", "December 31, 2032")],
        paths=[
            BikePath(name="Main Street", type="quick_build_separated",
                     status="proposed", phase=1, on_street="Main Street",
                     frm="Main Street & A", to="Main Street & B",
                     segments=[[(42.42, -71.07), (42.43, -71.06)]]),
            BikePath(name="Northern Strand", type="shared_use_path",
                     status="existing", phase=None,
                     segments=[[(42.41, -71.05), (42.42, -71.04)]]),
            BikePath(name="Broadway", type="concrete_separated",
                     status="proposed", phase=2, jurisdiction="state",
                     directions=1, segments=[[(42.40, -71.05), (42.41, -71.06)]]),
        ],
    )


def test_roundtrip_preserves_everything():
    net = _net()
    out = parse_network(serialize_network(net))
    assert out.city == "Malden" and out.ordinance_chapter == "Ch. 12.XX"
    assert [(p.number, p.label, p.deadline) for p in out.phases] == \
           [(1, "Core", "December 31, 2029"), (2, "Connectors", "December 31, 2032")]
    assert len(out.paths) == 3
    a, b, c = out.paths
    assert a.type == "quick_build_separated" and a.phase == 1
    assert a.segments == [[(42.42, -71.07), (42.43, -71.06)]]
    assert b.status == "existing" and b.phase is None
    assert c.jurisdiction == "state" and c.directions == 1
    assert validate_network(out) == []


def test_duplicate_path_names_are_allowed():
    # Regression guard for the map-export bug: geometry must never be keyed by
    # name, so duplicate names round-trip as distinct paths.
    net = _net()
    for p in net.paths:
        p.name = "New path"
    out = parse_network(serialize_network(net))
    assert len(out.paths) == 3
    assert validate_network(out) == []


def test_parse_accepts_treatment_alias():
    out = parse_network("""
paths:
  - name: Old file
    treatment: buffered_painted
    phase: 1
    geometry: [[42.4, -71.1], [42.5, -71.0]]
phases:
  - {phase: 1, label: Core, deadline: '2029'}
""")
    assert out.paths[0].type == "buffered_painted"


def test_non_mapping_yaml_is_rejected():
    with pytest.raises(ValueError):
        parse_network("- just\n- a\n- list\n")


@pytest.mark.parametrize("mutate,needle", [
    (lambda n: setattr(n.paths[0], "type", "gold_plated"), "type"),
    (lambda n: setattr(n.paths[0], "status", "dreamed"), "status"),
    (lambda n: setattr(n.paths[0], "jurisdiction", "county"), "jurisdiction"),
    (lambda n: setattr(n.paths[0], "directions", 3), "directions"),
    (lambda n: setattr(n.paths[0], "phase", None), "phase"),       # proposed needs one
    (lambda n: setattr(n.paths[0], "phase", 9), "not declared"),   # unknown phase
    (lambda n: setattr(n.paths[0], "segments", [[(42.4, -71.1)]]), "geometry"),
    (lambda n: setattr(n.paths[0], "segments", [[(442.4, -71.1), (42.5, -71.0)]]),
     "out of range"),
    (lambda n: setattr(n.paths[0], "segments",
                       [[(42.4, -71.1), (42.5, -71.0)], [(42.6, -71.2)]]),
     "segment #2"),
    (lambda n: setattr(n.paths[0], "name", ""), "name"),
    (lambda n: setattr(n, "format_id", "spreadsheet"), "format"),
    (lambda n: setattr(n, "format_version", 99), "newer"),
])
def test_validation_catches_bad_fields(mutate, needle):
    net = _net()
    mutate(net)
    errors = validate_network(net)
    assert any(needle in e for e in errors), errors


def test_existing_paths_need_no_phase():
    net = _net()
    assert net.paths[1].phase is None
    assert validate_network(net) == []


def test_geometry_rounds_to_six_decimals():
    net = _net()
    net.paths[0].segments = [[(42.123456789, -71.987654321), (42.5, -71.0)]]
    out = parse_network(serialize_network(net))
    assert out.paths[0].segments[0][0] == (42.123457, -71.987654)


def test_multi_segment_roundtrip():
    # A combined path (e.g. a trail split by street crossings) keeps its
    # segments; single-segment paths serialize in the flat pre-multi form.
    net = _net()
    net.paths[1].segments = [[(42.41, -71.05), (42.42, -71.04)],
                             [(42.43, -71.03), (42.44, -71.02)]]
    text = serialize_network(net)
    out = parse_network(text)
    assert out.paths[1].segments == net.paths[1].segments
    assert validate_network(out) == []
    # Flat serialization for the single-segment neighbors is preserved.
    assert out.paths[0].segments == [[(42.42, -71.07), (42.43, -71.06)]]


def test_neighborway_is_a_valid_type():
    net = _net()
    net.paths[0].type = "neighborway"
    assert validate_network(net) == []


def test_pedestrianized_is_a_valid_type():
    net = _net()
    net.paths[0].type = "pedestrianized"
    assert validate_network(net) == []
