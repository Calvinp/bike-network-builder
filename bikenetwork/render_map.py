"""Render the network to a geographic PNG that reads like a real map.

Improvements over a bare matplotlib plot:
  * a tiled street basemap (via contextily) with real street names,
  * the city boundary drawn on top,
  * Web Mercator projection so tiles line up sharply (no lat/lon "graph" axes),
  * each corridor's street name labeled,
  * a scale bar; the plot axes are hidden.

Three user-selectable color modes (shared with render_html and the editor JS):
  * "phase"  — color by implementation phase; funded/existing dashed; state
               (MassDOT) roads get their own magenta color.
  * "type"   — color by path type (quick-build, concrete, shared-use, painted);
               funded/existing still dashed.
  * "single" — the whole network in one color, to show its full extent.

A basemap requires network access; pass basemap=False (the tests do) to render
offline with a plain background.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import matplotlib

matplotlib.use("Agg")  # headless / no display
import matplotlib.pyplot as plt
from matplotlib import patheffects
from matplotlib.lines import Line2D

from .geometry import lonlat_to_mercator
from .network_format import BikePath, Network, superseded_ids

Point = Tuple[float, float]

COLOR_MODES = ("phase", "type", "single")

# Okabe-Ito palette — designed to be distinguishable for all common types of
# color blindness. Phases use the most-separable subset; line style (solid vs
# dashed) further distinguishes built/funded facilities from proposed ones.
PHASE_COLORS = {
    1: "#0072B2",  # blue
    2: "#009E73",  # bluish green
    3: "#D55E00",  # vermillion
    4: "#E69F00",  # orange
    5: "#56B4E9",  # sky blue
}
TYPE_COLORS = {
    "quick_build_separated": "#0072B2",  # blue
    "concrete_separated": "#D55E00",     # vermillion
    "shared_use_path": "#009E73",        # bluish green
    "buffered_painted": "#E69F00",       # orange
    "neighborway": "#56B4E9",            # sky blue
    # Reddish purple deliberately shared with STATE_COLOR: that color only
    # appears in phase mode, where type colors never draw. Okabe-Ito's last
    # unused hue (yellow) is illegible on a light basemap.
    "pedestrianized": "#CC79A7",         # reddish purple
}
TYPE_LABELS = {
    "quick_build_separated": "Quick-build separated lane",
    "concrete_separated": "Concrete-protected lane",
    "shared_use_path": "Shared-use path",
    "buffered_painted": "Buffered painted lane (interim)",
    "neighborway": "Neighborway (calm shared street)",
    "pedestrianized": "Pedestrianized street",
}
SINGLE_COLOR = "#0072B2"    # the whole network, one color
EXISTING_COLOR = "#000000"  # black (dashed) — existing built facilities
FUNDED_COLOR = "#E69F00"    # orange (dashed) — approved/funded, not yet built
STATE_COLOR = "#CC79A7"     # reddish purple (solid) — state (MassDOT) road, must be requested
BOUNDARY_COLOR = "#777777"  # grey (thin dashed) — city boundary

EXISTING_DASH = (0, (3.2, 2.6))
FUNDED_DASH = (0, (4.2, 2.6))

# Spot (point) improvements: text glyphs, mirrored in the editor JS and the
# HTML export. All chosen from DejaVu Sans coverage so matplotlib can draw
# the very same characters.
SPOT_GLYPHS = {
    "speed_hump": "∩",
    "raised_crosswalk": "▬",
    "raised_intersection": "◆",
    "curb_extension": "◖",
    "pedestrian_island": "▮",       # a narrow refuge median
    "hawk_signal": "◉",             # a lit signal lens
    "modal_filter": "⊘",            # no through motor traffic
    "bollards": "‖",                # a line of posts
    "retractable_bollards": "⇕",    # posts that drop and rise
    "bike_parking": "P",
    "street_trees": "T",
    "other": "●",
}
SPOT_LABELS = {
    "speed_hump": "Speed hump",
    "raised_crosswalk": "Raised crosswalk",
    "raised_intersection": "Raised intersection",
    "curb_extension": "Curb extension",
    "pedestrian_island": "Pedestrian island",
    "hawk_signal": "HAWK signal",
    "modal_filter": "Modal filter",
    "bollards": "Bollards",
    "retractable_bollards": "Retractable bollards",
    "bike_parking": "Bike parking",
    "street_trees": "Street trees",
    "other": "Spot improvement",
}


def spot_label_midsentence(kind: str) -> str:
    """A spot label as it reads inside a sentence ("Proposed raised
    crosswalk"). Lowercased word by word so acronyms keep their capitals —
    a HAWK signal is not a hawk signal."""
    label = SPOT_LABELS.get(kind, kind.replace("_", " "))
    return " ".join(w if w.isupper() else w.lower() for w in label.split())


SPOT_PROPOSED_COLOR = "#1a1a1a"  # near-black glyph (white halo)
SPOT_EXISTING_COLOR = "#707070"  # grey — already on the ground

# Names the editor assigns to freshly-drawn paths — never worth labeling.
DEFAULT_NAMES = {"new path", "existing path", "new corridor"}


def _label_text(p: BikePath) -> str:
    """What to call a path on the map: its name without any trailing
    "(A to B)" qualifier — so multi-segment corridors share one label — or
    the on_street as a fallback. Empty string = don't label."""
    name = (p.name or "").strip()
    if name.lower() in DEFAULT_NAMES:
        name = ""
    name = re.sub(r"\s*\([^)]*\)$", "", name)
    return name or (p.on_street or "").strip()


def _phase_color(phase) -> str:
    return PHASE_COLORS.get(phase, "#000000")


def path_color(p: BikePath, color_mode: str) -> str:
    """The line color for a path under a color mode. Shared logic for the PNG
    and HTML renderers (the editor JS mirrors it)."""
    if color_mode == "single":
        return SINGLE_COLOR
    if color_mode == "type":
        return TYPE_COLORS.get(p.type, "#444444")
    # "phase": funded/existing/state are their own categories, else phase color.
    if p.status == "existing":
        return EXISTING_COLOR
    if p.status == "funded":
        return FUNDED_COLOR
    if p.jurisdiction == "state":
        return STATE_COLOR
    return _phase_color(p.phase)


def _merc(geom: Sequence[Point]):
    xs, ys = [], []
    for lat, lon in geom:
        x, y = lonlat_to_mercator(lat, lon)
        xs.append(x)
        ys.append(y)
    return xs, ys


def render_map(
    paths: List[BikePath],
    net: Network,
    out_path: str | Path,
    boundary: List[List[Point]] | None = None,
    basemap: bool = True,
    color_mode: str = "type",
    title: str | None = None,
    dpi: int = 250,
    figsize: float | tuple = 16,
    spots=None,
    tight: bool = True,
) -> Path:
    """Draw proposed + existing paths over a basemap. Returns the output path.
    16in @ 250dpi gives a ~4000px print-quality export with breathing room for
    labels (and pulls sharper, more detailed basemap tiles); tests may pass a
    lower dpi to stay fast, and GIF frames use a smaller figsize.

    `tight` crops the saved image to its content — right for a standalone map,
    but WRONG for animation frames: the crop follows the title and legend, so
    frames with longer captions come out wider and the map appears to jump
    between scales. Animation frames pass tight=False for a fixed canvas."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not isinstance(figsize, (tuple, list)):
        figsize = (figsize, figsize)
    fig, ax = plt.subplots(figsize=tuple(figsize), dpi=dpi)

    all_lats: List[float] = []
    phases_seen = set()
    types_seen = set()
    has_existing = False
    has_funded = False
    has_state = False
    # Pick one representative (longest) path per street name for labeling.
    label_pick: Dict[str, BikePath] = {}
    arrow_pts: List[tuple] = []  # one-way chevron positions (labels avoid them)
    # A path drawn together with the upgrade that replaces it is completely
    # covered by it, so only its chevron would still show — an arrow claiming
    # the new lane is one-way. The replacement owns the direction now.
    replaced = superseded_ids(paths)

    for p in paths:
        segs = [s for s in p.segments if len(s) >= 2]
        if not segs:
            continue
        color = path_color(p, color_mode)
        types_seen.add(p.type)

        for seg in segs:
            all_lats.extend(pt[0] for pt in seg)
            xs, ys = _merc(seg)
            if p.status == "existing":
                ax.plot(xs, ys, color=color, linewidth=3.2,
                        linestyle=EXISTING_DASH, zorder=4,
                        solid_capstyle="round", dash_capstyle="round")
            elif p.status == "funded":
                ax.plot(xs, ys, color=color, linewidth=3.6,
                        linestyle=FUNDED_DASH, zorder=5,
                        solid_capstyle="round", dash_capstyle="round")
            else:
                # Proposed: solid over a white halo for contrast on the basemap.
                # In "phase" mode, state (MassDOT) roads are their own category —
                # they're something the City must request, not a committed
                # build, so they shouldn't read as part of the phased plan.
                ax.plot(xs, ys, color="white", linewidth=6.0, zorder=4,
                        solid_capstyle="round", alpha=0.55)
                ax.plot(xs, ys, color=color, linewidth=4.0,
                        zorder=5, solid_capstyle="round")
            if p.directions == 1 and p.id not in replaced:
                arrow_pts.append(_direction_arrow(ax, seg))

        if p.status == "existing":
            has_existing = True
        elif p.status == "funded":
            has_funded = True
        elif p.jurisdiction == "state":
            has_state = True
        elif p.phase is not None:
            phases_seen.add(p.phase)

        # Label candidates: skip very short paths — their labels are pure
        # clutter and the popup/HTML map still identifies them.
        if p.status != "existing" and not (0 < p.length_miles < 0.2):
            text = _label_text(p)
            if text and (text not in label_pick
                         or p.length_miles > label_pick[text].length_miles):
                label_pick[text] = p

    # City boundary outline.
    if boundary:
        for ring in boundary:
            bx, by = _merc(ring)
            ax.plot(bx, by, color=BOUNDARY_COLOR, linewidth=1.4,
                    linestyle=(0, (6, 3)), zorder=6, alpha=0.7)

    ax.set_aspect("equal")
    ax.autoscale()

    # Spot (point) improvements: small glyphs over the lines. Text with a
    # white stroke — the same idiom as the one-way chevrons.
    spot_pts = _draw_spots(ax, spots or [])

    # Route-name labels (drawn after autoscale so positions are stable).
    _place_route_labels(ax, label_pick, paths, avoid_pts=arrow_pts + spot_pts,
                        fig_width_in=figsize[0])

    # Tiled street basemap (network); silently fall back to a plain background.
    if basemap:
        try:
            import contextily as cx  # type: ignore
            cx.add_basemap(ax, crs="EPSG:3857", source=cx.providers.CartoDB.Voyager,
                           attribution_size=6)
        except Exception as e:  # offline / not installed
            ax.set_facecolor("#eef0ef")
            print(f"  (map basemap skipped: {e})")
    else:
        ax.set_facecolor("#eef0ef")

    _add_scale_bar(ax, all_lats)
    _add_north_arrow(ax)

    handles = _legend_handles(net, color_mode, phases_seen, types_seen,
                              has_state, has_funded, has_existing, bool(boundary))
    handles += _spot_legend_handles(spots or [])
    if handles:
        ax.legend(handles=handles, loc="upper left", fontsize=9, framealpha=0.93)

    ax.set_title(title or f"{net.city} Bike Network Vision",
                 fontsize=15, fontweight="bold")
    ax.set_axis_off()

    if tight:
        fig.tight_layout()
        fig.savefig(out_path, bbox_inches="tight")
    else:
        # Fixed canvas AND fixed axes box: tight_layout sizes the axes around
        # whatever decorations a frame happens to have (route labels, a taller
        # title), which would rescale the map from frame to frame.
        fig.subplots_adjust(left=0.02, right=0.98, bottom=0.02, top=0.88)
        fig.savefig(out_path)
    plt.close(fig)
    return out_path


def _legend_handles(net: Network, color_mode: str, phases_seen, types_seen,
                    has_state, has_funded, has_existing, has_boundary):
    handles = []
    if color_mode == "phase":
        phase_map = net.phase_map()
        for ph in sorted(phases_seen):
            cfg = phase_map.get(ph)
            text = f"Phase {ph}" + (f": {cfg.label}" if cfg and cfg.label else "")
            if cfg and cfg.deadline:
                text += f" (by {cfg.deadline})"
            handles.append(Line2D([0], [0], color=_phase_color(ph), lw=4, label=text))
        if has_state:
            handles.append(Line2D([0], [0], color=STATE_COLOR, lw=4,
                                  label="On a state road (needs MassDOT approval)"))
        if has_funded:
            handles.append(Line2D([0], [0], color=FUNDED_COLOR, lw=3.6,
                                  linestyle=FUNDED_DASH,
                                  label="Approved / funded (not yet built)"))
        if has_existing:
            handles.append(Line2D([0], [0], color=EXISTING_COLOR, lw=3.2,
                                  linestyle=EXISTING_DASH,
                                  label="Existing infrastructure"))
    elif color_mode == "type":
        for t in [t for t in TYPE_COLORS if t in types_seen]:
            handles.append(Line2D([0], [0], color=TYPE_COLORS[t], lw=4,
                                  label=TYPE_LABELS.get(t, t.replace("_", " "))))
        if has_funded:
            handles.append(Line2D([0], [0], color="#555555", lw=3.6,
                                  linestyle=FUNDED_DASH,
                                  label="Dashed: approved / funded (not yet built)"))
        if has_existing:
            handles.append(Line2D([0], [0], color="#555555", lw=3.2,
                                  linestyle=EXISTING_DASH,
                                  label="Dashed: existing infrastructure"))
    else:  # single
        handles.append(Line2D([0], [0], color=SINGLE_COLOR, lw=4,
                              label="Bike network (proposed)"))
        if has_funded:
            handles.append(Line2D([0], [0], color=SINGLE_COLOR, lw=3.6,
                                  linestyle=FUNDED_DASH,
                                  label="Approved / funded (not yet built)"))
        if has_existing:
            handles.append(Line2D([0], [0], color=SINGLE_COLOR, lw=3.2,
                                  linestyle=EXISTING_DASH,
                                  label="Existing infrastructure"))
    if has_boundary:
        handles.append(Line2D([0], [0], color=BOUNDARY_COLOR, lw=1.4,
                              linestyle=(0, (6, 3)), label=f"{net.city} city boundary"))
    return handles


def _draw_spots(ax, spots) -> list:
    """Draw spot glyphs (text + white stroke, the chevron idiom — NEVER
    marker patches). Returns the (x, y) positions so labels avoid them."""
    pts = []
    for s in spots:
        if s.location is None:
            continue
        x, y = lonlat_to_mercator(*s.location)
        color = SPOT_EXISTING_COLOR if s.status == "existing" else SPOT_PROPOSED_COLOR
        ax.text(x, y, SPOT_GLYPHS.get(s.type, SPOT_GLYPHS["other"]),
                fontsize=9, color=color, ha="center", va="center", zorder=7,
                fontweight="bold",
                path_effects=[patheffects.withStroke(linewidth=2.5,
                                                     foreground="white")])
        pts.append((x, y))
    return pts


def _spot_legend_handles(spots) -> list:
    """One legend row per spot kind present. The glyph lives in the label text
    (legend markers can't render arbitrary Unicode reliably)."""
    kinds = {s.type for s in spots}
    handles = []
    for kind in [k for k in SPOT_GLYPHS if k in kinds]:
        handles.append(Line2D([], [], linestyle="none",
                              label=f"{SPOT_GLYPHS[kind]}  "
                                    f"{SPOT_LABELS.get(kind, kind)}"))
    return handles


def _point_at_fraction(pts, t: float):
    """The point a fraction t (0..1) along a polyline's arc length."""
    dists = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    target = t * (sum(dists) or 1.0)
    acc = 0.0
    for (a, b), d in zip(zip(pts, pts[1:]), dists):
        if acc + d >= target:
            f = (target - acc) / d if d else 0.0
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        acc += d
    return pts[-1]


def _place_route_labels(ax, label_pick: Dict[str, BikePath], paths,
                        avoid_pts=(), fig_width_in: float = 16) -> None:
    """Label routes only where there's room. Candidate positions slide along
    the route; each is scored by how many vertices of OTHER paths sit under
    the label's box. Longest routes claim space first; a label whose every
    candidate is crowded (dense downtown) or long name won't fit is dropped —
    better unlabeled than covering someone else's lane. The interactive HTML
    map still names everything on hover."""
    if not label_pick:
        return
    x0, x1 = ax.get_xlim()
    span_x = x1 - x0
    # Approximate an 8pt text box in data units, scaled to the figure width.
    char_w = span_x * (8 * 0.62 / 72) / fig_width_in
    box_h = span_x * (8 * 1.9 / 72) / fig_width_in
    merc = {id(p): [[lonlat_to_mercator(*pt) for pt in seg]
                    for seg in p.segments if len(seg) >= 2] for p in paths}

    def box(mx, my, text):
        w = max(len(text), 4) * char_w
        return (mx - w / 2 - char_w, my - box_h * 0.75,
                mx + w / 2 + char_w, my + box_h * 0.75)

    def overlaps(a, b):
        return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])

    # Direction chevrons claim their spot first so no label sits on one.
    placed: List[tuple] = [(x - 2 * char_w, y - box_h, x + 2 * char_w, y + box_h)
                           for x, y in avoid_pts if x is not None]
    for text, p in sorted(label_pick.items(), key=lambda kv: -kv[1].length_miles):
        own = merc.get(id(p)) or []
        if not own:
            continue
        seg = max(own, key=len)
        others = [pt for q in paths if q is not p
                  for s in merc.get(id(q), []) for pt in s]
        best = None  # (crowd, box, position)
        for t in (0.5, 0.38, 0.62, 0.25, 0.75, 0.12, 0.88):
            mx, my = _point_at_fraction(seg, t)
            b = box(mx, my, text)
            if any(overlaps(b, pb) for pb in placed):
                continue
            crowd = sum(1 for ox, oy in others
                        if b[0] <= ox <= b[2] and b[1] <= oy <= b[3])
            if best is None or crowd < best[0]:
                best = (crowd, b, (mx, my))
            if crowd == 0:
                break
        if best is None or best[0] > 2:
            continue
        placed.append(best[1])
        ax.annotate(text, best[2], fontsize=8, zorder=7, ha="center", va="center",
                    bbox=dict(boxstyle="round,pad=0.18", fc="white", ec="none",
                              alpha=0.85))


