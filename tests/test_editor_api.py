"""Tests for the editor's Flask API: state load/save, YAML/zip import
validation, and YAML/zip export (offline — no snapping, no basemap)."""
import io
import json
import zipfile

import pytest

import editor
from bikenetwork.network_format import parse_network, serialize_network

VALID_YAML = """
format: malden-bike-network
format_version: 1
city: Malden
phases:
  - {phase: 1, label: Core, deadline: 'December 31, 2029'}
paths:
  - name: Main Street
    type: quick_build_separated
    status: proposed
    jurisdiction: city
    phase: 1
    directions: 2
    geometry: [[42.42, -71.07], [42.43, -71.06]]
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(editor, "NETWORK_FILE", tmp_path / "network.yaml")
    monkeypatch.setattr(editor, "SEED_FILE", tmp_path / "no-seed.yaml")
    monkeypatch.setattr(editor, "BASE_FILE", tmp_path / "no-base.yaml")
    monkeypatch.setattr(editor, "OUTPUT", tmp_path / "output")
    monkeypatch.setattr(editor, "LAYERS_DIR", tmp_path / "layers")
    editor.app.config["TESTING"] = True
    return editor.app.test_client()


def test_fresh_user_starts_from_base_network(client, tmp_path, monkeypatch):
    # No saved network, no build output -> the checked-in existing+funded
    # base network is the starting point (and becomes the saved file).
    base = tmp_path / "base.yaml"
    base.write_text(VALID_YAML.replace("status: proposed", "status: existing")
                    .replace("    phase: 1\n", ""), encoding="utf-8")
    monkeypatch.setattr(editor, "BASE_FILE", base)
    state = client.get("/api/state").get_json()
    assert len(state["network"]["features"]) == 1
    assert state["network"]["features"][0]["properties"]["status"] == "existing"
    assert (tmp_path / "network.yaml").exists()


def test_state_serves_cost_rates(client, tmp_path):
    (tmp_path / "network.yaml").write_text(VALID_YAML, encoding="utf-8")
    rates = client.get("/api/state").get_json()["options"]["cost_per_mile"]
    assert "quick_build_separated" in rates
    # Every path type must carry a usable rate — a type missing from
    # costs.py silently estimates $0 in the totals card.
    from bikenetwork.network_format import PATH_TYPES
    for t in PATH_TYPES:
        lo, hi = rates[t]
        assert 0 < lo <= hi, t


def test_state_roundtrip_via_save(client, tmp_path):
    # Start empty, save a network, read it back.
    (tmp_path / "network.yaml").write_text(VALID_YAML, encoding="utf-8")
    state = client.get("/api/state").get_json()
    assert len(state["network"]["features"]) == 1
    assert state["config"]["phases"][0]["label"] == "Core"
    assert "types" in state["options"] and "color_modes" in state["options"]

    # Save it back with an edit (rename + new phase).
    state["network"]["features"][0]["properties"]["name"] = "Renamed"
    payload = {"network": state["network"],
               "config": {"city": "Malden",
                          "phases": state["config"]["phases"]
                          + [{"phase": 2, "label": "More", "deadline": ""}]}}
    assert client.post("/api/state", json=payload).get_json()["ok"]
    net = parse_network((tmp_path / "network.yaml").read_text(encoding="utf-8"))
    assert net.paths[0].name == "Renamed"
    assert [p.number for p in net.phases] == [1, 2]


def test_import_valid_yaml_returns_state_without_writing(client, tmp_path):
    r = client.post("/api/import", data=VALID_YAML,
                    content_type="application/yaml")
    body = r.get_json()
    assert r.status_code == 200 and body["ok"]
    assert body["network"]["features"][0]["properties"]["name"] == "Main Street"
    assert not (tmp_path / "network.yaml").exists()  # import never touches disk


def test_import_invalid_yaml_reports_errors(client):
    bad = VALID_YAML.replace("quick_build_separated", "gold_plated")
    r = client.post("/api/import", data=bad, content_type="application/yaml")
    body = r.get_json()
    assert r.status_code == 400 and not body["ok"]
    assert any("gold_plated" in e for e in body["errors"])


def test_import_garbage_is_a_clean_error(client):
    r = client.post("/api/import", data="]]not yaml{{",
                    content_type="application/yaml")
    assert r.status_code == 400
    assert r.get_json()["errors"]


def test_export_yaml_download(client, tmp_path):
    (tmp_path / "network.yaml").write_text(VALID_YAML, encoding="utf-8")
    r = client.get("/api/export/network.yaml")
    assert r.status_code == 200
    assert "attachment" in r.headers["Content-Disposition"]
    net = parse_network(r.get_data(as_text=True))
    assert net.paths[0].name == "Main Street"


SPOTS_YAML = VALID_YAML + """
spots:
  - {kind: speed_hump, status: proposed, phase: 1, location: [42.425, -71.065]}
  - {name: Square racks, kind: bike_parking, status: existing, location: [42.426, -71.066]}
