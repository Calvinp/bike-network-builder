"""Render the network to an interactive Leaflet map (folium) as a standalone
HTML file: pan/zoom, real street labels from the basemap, and clickable paths.
This is the best format for reviewing the plan with people. Supports the same
color modes as render_map (phase / type / single).
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

import json
import math

import folium

from .network_format import BikePath, Network
from .render_map import (EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR,
                         SPOT_EXISTING_COLOR, SPOT_GLYPHS, SPOT_LABELS,
                         SPOT_PROPOSED_COLOR, STATE_COLOR, TYPE_COLORS,
                         TYPE_LABELS, _phase_color, path_color)

Point = Tuple[float, float]


def render_html(
    paths: List[BikePath],
    net: Network,
    out_path: str | Path,
    boundary: List[List[Point]] | None = None,
    color_mode: str = "type",
    spots=None,
    context_layers=None,
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

    # One toggleable layer per legend category. In a phased plan, proposed
    # paths group by PHASE regardless of color mode so the slider below can
    # step through them cumulatively (coloring still follows the color mode).
    phased = bool(net.phases) and any(
        p.status == "proposed" and p.phase is not None for p in paths)
    groups: Dict[str, folium.FeatureGroup] = {}
    phase_groups: Dict[int, folium.FeatureGroup] = {}
    # Sort key per group so the layer checklist reads in a sensible order
    # (existing, funded, then phases in order) rather than in the arbitrary
    # order paths happen to appear in the file.
    group_order: Dict[str, tuple] = {}

    def _phase_key(n) -> str:
        cfg = phase_map.get(n)
        return (f"Phase {n}: {cfg.label}" if cfg and cfg.label
                else f"Phase {n}").strip()

    def group_for(p: BikePath):
        if p.status == "existing":
            key, order = "Existing infrastructure", (0, 0)
        elif p.status == "funded":
            key, order = "Approved / funded (not yet built)", (1, 0)
        elif phased:
            key = _phase_key(p.phase) if p.phase is not None else "Proposed"
            order = (2, p.phase if p.phase is not None else 10 ** 6)
        elif color_mode == "single":
            key, order = "Bike network (proposed)", (2, len(groups))
        elif color_mode == "type":
            key = TYPE_LABELS.get(p.type, p.type.replace("_", " "))
            order = (2, len(groups))
        elif p.jurisdiction == "state":
            key, order = "On a state road (MassDOT approval needed)", (2, len(groups))
        else:
            key, order = _phase_key(p.phase), (2, p.phase or 0)
        if key not in groups:
            groups[key] = folium.FeatureGroup(name=key, show=True)
            group_order[key] = order
        if phased and p.status == "proposed" and p.phase is not None:
            phase_groups[p.phase] = groups[key]
        return groups[key]

    # Leaflet layers per path id, so the slider can hide a path once a later
    # phase upgrades (replaces) it: id -> [(layer, group)].
    layers_by_id: Dict[str, list] = {}

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
        line = folium.PolyLine(latlon, color=color, weight=weight, opacity=0.9,
                               dash_array=dash, popup=popup, tooltip=p.name)
        line.add_to(group)
        if p.id:
            layers_by_id.setdefault(p.id, []).append((line, group))
        if p.directions == 1:
            # One-way: a rotated chevron marker mid-segment, pointing the
            # drawn way. Plain DivIcon markers — no plugin, and the dark glyph
            # with a white halo stays readable on any background.
            for seg in segs:
                marker = _direction_marker(seg)
                marker.add_to(group)
                if p.id:
                    layers_by_id.setdefault(p.id, []).append((marker, group))

    # The network's own groups first (ordered), then spots, then the
    # reference layers — the order the checklist reads top to bottom.
    for key in sorted(groups, key=lambda k: group_order[k]):
        groups[key].add_to(m)

    # Spot (point) improvements: one toggleable group of glyph markers.
    spot_entries = []  # (marker, group, phase-for-the-slider) for proposed spots
    spots_group = None
    if spots:
        spots_group = folium.FeatureGroup(name="Spot improvements", show=True)
        first_phase = min((n for n in phase_map), default=1)
        for s in spots:
            if s.location is None:
                continue
            marker = _spot_marker(s)
            marker.add_to(spots_group)
            if phased and s.status == "proposed":
                spot_entries.append((marker, spots_group,
                                     s.phase if s.phase is not None else first_phase))
        spots_group.add_to(m)

    # Context layers (reference data): unchecked by default in LayerControl.
    for entry, data in context_layers or []:
        style = entry.get("style") or {}
        color = style.get("color", "#666666")
        fg = folium.FeatureGroup(name=entry.get("label", entry.get("id")),
                                 show=False)
        folium.GeoJson(
            data,
            marker=folium.CircleMarker(radius=style.get("radius", 4),
                                       color=color, weight=1, fill=True,
                                       fill_color=color, fill_opacity=0.55),
            style_function=lambda f, c=color: {"color": c, "weight": 2,
                                               "opacity": 0.7},
        ).add_to(fg)
        fg.add_to(m)

    folium.LayerControl(collapsed=False).add_to(m)

    # The slider occupies the bottom strip, so the legend sits above it.
    m.get_root().html.add_child(folium.Element(
        _legend_html(net, color_mode, paths, bottom_px=96 if phased else 24)))
    # Chevrons are fixed-size DivIcons; hide them when zoomed out far enough
    # that they'd dwarf the streets (mirrors the editor's behavior).
    # overlayadd re-hides ones re-added via the layer control while zoomed out.
    #
    # MUST be deferred: folium emits root-script children BEFORE the statement
    # that assigns the map variable, so touching the map at parse time throws
    # and takes the whole <script> block — including the map itself — with it,
    # leaving a blank page. Everything injected here waits for DOMContentLoaded.
    m.get_root().script.add_child(folium.Element(f"""
      document.addEventListener("DOMContentLoaded", function() {{
        {m.get_name()}.on('zoomend overlayadd', function () {{
            var show = {m.get_name()}.getZoom() >= 14;
            document.querySelectorAll('.dir-arrow').forEach(function (el) {{
                el.style.display = show ? '' : 'none';
            }});
        }});
        {m.get_name()}.fire('zoomend');
      }});
    """))
    if phased:
        _add_phase_slider(m, net, paths, phase_groups, layers_by_id, spot_entries)
    m.save(str(out_path))
    return out_path


def _spot_marker(s) -> folium.Marker:
    """A spot-kind glyph as a DivIcon marker — dark glyph, white halo (same
    trick as the direction chevrons; no plugins)."""
    color = SPOT_EXISTING_COLOR if s.status == "existing" else SPOT_PROPOSED_COLOR
    glyph = SPOT_GLYPHS.get(s.kind, SPOT_GLYPHS["other"])
    label = SPOT_LABELS.get(s.kind, s.kind.replace("_", " "))
    html = (f'<div style="font-size:14px;font-weight:bold;color:{color};'
            f'line-height:16px;text-align:center;'
            f'text-shadow:0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;">{glyph}</div>')
    detail = label if s.status == "existing" else f"Proposed {label.lower()}"
    if s.status == "proposed" and s.phase is not None:
        detail += f" &middot; Phase {s.phase}"
    popup = folium.Popup(
        f"<b>{s.name or label}</b><br>{detail}"
        + (f"<br><i>{s.notes}</i>" if s.notes else ""), max_width=250)
    return folium.Marker(location=list(s.location), popup=popup,
                         tooltip=s.name or label,
                         icon=folium.DivIcon(html=html, icon_size=(16, 16),
                                             icon_anchor=(8, 8),
                                             class_name="spot-glyph"))


def _add_phase_slider(m, net: Network, paths: List[BikePath],
                      phase_groups: Dict[int, "folium.FeatureGroup"],
                      layers_by_id: Dict[str, list],
                      spot_entries=()) -> None:
    """Inject a bottom-center slider that steps Today -> Phase 1 -> ... -> full
    network, cumulatively showing phase groups and hiding paths that a shown
    later phase upgrades. Hand-written folium Elements only — folium's time
    plugins have broken map.html at runtime before (TextPath)."""
    phase_map = net.phase_map()
    stops = [(0, "Today")]
    for n in sorted(phase_groups):
        cfg = phase_map.get(n)
        caption = f"Phase {n}"
        if cfg and cfg.label:
            caption += f": {cfg.label}"
        if cfg and cfg.deadline:
            caption += f" — by {cfg.deadline}"
        stops.append((n, caption))
    if len(stops) > 1:
        stops[-1] = (stops[-1][0], stops[-1][1] + " (full network)")

    # A replaced path steps aside only while its replacement is actually on
    # screen: {layer, its group, the upgrade's phase, the upgrade's group}.
    # Without that last part, hiding the upgrade in the layer list would leave
    # the corridor blank instead of falling back to what it replaced.
    hidden_entries = []
    for p in paths:
        if (p.upgrades and p.status == "proposed" and p.phase is not None
                and p.phase in phase_groups):
            for layer, group in layers_by_id.get(p.upgrades, []):
                hidden_entries.append(
                    f'{{layer: {layer.get_name()}, group: {group.get_name()}, '
                    f'phase: {p.phase}, '
                    f'replacement: {phase_groups[p.phase].get_name()}}}')

    # Proposed spots appear once the slider reaches their phase.
    appear_entries = [
        f'{{layer: {marker.get_name()}, group: {group.get_name()}, phase: {phase}}}'
        for marker, group, phase in spot_entries]

    slider_html = f"""
    <div id="phase-slider-box" style="position:fixed;bottom:24px;left:50%;
         transform:translateX(-50%);z-index:9999;background:white;
         padding:10px 16px;border:1px solid #999;border-radius:6px;
         font:13px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);
         text-align:center;min-width:240px;">
      <div id="phase-slider-label" style="font-weight:bold;margin-bottom:4px;"></div>
      <input id="phase-slider" type="range" min="0" max="{len(stops) - 1}"
             value="{len(stops) - 1}" step="1" style="width:100%;">
    </div>"""
    m.get_root().html.add_child(folium.Element(slider_html))

    group_pairs = ", ".join(f'[{n}, {g.get_name()}]'
                            for n, g in sorted(phase_groups.items()))
    slider_js = f"""
    document.addEventListener("DOMContentLoaded", function() {{
      var stops = {json.dumps([n for n, _ in stops])};
      var labels = {json.dumps([c for _, c in stops])};
      var phaseGroups = [{group_pairs}];
      var hidden = [{", ".join(hidden_entries)}];
      var appearing = [{", ".join(appear_entries)}];
      var slider = document.getElementById("phase-slider");
      var label = document.getElementById("phase-slider-label");
      var applying = false;
      function current() {{ return stops[+slider.value]; }}
      // What the slider position alone decides: which phase groups are on.
      function applyGroups(cur) {{
        phaseGroups.forEach(function(pg) {{
          if (pg[0] <= cur) {{ {m.get_name()}.addLayer(pg[1]); }}
          else {{ {m.get_name()}.removeLayer(pg[1]); }}
        }});
      }}
      // What the slider AND the layer checkboxes decide together. Kept apart
      // so unticking a box isn't instantly overruled by the slider.
      function applyOverrides(cur) {{
        hidden.forEach(function(h) {{
          var shown = h.phase <= cur && {m.get_name()}.hasLayer(h.replacement);
          if (shown) {{ h.group.removeLayer(h.layer); }}
          else if (!h.group.hasLayer(h.layer)) {{ h.group.addLayer(h.layer); }}
        }});
        appearing.forEach(function(a) {{
          if (a.phase <= cur) {{
            if (!a.group.hasLayer(a.layer)) {{ a.group.addLayer(a.layer); }}
          }} else {{ a.group.removeLayer(a.layer); }}
        }});
      }}
      function apply() {{
        applying = true;
        label.textContent = labels[+slider.value];
        applyGroups(current());
        applyOverrides(current());
        applying = false;
      }}
      slider.addEventListener("input", apply);
      // Toggling an overlay changes what "is the replacement showing?" answers.
      {m.get_name()}.on("overlayadd overlayremove", function() {{
        if (!applying) applyOverrides(current());
      }});
      apply();
    }});"""
    m.get_root().script.add_child(folium.Element(slider_js))


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


def _legend_html(net: Network, color_mode: str, paths: List[BikePath],
                 bottom_px: int = 24) -> str:
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
    <div style="position:fixed;bottom:{bottom_px}px;left:24px;z-index:9999;background:white;
         padding:10px 12px;border:1px solid #999;border-radius:6px;font:12px sans-serif;
         box-shadow:0 1px 4px rgba(0,0,0,.3);">
      <b>{net.city} Bike Network</b>{rows}
    </div>"""
