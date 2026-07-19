"""Tests for parsing and validating corridors.yaml, the OSM seed (pure, no network)."""
import pytest
from bikenetwork.model import parse_seed, validate_seed
from bikenetwork.network_format import BikePath, PATH_TYPES, STATUSES


VALID_YAML = """
city: Malden
phases:
  - phase: 1
    label: Core
    deadline: December 31, 2029
  - phase: 2
    label: Connectors
    deadline: December 31, 2032
corridors:
  - name: Main Street (Pleasant to Salem)
    on_street: Main Street
    from: Main Street & Pleasant Street
    to: Main Street & Salem Street
    phase: 1
    type: quick_build_separated
    status: proposed
    notes: Downtown spine
  - name: Pleasant Street
    on_street: Pleasant Street
    from: Pleasant Street & Main Street
    to: Pleasant Street & Ferry Street
    phase: 2
    type: concrete_separated
    status: proposed
"""


def _wrap(corridor_yaml: str) -> str:
    indented = "\n".join("  " + line for line in corridor_yaml.strip().split("\n"))
    return ("city: Malden\nphases:\n  - {phase: 1, label: Core, deadline: '2029'}\n"
            "  - {phase: 2, label: More, deadline: '2032'}\ncorridors:\n" + indented)


def test_parse_returns_network_of_paths():
    net = parse_seed(VALID_YAML)
    assert net.city == "Malden"
    assert [p.number for p in net.phases] == [1, 2]
    assert len(net.paths) == 2
    assert isinstance(net.paths[0], BikePath)
    assert net.paths[0].on_street == "Main Street"
    assert net.paths[0].frm == "Main Street & Pleasant Street"
    assert net.paths[0].to == "Main Street & Salem Street"
    assert net.paths[0].phase == 1
    assert net.paths[1].type == "concrete_separated"


def test_parse_accepts_legacy_treatment_key():
    net = parse_seed(_wrap("""
- name: Old style
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 1
  treatment: concrete_separated
"""))
    assert net.paths[0].type == "concrete_separated"


def test_parse_defaults_status_to_proposed():
    net = parse_seed(VALID_YAML)
    assert net.paths[1].status == "proposed"  # omitted in YAML


def test_valid_network_has_no_errors():
    assert validate_seed(parse_seed(VALID_YAML)) == []


def test_missing_required_field_is_error():
    net = parse_seed(_wrap("""
- name: Bad
  on_street: Main Street
  from: Main Street & X Street
  phase: 1
  type: quick_build_separated
"""))
    errors = validate_seed(net)
    assert any("'to'" in e for e in errors)


def test_endpoint_must_reference_on_street():
    # The key lesson: endpoints must be precise intersections ON the corridor
    # street, not neighborhood names like "Malden Center".
    net = parse_seed(_wrap("""
- name: Vague
  on_street: Main Street
  from: Malden Center
  to: Main Street & Salem Street
  phase: 1
  type: quick_build_separated
"""))
    errors = validate_seed(net)
    assert any("Malden Center" in e for e in errors)


def test_unknown_type_is_error():
    net = parse_seed(_wrap("""
- name: Bad type
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 1
  type: gold_plated
"""))
    errors = validate_seed(net)
    assert any("type" in e.lower() for e in errors)


def test_non_positive_phase_is_error():
    net = parse_seed(_wrap("""
- name: Bad phase
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 0
  type: quick_build_separated
"""))
    errors = validate_seed(net)
    assert any("phase" in e.lower() for e in errors)


def test_duplicate_names_are_seed_errors():
    # OSM resolution is keyed by name, so the SEED requires unique names
    # (the editor / network format don't).
    net = parse_seed(_wrap("""
- name: Twin
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 1
  type: quick_build_separated
- name: Twin
  on_street: Main Street
  from: Main Street & B Street
  to: Main Street & C Street
  phase: 1
  type: quick_build_separated
"""))
    errors = validate_seed(net)
    assert any("duplicate" in e.lower() for e in errors)


def test_types_and_statuses_exposed():
    assert "quick_build_separated" in PATH_TYPES
    assert "concrete_separated" in PATH_TYPES
    assert "proposed" in STATUSES


def test_jurisdiction_defaults_to_city():
    net = parse_seed(VALID_YAML)
    assert net.paths[0].jurisdiction == "city"


def test_unknown_jurisdiction_is_error():
    net = parse_seed(_wrap("""
- name: Bad juris
  on_street: Broadway
  from: Broadway & A Street
  to: Broadway & B Street
  phase: 1
  type: concrete_separated
  jurisdiction: county
"""))
    errors = validate_seed(net)
    assert any("jurisdiction" in e.lower() for e in errors)


def test_state_jurisdiction_is_valid():
    net = parse_seed(_wrap("""
- name: Broadway (state)
  on_street: Broadway
  from: Broadway & A Street
  to: Broadway & B Street
  phase: 2
  type: concrete_separated
  jurisdiction: state
"""))
    assert net.paths[0].jurisdiction == "state"
    assert validate_seed(net) == []
