"""The static web editor (web/) ships copies of the repo's data files as
static assets. Copies must stay byte-identical to the canonical ones (git
stores identical blobs once, so this costs nothing), and the precomputed
boundary polygon must match what the generator script produces."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.parametrize("name", [
    "malden_boundary.geojson",
    "base_network.yaml",
    "street_graph.json",
])
def test_web_data_copies_are_identical(name):
    canonical = os.path.join(ROOT, "data", name)
    copy = os.path.join(ROOT, "web", "data", name)
    with open(canonical, "rb") as a, open(copy, "rb") as b:
        assert a.read() == b.read(), (
            f"web/data/{name} has diverged from data/{name} — recopy it "
            f"(the web app ships it as a static asset).")


def _layer_files():
    layers = os.path.join(ROOT, "data", "layers")
    if not os.path.isdir(layers):
        return []
    return sorted(n for n in os.listdir(layers) if not n.startswith("."))


@pytest.mark.parametrize("name", _layer_files())
def test_web_layer_copies_are_identical(name):
    """Discovered, not listed: dropping a new layer into data/layers/ should
    fail here until it is copied to the web app too."""
    canonical = os.path.join(ROOT, "data", "layers", name)
    copy = os.path.join(ROOT, "web", "data", "layers", name)
    assert os.path.exists(copy), (
        f"web/data/layers/{name} is missing — copy it over (the static "
        f"editor fetches its map layers from there).")
    with open(canonical, "rb") as a, open(copy, "rb") as b:
        assert a.read() == b.read(), (
            f"web/data/layers/{name} has diverged from data/layers/{name} — "
            f"recopy it.")


def test_boundary_polygon_matches_generator():
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    try:
        from export_boundary_polygon import exterior_ring_latlon
    finally:
        sys.path.pop(0)
    with open(os.path.join(ROOT, "web", "data",
                           "malden_boundary_polygon.json"),
              encoding="utf-8") as f:
        shipped = json.load(f)
    assert shipped == exterior_ring_latlon(), (
        "web/data/malden_boundary_polygon.json is stale — rerun "
        "tools/export_boundary_polygon.py.")
