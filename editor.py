#!/usr/bin/env python3
"""Bike network builder — a small local web app to design a bike network by
hand (drag lines on a map, edit properties in a panel) and regenerate the maps.

    python editor.py            # opens http://127.0.0.1:5000 in your browser

It reads/writes ONE file, `network.yaml` (the editable source of truth, in the
shared format described in NETWORK_FORMAT.md). The browser AUTOSAVES to it a
second or so after every edit (there is no Save button), so a crash loses at
most a moment of work. The Export menu produces network.yaml / map.png /
map.html / network.geojson; Import loads (and validates) someone else's
network.yaml.
"""
from __future__ import annotations

import io
import json
import sys
import threading
import webbrowser
import zipfile
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from bikenetwork.boundary import build_polygon, clip_polyline_latlon
from bikenetwork.costs import COST_PER_MILE
from bikenetwork.geojson import paths_from_geojson, paths_to_geojson
from bikenetwork.network_format import (JURISDICTIONS, PATH_TYPES, STATUSES,
                                        Network, PhaseDef, parse_network,
                                        serialize_network, validate_network)
from bikenetwork.osm import OverpassClient
from bikenetwork.pipeline import render_all
from bikenetwork.render_map import COLOR_MODES
from bikenetwork.routing import load_street_graph, snap_route

if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent

NETWORK_FILE = ROOT / "network.yaml"            # editable source of truth
SEED_FILE = ROOT / "output" / "network.yaml"    # produced by build.py
# Checked-in starting point when neither exists: the infrastructure that is
# already built or funded, with no proposed additions — a blank canvas that
# still shows what Malden has today.
BASE_FILE = ROOT / "data" / "base_network.yaml"
BOUNDARY_FILE = ROOT / "data" / "malden_boundary.geojson"
STREET_GRAPH_CACHE = ROOT / "data" / "street_graph.json"
OUTPUT = ROOT / "output"

# Lazily-loaded, then kept in memory for instant snapping.
_STREET_GRAPH = None
_BOUNDARY_POLYGON = None

app = Flask(__name__, static_folder=str(ROOT / "editor"), static_url_path="/editor")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def load_network() -> Network:
    """Load the editable network, seeding it from the last build — or, for a
    fresh user, from the checked-in existing+funded base network."""
    if NETWORK_FILE.exists():
        return parse_network(NETWORK_FILE.read_text(encoding="utf-8"))
    for seed in (SEED_FILE, BASE_FILE):
        if seed.exists():
            NETWORK_FILE.write_text(seed.read_text(encoding="utf-8"),
                                    encoding="utf-8")
            return parse_network(NETWORK_FILE.read_text(encoding="utf-8"))
    return Network()


def config_for_browser(net: Network) -> dict:
    return {
        "city": net.city,
        "phases": [{"phase": p.number, "label": p.label, "deadline": p.deadline}
                   for p in sorted(net.phases, key=lambda p: p.number)],
    }


def network_from_browser(data: dict, existing: Network) -> Network:
    """Merge the browser's network + config payload into a Network, keeping
    fields the UI doesn't edit (state, ordinance_chapter) from the file."""
    cfg = data.get("config") or {}
    phases = []
    for p in cfg.get("phases", []):
        try:
            num = int(p["phase"])
        except (KeyError, TypeError, ValueError):
            continue
        phases.append(PhaseDef(number=num, label=p.get("label", f"Phase {num}"),
                               deadline=p.get("deadline", "")))
    return Network(
        city=cfg.get("city", existing.city),
        state=existing.state,
        ordinance_chapter=existing.ordinance_chapter,
        phases=phases or existing.phases,
        paths=paths_from_geojson(data.get("network") or {}),
    )


def load_boundary_latlon():
    if not BOUNDARY_FILE.exists():
        return []
    fc = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    rings = []
    for feat in fc.get("features", []):
        coords = feat.get("geometry", {}).get("coordinates", [])
        ring = [[lat, lon] for lon, lat in coords]
        if len(ring) >= 2:
            rings.append(ring)
    return rings


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/help")
def help_page():
    """Renders editor/help.md — the user-facing manual — as a web page."""
    return send_from_directory(app.static_folder, "help.html")


@app.route("/api/state")
def api_state():
    net = load_network()
    return jsonify({
        "network": paths_to_geojson(net.paths),
        "config": config_for_browser(net),
        "boundary": load_boundary_latlon(),
        "options": {
            "types": list(PATH_TYPES),
            "statuses": list(STATUSES),
            "jurisdictions": list(JURISDICTIONS),
            "color_modes": list(COLOR_MODES),
            # Live cost estimation happens client-side from these rates
            # (adjust them in bikenetwork/costs.py).
            "cost_per_mile": {t: list(v) for t, v in COST_PER_MILE.items()},
        },
    })


@app.route("/api/state", methods=["POST"])
def api_save():
    data = request.get_json(force=True)
    if data.get("network") is not None:
        net = network_from_browser(data, load_network())
        NETWORK_FILE.write_text(serialize_network(net), encoding="utf-8")
    return jsonify({"ok": True})


