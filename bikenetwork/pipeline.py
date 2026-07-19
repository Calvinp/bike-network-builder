"""Shared rendering pipeline used by BOTH the OSM-based `build.py` and the web
editor. Given a Network (paths carry their own geometry), it clips to the city
boundary, writes network.geojson, and renders the PNG + interactive HTML maps —
returning a mileage summary.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import List

from .boundary import build_polygon, clip_segments_latlon
from .geojson import paths_to_geojson
from .geometry import segments_miles
from .network_format import BikePath, Network
from .render_html import render_html
from .render_map import COLOR_MODES, render_map


def clip_paths(paths: List[BikePath], polygon, warnings, notices) -> List[BikePath]:
    """Return copies of `paths` clipped to the city polygon. Records warnings
    for proposed paths that fall entirely outside (they're dropped), notices
    for those trimmed at the line."""
    border_flagged = {n.split(":", 1)[0] for n in notices}
    out: List[BikePath] = []
    for p in paths:
        if not any(len(s) >= 2 for s in p.segments):
            continue
        full_miles = p.length_miles or segments_miles(p.segments)
        clipped, miles = clip_segments_latlon(p.segments, polygon)
        if not clipped:
            if p.status == "proposed":
                warnings.append(f"{p.name}: lies entirely outside the city "
                                f"boundary; dropped.")
            continue
        q = dataclasses.replace(p, segments=clipped, length_miles=miles)
        trimmed = full_miles - miles
        if p.status == "proposed" and trimmed > 0.05 and p.name not in border_flagged:
            notices.append(f"{p.name}: clipped to the city line "
                           f"(kept {miles:.2f} mi in the city, trimmed {trimmed:.2f} mi).")
        out.append(q)
    return out


def summarize(paths: List[BikePath], net: Network) -> dict:
    """Mileage rollups (cost is estimated live in the editor from costs.py)."""
    proposed = [p for p in paths if p.status == "proposed"]
    build = [p for p in proposed if p.jurisdiction != "state"]
    state = [p for p in proposed if p.jurisdiction == "state"]
    phase_map = net.phase_map()
    phases = []
    for num in sorted({p.phase for p in build if p.phase is not None}):
        members = [p for p in build if p.phase == num]
        cfg = phase_map.get(num)
        phases.append({
            "phase": num,
            "label": cfg.label if cfg else f"Phase {num}",
            "deadline": cfg.deadline if cfg else "",
            "miles": sum(p.length_miles for p in members),
            "lane_miles": sum(p.length_miles * p.directions for p in members),
        })
    return {
        "total_build_miles": sum(p.length_miles for p in build),
        "total_lane_miles": sum(p.length_miles * p.directions for p in build),
        "total_paths": len(build),
        "state_miles": sum(p.length_miles for p in state),
        "committed_miles": sum(p.length_miles for p in paths if p.status == "funded"),
        "existing_miles": sum(p.length_miles for p in paths if p.status == "existing"),
        "phases": phases,
    }


def render_all(net: Network, boundary, output_dir, basemap=True,
               color_mode="type", warnings=None, notices=None) -> dict:
    """Clip, then write network.geojson + map.png + map.html into output_dir.
    Returns a summary dict (mileage, warnings, notices). `net` is not mutated —
    the clipped copies exist only in the outputs."""
    if color_mode not in COLOR_MODES:
        raise ValueError(f"color_mode must be one of {COLOR_MODES} (got {color_mode!r})")
    warnings = list(warnings or [])
    notices = list(notices or [])
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    paths = list(net.paths)
    for p in paths:
        if not p.length_miles and any(len(s) >= 2 for s in p.segments):
            p.length_miles = segments_miles(p.segments)
    polygon = build_polygon(boundary) if boundary else None
    if polygon is not None:
        paths = clip_paths(paths, polygon, warnings, notices)

    fc = paths_to_geojson(paths)
    (output_dir / "network.geojson").write_text(json.dumps(fc, indent=2),
                                                encoding="utf-8")

    render_map(paths, net, output_dir / "map.png", boundary=boundary,
               basemap=basemap, color_mode=color_mode)
    render_html(paths, net, output_dir / "map.html", boundary=boundary,
                color_mode=color_mode)

    summary = summarize(paths, net)
    summary["warnings"] = warnings
    summary["notices"] = notices
    return summary
