"""Tests for parsing and validating corridors.yaml, the OSM seed (pure, no network)."""
import pytest
from bikenetwork.model import parse_seed, validate_seed
from bikenetwork.model import Corridor


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


def test_parse_returns_a_seed_of_corridors():
    seed = parse_seed(VALID_YAML)
    assert seed.city == "Malden"
    assert [p["phase"] for p in seed.phases] == [1, 2]
    assert len(seed.corridors) == 2
    assert isinstance(seed.corridors[0], Corridor)
    assert seed.corridors[0].on_street == "Main Street"
    assert seed.corridors[0].frm == "Main Street & Pleasant Street"
    assert seed.corridors[0].to == "Main Street & Salem Street"
    assert seed.corridors[0].phase == 1
    assert seed.corridors[1].type == "concrete_separated"


def test_parse_accepts_legacy_treatment_key():
    seed = parse_seed(_wrap("""
- name: Old style
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 1
  treatment: concrete_separated
"""))
    assert seed.corridors[0].type == "concrete_separated"


def test_parse_defaults_status_to_proposed():
    seed = parse_seed(VALID_YAML)
    assert seed.corridors[1].status == "proposed"  # omitted in YAML


def test_valid_network_has_no_errors():
    assert validate_seed(parse_seed(VALID_YAML)) == []


def test_missing_required_field_is_error():
    seed = parse_seed(_wrap("""
- name: Bad
  on_street: Main Street
  from: Main Street & X Street
  phase: 1
  type: quick_build_separated
"""))
    errors = validate_seed(seed)
    assert any("'to'" in e for e in errors)


def test_endpoint_must_reference_on_street():
    # The key lesson: endpoints must be precise intersections ON the corridor
    # street, not neighborhood names like "Malden Center".
    seed = parse_seed(_wrap("""
- name: Vague
  on_street: Main Street
  from: Malden Center
  to: Main Street & Salem Street
  phase: 1
  type: quick_build_separated
"""))
    errors = validate_seed(seed)
    assert any("Malden Center" in e for e in errors)


def test_unknown_type_is_error():
    seed = parse_seed(_wrap("""
- name: Bad type
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 1
  type: gold_plated
"""))
    errors = validate_seed(seed)
    assert any("type" in e.lower() for e in errors)


def test_non_positive_phase_is_error():
    seed = parse_seed(_wrap("""
- name: Bad phase
  on_street: Main Street
  from: Main Street & A Street
  to: Main Street & B Street
  phase: 0
  type: quick_build_separated
"""))
    errors = validate_seed(seed)
    assert any("phase" in e.lower() for e in errors)


def test_duplicate_names_are_seed_errors():
    # OSM resolution is keyed by name, so the SEED requires unique names
    # (the editor / network format don't).
    seed = parse_seed(_wrap("""
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
    errors = validate_seed(seed)
    assert any("duplicate" in e.lower() for e in errors)


def test_corridor_types_are_checked_against_the_registry():
    """corridors.yaml can name any treatment the deployment knows about,
    including ones added to data/treatments.json since this code was written."""
    from bikenetwork.registry import load_registry
    reg = load_registry()
    assert reg.is_known("quick_build_separated")
    assert reg.is_known("concrete_separated")
    errors = validate_seed(parse_seed(_wrap("""
- name: X Street
  on_street: X Street
  from: X Street & A Street
  to: X Street & B Street
  phase: 1
  type: not_a_real_treatment
""")))
    assert any("treatment registry" in e for e in errors)


def test_jurisdiction_defaults_to_city():
    seed = parse_seed(VALID_YAML)
    assert seed.corridors[0].jurisdiction == "city"


def test_unknown_jurisdiction_is_error():
    seed = parse_seed(_wrap("""
- name: Bad juris
  on_street: Broadway
  from: Broadway & A Street
  to: Broadway & B Street
  phase: 1
  type: concrete_separated
  jurisdiction: county
"""))
    errors = validate_seed(seed)
    assert any("jurisdiction" in e.lower() for e in errors)


def test_state_jurisdiction_is_valid():
    seed = parse_seed(_wrap("""
- name: Broadway (state)
  on_street: Broadway
  from: Broadway & A Street
  to: Broadway & B Street
  phase: 2
  type: concrete_separated
  jurisdiction: state
"""))
    assert seed.corridors[0].jurisdiction == "state"
    assert validate_seed(seed) == []
