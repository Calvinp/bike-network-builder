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

from .boundary import build_polygon, clip_segments_latlon, point_in_polygon_latlon
from .geojson import paths_to_geojson, spots_to_geojson
from .geometry import segments_miles
from .network_format import BikePath, Network, Spot, superseded_ids
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
    # An upgraded corridor (quick-build now, rebuild later) counts once at
    # full buildout; the per-phase rows below still show every phase's work.
    superseded = superseded_ids(paths)
    final_build = [p for p in build if p.id not in superseded]
    final_state = [p for p in state if p.id not in superseded]
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
        "total_build_miles": sum(p.length_miles for p in final_build),
        "total_lane_miles": sum(p.length_miles * p.directions for p in final_build),
        "total_paths": len(final_build),
        "state_miles": sum(p.length_miles for p in final_state),
        "committed_miles": sum(p.length_miles for p in paths if p.status == "funded"),
        "existing_miles": sum(p.length_miles for p in paths if p.status == "existing"),
        "phases": phases,
    }


def clip_spots(spots: List[Spot], polygon) -> List[Spot]:
    """Spots inside the city polygon (out-of-city ones silently drop)."""
    return [s for s in spots
            if s.location is not None and point_in_polygon_latlon(s.location, polygon)]


def spots_as_of_phase(spots: List[Spot], n: int) -> List[Spot]:
    """Spots visible as of phase `n` (0 = today): existing always; proposed
    once their phase arrives — a proposed spot with no phase shows in every
    phased view (it's part of the plan, just not scheduled)."""
    return [s for s in spots
            if s.status != "proposed"
            or (n > 0 and (s.phase is None or s.phase <= n))]


def paths_as_of_phase(paths: List[BikePath], n: int) -> List[BikePath]:
    """The cumulative network as of phase `n` (0 = today): existing + funded
    plus proposed paths with phase <= n, minus any path superseded by an
    upgrade that is itself in the view."""
    shown = [p for p in paths
             if p.status != "proposed" or (p.phase is not None and p.phase <= n)]
    superseded = superseded_ids(shown)
    return [p for p in shown if p.id not in superseded]


def _prepare_paths(net: Network, boundary, warnings, notices) -> List[BikePath]:
    """Measure and boundary-clip a network's paths (copies; net not mutated)."""
    paths = list(net.paths)
    for p in paths:
        if not p.length_miles and any(len(s) >= 2 for s in p.segments):
            p.length_miles = segments_miles(p.segments)
    polygon = build_polygon(boundary) if boundary else None
    if polygon is not None:
        paths = clip_paths(paths, polygon, warnings, notices)
    return paths


def _prepare_spots(net: Network, boundary) -> List[Spot]:
    polygon = build_polygon(boundary) if boundary else None
    return clip_spots(net.spots, polygon) if polygon is not None else list(net.spots)