def _direction_arrow(ax, seg: Sequence[Point]):
    """A dark chevron at the segment's midpoint, showing which way a one-way
    facility runs (the drawing order of the points IS the direction). Same
    look as the editor and the HTML map: a rotated glyph with a thin white
    OUTLINE — the outline halos evenly on every side, unlike an arrow-patch
    casing whose oversized head used to blob out behind the chevron.
    Returns the (x, y) it drew at, so labels can keep clear of it."""
    k = max(1, len(seg) // 2)
    (x0, y0), (x1, y1) = (lonlat_to_mercator(*seg[k - 1]),
                          lonlat_to_mercator(*seg[k]))
    dx, dy = x1 - x0, y1 - y0
    if not dx and not dy:
        return (None, None)
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    ax.text(mx, my, "▶",
            fontsize=9, rotation=math.degrees(math.atan2(dy, dx)),
            rotation_mode="anchor", ha="center", va="center",
            color="#1a1a1a", zorder=7,
            path_effects=[patheffects.withStroke(linewidth=2.5,
                                                 foreground="white")])
    return (mx, my)


def _add_scale_bar(ax, all_lats: List[float], miles: float = 0.5) -> None:
    """Draw a simple scale bar. Web Mercator meters are stretched by 1/cos(lat),
    so correct for the mean latitude to make the bar a true ground distance."""
    if not all_lats:
        return
    mean_lat = sum(all_lats) / len(all_lats)
    ground_m = miles * 1609.344
    merc_len = ground_m / math.cos(math.radians(mean_lat))  # mercator meters
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    bx = x0 + (x1 - x0) * 0.06
    by = y0 + (y1 - y0) * 0.05
    ax.plot([bx, bx + merc_len], [by, by], color="black", linewidth=3, zorder=8)
    ax.annotate(f"{miles} mi", (bx + merc_len / 2, by), xytext=(0, 4),
                textcoords="offset points", ha="center", fontsize=8, zorder=8)


def _add_north_arrow(ax) -> None:
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    nx = x0 + (x1 - x0) * 0.95
    ny = y0 + (y1 - y0) * 0.10
    ax.annotate("N", xy=(nx, ny), xytext=(nx, ny - (y1 - y0) * 0.05),
                ha="center", fontsize=11, fontweight="bold", zorder=8,
                arrowprops=dict(arrowstyle="-|>", color="black", lw=1.5))