@app.route("/api/import", methods=["POST"])
def api_import():
    """Validate an uploaded network.yaml — or a .zip bundle containing one —
    and return it as browser state. Nothing touches disk — the user reviews
    the import and then saves (autosave)."""
    data = request.get_data() or b""
    try:
        if data[:4] == b"PK\x03\x04":  # a zip (e.g. our own export bundle)
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = [n for n in z.namelist()
                         if n.lower().endswith((".yaml", ".yml"))
                         and not n.endswith("/")]
                if not names:
                    return jsonify({"ok": False, "errors": [
                        "The zip file doesn't contain a .yaml network file."]}), 400
                # Prefer a file actually called network.yaml, else first match.
                name = next((n for n in names
                             if n.split("/")[-1] == "network.yaml"), names[0])
                text = z.read(name).decode("utf-8")
        else:
            text = data.decode("utf-8")
        net = parse_network(text)
    except Exception as e:  # yaml.YAMLError / ValueError
        return jsonify({"ok": False, "errors": [f"Not parseable as YAML: {e}"]}), 400
    errors = validate_network(net)
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400
    return jsonify({"ok": True, "network": paths_to_geojson(net.paths),
                    "config": config_for_browser(net)})


@app.route("/api/export/network.yaml")
def api_export_yaml():
    """The current network.yaml as a download. The browser saves first, so this
    is always the latest state."""
    net = load_network()
    return Response(serialize_network(net), mimetype="application/yaml", headers={
        "Content-Disposition": "attachment; filename=network.yaml"})


@app.route("/api/export/bundle.zip", methods=["POST"])
def api_export_bundle():
    """Everything in one download: save the posted state, regenerate the maps
    with the requested color mode, and zip network.yaml + map.png + map.html +
    network.geojson."""
    api_save()
    net = load_network()
    boundary = [[(lat, lon) for lat, lon in ring] for ring in load_boundary_latlon()]
    color_mode = request.args.get("color_mode", "type")
    if color_mode not in COLOR_MODES:
        color_mode = "type"
    basemap = bool(request.args.get("basemap", "1") != "0")
    render_all(net, boundary, OUTPUT, basemap=basemap, color_mode=color_mode)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("network.yaml", serialize_network(net))
        for name in ("map.png", "map.html", "network.geojson"):
            z.write(OUTPUT / name, name)
    buf.seek(0)
    return Response(buf.read(), mimetype="application/zip", headers={
        "Content-Disposition": "attachment; filename=bike-network.zip"})


def get_street_graph():
    """Load the street graph (cached on disk + in memory)."""
    global _STREET_GRAPH
    if _STREET_GRAPH is None:
        _STREET_GRAPH = load_street_graph(
            STREET_GRAPH_CACHE, lambda: OverpassClient().full_street_graph())
    return _STREET_GRAPH


def get_boundary_polygon():
    global _BOUNDARY_POLYGON
    if _BOUNDARY_POLYGON is None:
        rings = [[(lat, lon) for lat, lon in ring] for ring in load_boundary_latlon()]
        _BOUNDARY_POLYGON = build_polygon(rings) if rings else False
    return _BOUNDARY_POLYGON


@app.route("/api/snap", methods=["POST"])
def api_snap():
    """Snap drawn waypoints to the street network and clip to the city boundary,
    so the path follows real roads and ends at the city limit."""
    pts = (request.get_json(force=True) or {}).get("points", [])
    if len(pts) < 2:
        return jsonify({"points": pts})
    try:
        adj, coord = get_street_graph()
    except Exception as e:
        return jsonify({"points": pts, "error": f"street graph unavailable: {e}"}), 200
    route = snap_route(pts, adj, coord)
    polygon = get_boundary_polygon()
    if polygon:
        clipped, _ = clip_polyline_latlon(route, polygon)
        if len(clipped) >= 2:
            route = clipped
    return jsonify({"points": [[lat, lon] for lat, lon in route]})


@app.route("/api/regenerate", methods=["POST"])
def api_regenerate():
    # Save first (so the browser's current edits are what we render).
    api_save()
    net = load_network()
    boundary = [[(lat, lon) for lat, lon in ring] for ring in load_boundary_latlon()]
    basemap = bool(request.args.get("basemap", "1") != "0")
    color_mode = request.args.get("color_mode", "type")
    if color_mode not in COLOR_MODES:
        color_mode = "type"
    summary = render_all(net, boundary, OUTPUT, basemap=basemap,
                         color_mode=color_mode)
    return jsonify({"ok": True, "summary": summary})


@app.route("/outputs/<path:name>")
def outputs(name):
    return send_from_directory(OUTPUT, name)


def _open_browser(url):
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()


if __name__ == "__main__":
    url = "http://127.0.0.1:5000"
    print(f"Bike network builder running at {url}  (Ctrl+C to stop)")
    _open_browser(url)
    app.run(host="127.0.0.1", port=5000, debug=False)
