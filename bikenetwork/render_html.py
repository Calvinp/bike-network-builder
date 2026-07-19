"""Render the network to an interactive Leaflet map (folium) as a standalone
HTML file: pan/zoom, real street labels from the basemap, and clickable paths.
This is the best format for reviewing the plan with people. Supports the same
color modes as render_map (phase / type / single).
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

import math

import folium

from .network_format import BikePath, Network
from .render_map import (EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR, STATE_COLOR,
                         TYPE_COLORS, TYPE_LABELS, _phase_color, path_color)

Point = Tuple[float, float]


def render_html(
    paths: List[BikePath],
    net: Network,
    out_path: str | Path,
    boundary: List[List[Point]] | None = None,
    color_mode: str = "type",
) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    phase_map = net.phase_map()

    # Center on the mean of all geometry.
    pts = [pt for p in paths for seg in p.segments for pt in seg]
    center = ([sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]
              if pts else [42.4251, -71.0662])

    m = folium.Map(location=center, zoom_start=14, tiles="CartoDB positron",
                   control_scale=True)

    if boundary:
        b = folium.FeatureGroup(name=f"{net.city} boundary", show=True)
        for ring in boundary:
            folium.PolyLine([[lat, lon] for lat, lon in ring], color="#222222",
                            weight=2, dash_array="8,6", opacity=0.8).add_to(b)
        b.add_to(m)

    # One toggleable layer per legend category (depends on the color mode).
    groups: Dict[str, folium.FeatureGroup] = {}

    def group_for(p: BikePath):
        if p.status == "existing":
            key = "Existing infrastructure"
        elif p.status == "funded":
            key = "Approved / funded (not yet built)"
        elif color_mode == "single":
            key = "Bike network (proposed)"
        elif color_mode == "type":
            key = TYPE_LABELS.get(p.type, p.type.replace("_", " "))
        elif p.jurisdiction == "state":
            key = "On a state road (MassDOT approval needed)"
        else:
            cfg = phase_map.get(p.phase)
            key = (f"Phase {p.phase}: {cfg.label}" if cfg and cfg.label
                   else f"Phase {p.phase}").strip()
        if key not in groups:
            groups[key] = folium.FeatureGroup(name=key, show=True)
        return groups[key]

    for p in paths:
        segs = [s for s in p.segments if len(s) >= 2]
        if not segs:
            continue
        # Leaflet accepts nested latlng lists: one (multi)polyline per path,
        # so a combined trail is a single clickable feature.
        latlon = [[[lat, lon] for lat, lon in seg] for seg in segs]
        color = path_color(p, color_mode)
        if p.status == "existing":
            weight, dash = 4, "6,5"
        elif p.status == "funded":
            weight, dash = 5, "10,4"
        else:
            weight, dash = 6, None
        detail = TYPE_LABELS.get(p.type, p.type.replace("_", " "))
        if p.status == "proposed" and p.phase is not None:
            detail = f"Phase {p.phase} &middot; " + detail
        elif p.status != "proposed":
            detail = f"{p.status.capitalize()} &middot; " + detail
        popup = folium.Popup(
            f"<b>{p.name}</b><br>{p.on_street}<br>{detail}"
            + (f"<br>{p.length_miles:.2f} mi" if p.length_miles else "")
            + (f"<br><i>{p.notes}</i>" if p.notes else ""),
            max_width=300,
        )
        group = group_for(p)
        folium.PolyLine(latlon, color=color, weight=weight, opacity=0.9,
                        dash_array=dash, popup=popup, tooltip=p.name).add_to(group)
        if p.directions == 1:
            # One-way: a rotated chevron marker mid-segment, pointing the
            # drawn way. Plain DivIcon markers — no plugin, and the dark glyph
            # with a white halo stays readable on any background.
            for seg in segs:
                _direction_marker(seg).add_to(group)

    for g in groups.values():
        g.add_to(m)
    folium.LayerControl(collapsed=False).add_to(m)

    m.get_root().html.add_child(folium.Element(_legend_html(net, color_mode, paths)))
    m.save(str(out_path))
    return out_path


def _direction_marker(seg) -> folium.Marker:
    """A '➤' rotated to the travel direction at the segment's midpoint."""
    k = max(1, len(seg) // 2)
    (lat1, lon1), (lat2, lon2) = seg[k - 1], seg[k]
    # Screen angle for CSS rotate(): x = east, y = SOUTH (hence the minus);
    # longitude degrees shrink by cos(lat) relative to latitude degrees.
    dx = (lon2 - lon1) * math.cos(math.radians(lat1))
    theta = math.degrees(math.atan2(-(lat2 - lat1), dx))
    html = (f'<div style="transform:rotate({theta:.0f}deg);font-size:15px;'
            f'font-weight:bold;color:#1a1a1a;line-height:16px;text-align:center;'
            f'text-shadow:0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;">➤</div>')
    mid = ((lat1 + lat2) / 2, (lon1 + lon2) / 2)
    return folium.Marker(location=mid, icon=folium.DivIcon(
        html=html, icon_size=(16, 16), icon_anchor=(8, 8), class_name="dir-arrow"))


def _legend_html(net: Network, color_mode: str, paths: List[BikePath]) -> str:
    def row(color, label, dashed=False):
        style = f"border-top:4px {'dashed' if dashed else 'solid'} {color};"
        return (f'<div><span style="{style}width:14px;display:inline-block;'
                f'margin-right:6px;"></span>{label}</div>')

    rows = ""
    if color_mode == "phase":
        for ph in sorted(net.phase_map()):
            cfg = net.phase_map()[ph]
            rows += row(_phase_color(ph), f"Phase {ph}: {cfg.label}")
        rows += row(STATE_COLOR, "On a state road (MassDOT approval)")
    elif color_mode == "type":
        types_seen = {p.type for p in paths}
        for t in [t for t in TYPE_COLORS if t in types_seen]:
            rows += row(TYPE_COLORS[t], TYPE_LABELS.get(t, t))
    else:
        rows += row(SINGLE_COLOR, "Bike network (proposed)")
    if any(p.status == "funded" for p in paths):
        color = FUNDED_COLOR if color_mode == "phase" else "#555555"
        rows += row(color, "Approved / funded (not yet built)", dashed=True)
    if any(p.status == "existing" for p in paths):
        color = EXISTING_COLOR if color_mode == "phase" else "#555555"
        rows += row(color, "Existing infrastructure", dashed=True)

    return f"""
    <div style="position:fixed;bottom:24px;left:24px;z-index:9999;background:white;
         padding:10px 12px;border:1px solid #999;border-radius:6px;font:12px sans-serif;
         box-shadow:0 1px 4px rgba(0,0,0,.3);">
      <b>{net.city} Bike Network</b>{rows}
    </div>"""