def render_phase_exports(net: Network, boundary, output_dir, basemap=True,
                         color_mode="type", dpi=250, gif_dpi=90) -> List[Path]:
    """Write one cumulative PNG per declared phase (map-phase-N.png) plus an
    animated phases.gif stepping Today -> each phase. Returns written paths."""
    from PIL import Image

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = _prepare_paths(net, boundary, [], [])
    spots = _prepare_spots(net, boundary)
    phase_numbers = sorted(
        n.number for n in net.phases
        if any(p.status == "proposed" and p.phase == n.number for p in paths))
    if not phase_numbers:
        return []

    written: List[Path] = []
    for n in phase_numbers:
        out = output_dir / f"map-phase-{n}.png"
        render_map(paths_as_of_phase(paths, n), net, out, boundary=boundary,
                   basemap=basemap, color_mode=color_mode, dpi=dpi,
                   spots=spots_as_of_phase(spots, n),
                   title=f"{net.city} Bike Network — Phase {n}")
        written.append(out)

    # GIF frames: small fixed-size renders, one per stop. The boundary is
    # always drawn, so every frame shares the same map extent, and tight=False
    # keeps the canvas identical regardless of caption length — otherwise the
    # map visibly jumps between frames as the title grows.
    phase_map = net.phase_map()
    stops = [(0, "Today")]
    for n in phase_numbers:
        cfg = phase_map.get(n)
        caption = f"Phase {n}"
        if cfg and cfg.label:
            caption += f": {cfg.label}"
        if cfg and cfg.deadline:
            # Second line: long labels + a date overflow a single title line.
            caption += f"\nby {cfg.deadline}"
        stops.append((n, caption))
    # Every title must be the same number of lines: tight_layout shrinks the
    # axes to fit a taller title, which would make the map breathe in and out
    # as the animation plays.
    lines = max(c.count("\n") for _, c in stops) + 1
    stops = [(n, c + "\n" * (lines - 1 - c.count("\n"))) for n, c in stops]

    frames = []
    for i, (n, caption) in enumerate(stops):
        tmp = output_dir / f"_gif_frame_{i}.png"
        render_map(paths_as_of_phase(paths, n), net, tmp, boundary=boundary,
                   basemap=basemap, color_mode=color_mode, dpi=gif_dpi,
                   figsize=GIF_FIGSIZE, tight=False,
                   spots=spots_as_of_phase(spots, n),
                   title=f"{net.city} Bike Network — {caption}")
        with Image.open(tmp) as im:
            frames.append(im.convert("RGB"))
        tmp.unlink()

    # tight=False already makes every frame the same size; padding onto a
    # common canvas is a cheap belt-and-braces against a stray odd frame
    # (GIF requires uniform frames — a short one would otherwise garble).
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    padded = []
    for f in frames:
        canvas = Image.new("RGB", (w, h), "white")
        canvas.paste(f, ((w - f.width) // 2, (h - f.height) // 2))
        padded.append(canvas.convert("P", palette=Image.ADAPTIVE))
    gif = output_dir / "phases.gif"
    # Linger on "Today" and on the finished network so the loop reads clearly.
    durations = [2000] + [1400] * (len(padded) - 2) + [3000]
    padded[0].save(gif, save_all=True, append_images=padded[1:],
                   duration=durations, loop=0)
    written.append(gif)
    return written


# map.html embeds context layers inline; big ones would bloat a file people
# email around, so oversized layers are left out with a notice instead.
CONTEXT_LAYER_MAX_BYTES = 512 * 1024
CONTEXT_TOTAL_MAX_BYTES = 2 * 1024 * 1024

# Animation frame size, in inches (a landscape frame suits a city that is
# wider than it is tall, and leaves room for the title and legend).
GIF_FIGSIZE = (10, 6)


def _embeddable_context_layers(context_layers, notices):
    kept, total = [], 0
    for entry, data in context_layers or []:
        size = len(json.dumps(data, separators=(",", ":")))
        if size > CONTEXT_LAYER_MAX_BYTES or total + size > CONTEXT_TOTAL_MAX_BYTES:
            notices.append(f"{entry.get('label', entry.get('id'))}: left out of "
                           f"map.html ({size // 1024} KB is too much to embed) — "
                           f"view it in the editor instead.")
            continue
        total += size
        kept.append((entry, data))
    return kept


def render_all(net: Network, boundary, output_dir, basemap=True,
               color_mode="type", warnings=None, notices=None,
               context_layers=None) -> dict:
    """Clip, then write network.geojson + map.png + map.html into output_dir.
    Returns a summary dict (mileage, warnings, notices). `net` is not mutated —
    the clipped copies exist only in the outputs. `context_layers` is a list of
    (manifest_entry, geojson_dict) embedded in map.html as toggleable
    reference layers (the caller does the file IO)."""
    if color_mode not in COLOR_MODES:
        raise ValueError(f"color_mode must be one of {COLOR_MODES} (got {color_mode!r})")
    warnings = list(warnings or [])
    notices = list(notices or [])
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    paths = _prepare_paths(net, boundary, warnings, notices)
    spots = _prepare_spots(net, boundary)

    fc = paths_to_geojson(paths)
    # Point features ride along in the export; polyline-only readers (incl.
    # our own paths_from_geojson) skip them harmlessly.
    fc["features"] += spots_to_geojson(spots)["features"]
    (output_dir / "network.geojson").write_text(json.dumps(fc, indent=2),
                                                encoding="utf-8")

    render_map(paths, net, output_dir / "map.png", boundary=boundary,
               basemap=basemap, color_mode=color_mode, spots=spots)
    render_html(paths, net, output_dir / "map.html", boundary=boundary,
                color_mode=color_mode, spots=spots,
                context_layers=_embeddable_context_layers(context_layers, notices))

    summary = summarize(paths, net)
    summary["warnings"] = warnings
    summary["notices"] = notices
    return summary
