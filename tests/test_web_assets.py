"""The web app (web/) ships copies of the repo's data files as static assets.
Copies must stay byte-identical to the canonical ones (git stores identical
blobs once, so this costs nothing).

Also here: the CROSS-IMPLEMENTATION parity checks. Python and JS each carry a
reader for the format and an assembler for boundary rings, and they have to
agree — that second reading of the spec is what has kept the format honest, and
it is the reason build.py survived the retirement of the Python editor."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.parametrize("name", [
    "place.json",
    "treatments.json",
    "malden_boundary.geojson",
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


def _node():
    """The node binary, or None when it isn't installed. Parity tests skip
    rather than fail so `python -m pytest` still works on a machine that only
    has the Python side."""
    import shutil
    return shutil.which("node")


def _run_node(script: str) -> str:
    import subprocess
    proc = subprocess.run([_node(), "--input-type=module", "-e", script],
                          cwd=os.path.join(ROOT, "web"),
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


@pytest.mark.skipif(_node() is None, reason="node is not installed")
def test_ring_assembly_agrees_between_python_and_js():
    """bikenetwork/boundary.py and web/js/boundary.js both chain raw ways into
    rings now that shapely is gone. On the real Malden boundary — 5 ways of
    very different lengths — they must produce identical geometry."""
    from bikenetwork.boundary import boundary_from_ways

    fc = json.loads(open(os.path.join(ROOT, "data", "malden_boundary.geojson"),
                         encoding="utf-8").read())
    ways = [[(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
            for f in fc["features"]]
    py = [[[[round(lat, 9), round(lon, 9)] for lat, lon in ring] for ring in poly]
          for poly in boundary_from_ways(ways)]

    js = json.loads(_run_node("""
      import fs from "node:fs";
      const B = await import("./js/boundary.js");
      const fc = JSON.parse(fs.readFileSync("data/malden_boundary.geojson", "utf8"));
      const ways = fc.features.map(
        (f) => f.geometry.coordinates.map(([lon, lat]) => [lat, lon]));
      const b = B.boundaryFromWays(ways).map(
        (poly) => poly.map((ring) => ring.map(
          ([lat, lon]) => [Math.round(lat * 1e9) / 1e9, Math.round(lon * 1e9) / 1e9])));
      console.log(JSON.stringify(b));
    """))
    assert py == js, "Python and JS assembled different boundary rings"


@pytest.mark.skipif(_node() is None, reason="node is not installed")
def test_python_reads_what_js_writes():
    """Serialization parity: JS serializes the shipped network, Python parses
    it, and every field and coordinate matches what Python itself holds."""
    from bikenetwork.network_format import parse_network

    js_yaml = _run_node("""
      import fs from "node:fs";
      await import("./js/migrate.js");
      const NF = await import("./js/network_format.js");
      const net = NF.parseNetwork(
        fs.readFileSync("../tests/fixtures/v2_network.yaml", "utf8"));
      process.stdout.write(NF.serializeNetwork(net));
    """)
    from_js = parse_network(js_yaml)
    from_py = parse_network(open(os.path.join(ROOT, "tests", "fixtures",
                                              "v2_network.yaml"),
                                 encoding="utf-8").read())

    assert [a.id for a in from_js.areas] == [a.id for a in from_py.areas]
    assert [a.name for a in from_js.areas] == [a.name for a in from_py.areas]
    assert [p.id for p in from_js.phases] == [p.id for p in from_py.phases]
    assert [p.target_date for p in from_js.phases] == [
        p.target_date for p in from_py.phases]
    assert len(from_js.features) == len(from_py.features)
    for a, b in zip(from_js.features, from_py.features):
        assert (a.id, a.name, a.on_street, a.start, a.end) == (
               b.id, b.name, b.on_street, b.start, b.end)
        assert a.geometry == b.geometry
        assert len(a.treatments) == len(b.treatments)
        for ta, tb in zip(a.treatments, b.treatments):
            assert (ta.id, ta.type, ta.status, ta.phase, ta.authority,
                    ta.travel, ta.sides, ta.side, ta.quantity, ta.upgrades) == (
                   tb.id, tb.type, tb.status, tb.phase, tb.authority,
                   tb.travel, tb.sides, tb.side, tb.quantity, tb.upgrades)