"""


def test_state_serves_and_saves_spots(client, tmp_path):
    (tmp_path / "network.yaml").write_text(SPOTS_YAML, encoding="utf-8")
    state = client.get("/api/state").get_json()
    assert len(state["spots"]["features"]) == 2
    assert "spot_kinds" in state["options"]
    # Edit a spot and save; it persists to network.yaml.
    state["spots"]["features"][0]["properties"]["kind"] = "raised_crosswalk"
    payload = {"network": state["network"], "spots": state["spots"],
               "config": state["config"]}
    assert client.post("/api/state", json=payload).get_json()["ok"]
    net = parse_network((tmp_path / "network.yaml").read_text(encoding="utf-8"))
    assert net.spots[0].kind == "raised_crosswalk"


def test_save_without_spots_key_preserves_spots(client, tmp_path):
    # A stale cached app.js that doesn't know about spots must not wipe them.
    (tmp_path / "network.yaml").write_text(SPOTS_YAML, encoding="utf-8")
    state = client.get("/api/state").get_json()
    payload = {"network": state["network"], "config": state["config"]}
    assert client.post("/api/state", json=payload).get_json()["ok"]
    net = parse_network((tmp_path / "network.yaml").read_text(encoding="utf-8"))
    assert len(net.spots) == 2


def test_import_returns_spots(client):
    r = client.post("/api/import", data=SPOTS_YAML.encode("utf-8"),
                    content_type="application/octet-stream")
    body = r.get_json()
    assert r.status_code == 200 and body["ok"]
    assert len(body["spots"]["features"]) == 2


def test_export_bundle_zips_everything(client, tmp_path):
    (tmp_path / "network.yaml").write_text(VALID_YAML, encoding="utf-8")
    r = client.post("/api/export/bundle.zip?basemap=0&color_mode=phase", json={})
    assert r.status_code == 200
    assert "attachment" in r.headers["Content-Disposition"]
    with zipfile.ZipFile(io.BytesIO(r.data)) as z:
        # One declared phase with proposed work -> per-phase PNG + animation.
        assert set(z.namelist()) == {"network.yaml", "map.png", "map.html",
                                     "network.geojson", "map-phase-1.png",
                                     "phases.gif"}
        net = parse_network(z.read("network.yaml").decode("utf-8"))
        assert net.paths[0].name == "Main Street"


def _write_layers(tmp_path):
    layers = tmp_path / "layers"
    layers.mkdir()
    (layers / "layers.json").write_text(json.dumps({"layers": [
        {"id": "bike-parking", "label": "Bike parking (existing)",
         "description": "Racks mapped in OpenStreetMap",
         "style": {"color": "#0072B2", "radius": 4},
         "attribution": "© OpenStreetMap contributors",
         "source": "https://overpass-api.de", "fetched": "2026-08-22"},
    ]}), encoding="utf-8")
    (layers / "bike-parking.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"capacity": "8"},
             "geometry": {"type": "Point", "coordinates": [-71.066, 42.426]}},
        ]}), encoding="utf-8")


def test_layers_list_is_empty_without_data(client):
    r = client.get("/api/layers")
    assert r.status_code == 200 and r.get_json() == []


def test_layers_manifest_and_data(client, tmp_path):
    _write_layers(tmp_path)
    listed = client.get("/api/layers").get_json()
    assert [l["id"] for l in listed] == ["bike-parking"]
    assert listed[0]["style"]["color"] == "#0072B2"
    data = client.get("/api/layers/bike-parking").get_json()
    assert data["features"][0]["geometry"]["type"] == "Point"
    # Ids not in the manifest 404 (this also blocks path traversal).
    assert client.get("/api/layers/nope").status_code == 404
    assert client.get("/api/layers/..%2Flayers").status_code == 404


def test_import_accepts_zip_bundle(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("map.png", b"not a real png")
        z.writestr("network.yaml", VALID_YAML)
    r = client.post("/api/import", data=buf.getvalue(),
                    content_type="application/octet-stream")
    body = r.get_json()
    assert r.status_code == 200 and body["ok"]
    assert body["network"]["features"][0]["properties"]["name"] == "Main Street"


def test_import_zip_without_yaml_is_a_clean_error(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("map.png", b"pixels only")
    r = client.post("/api/import", data=buf.getvalue(),
                    content_type="application/octet-stream")
    assert r.status_code == 400
    assert any(".yaml" in e for e in r.get_json()["errors"])


def test_regenerate_renders_outputs(client, tmp_path):
    (tmp_path / "network.yaml").write_text(VALID_YAML, encoding="utf-8")
    # basemap=0 keeps it offline; color_mode flows through to the renderers.
    r = client.post("/api/regenerate?basemap=0&color_mode=type", json={})
    body = r.get_json()
    assert body["ok"]
    assert body["summary"]["total_build_miles"] > 0
    for name in ("map.png", "map.html", "network.geojson"):
        assert (tmp_path / "output" / name).exists(), name
