// Render the network to a print-quality PNG on a canvas — the web port of
// bikenetwork/render_map.py (matplotlib). Same look: Web Mercator projection,
// CARTO Voyager tiles (silent fallback to a plain background offline), Okabe-
// Ito colors, dashed existing/funded, white-haloed proposed lines, self-
// placing route labels with greedy decluttering, one-way chevrons drawn as
// rotated dark glyphs with a white outline, scale bar, north arrow, legend.
// Browser-only (needs a DOM canvas); everything upstream of it is node-tested.
import { lonlatToMercator } from "./geometry.js";
import { supersededIds } from "./network_format.js";
import { registry } from "./registry.js";
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR,
  EXPORT_GLYPH_KM, EXPORT_GLYPH_MAX, UNDER_CONSTRUCTION_COLOR, dashFor,
  drawsAsGlyphs, featureLayers, glyphRunPoints, labelText, phaseColor,
  pointColor, treatmentColor, treatmentGlyph, treatmentLabel,
} from "./render_common.js";

const FIG_IN = 16;                   // matplotlib figsize
const DPI = 250;
const PX_PER_PT = DPI / 72;          // 1 matplotlib point in device pixels
const MERC_HALF = 20037508.342789244;

const EXISTING_DASH = [3.2, 2.6];    // in points, like matplotlib
const FUNDED_DASH = [4.2, 2.6];
const BOUNDARY_DASH = [6, 3];

const pt = (v) => v * PX_PER_PT;
const font = (sizePt, weight = "") =>
  `${weight ? weight + " " : ""}${Math.round(pt(sizePt))}px "Segoe UI", Arial, sans-serif`;

// Only the LINE parts of a feature project into polylines; point parts are
// drawn as glyphs elsewhere.
function mercSegments(f) {
  return f.lines().map((seg) => seg.map(([lat, lon]) => lonlatToMercator(lat, lon)));
}

// The point a fraction t (0..1) along a polyline's arc length.
function pointAtFraction(pts, t) {
  const dists = [];
  for (let i = 0; i < pts.length - 1; i++) {
    dists.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  }
  const total = dists.reduce((a, b) => a + b, 0) || 1.0;
  let target = t * total;
  for (let i = 0; i < dists.length; i++) {
    if (target <= dists[i]) {
      const f = dists[i] ? target / dists[i] : 0.0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f,
              pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    }
    target -= dists[i];
  }
  return pts[pts.length - 1];
}

function legendRows(net, colorMode, seen) {
  const rows = [];
  const solid = (color, label, lw = 4) => rows.push({ color, label, lw, dash: null });
  if (colorMode === "phase") {
    for (const p of [...net.phases].sort((a, b) => a.number - b.number)) {
      if (!seen.phases.has(p.number)) continue;
      let text = `Phase ${p.number}` + (p.label ? `: ${p.label}` : "");
      if (p.target_date) text += ` (by ${p.target_date})`;
      solid(phaseColor(p.number), text);
    }
  } else if (colorMode === "treatment") {
    // One row per treatment present, in registry draw order — never one row
    // per combination, which would be unreadable.
    for (const spec of registry().sortedForDraw([...seen.types])) {
      solid(treatmentColor(spec.id), spec.label);
    }
  } else {
    solid(SINGLE_COLOR, "Bike network (proposed)");
  }
  // Status is carried by dash pattern, orthogonal to the colour modes.
  const statusColor = (fallback) => (colorMode === "phase" ? fallback : "#555555");
  if (seen.funded) {
    rows.push({ color: statusColor(FUNDED_COLOR), lw: 3.6, dash: FUNDED_DASH,
                label: "Approved / funded (not yet built)" });
  }
  if (seen.under_construction) {
    rows.push({ color: statusColor(UNDER_CONSTRUCTION_COLOR), lw: 3.4,
                dash: [2, 6], label: "Under construction" });
  }
  if (seen.existing) {
    rows.push({ color: statusColor(EXISTING_COLOR), lw: 3.2, dash: EXISTING_DASH,
                label: "Existing infrastructure" });
  }
  if (seen.boundary) {
    rows.push({ color: BOUNDARY_COLOR, lw: 1.4, dash: BOUNDARY_DASH,
                label: `${net.displayName || "Area"} boundary` });
  }
  // One row per point treatment present; the glyph stands in for the swatch.
  for (const spec of registry().sortedForDraw([...seen.points])) {
    rows.push({ glyph: spec.glyph || "●", color: "#1a1a1a", lw: 0,
                dash: null, label: spec.label });
  }
  return rows;
}

function loadTile(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function drawBasemap(ctx, view, toPx, basemap) {
  // Pick the zoom whose 512px (retina) tiles land at <= ~1 source px per
  // canvas px, then fetch every tile covering the view. Any failure means no
  // basemap (like the desktop tool offline) — the plain background stays.
  const worldSpan = 2 * MERC_HALF;
  let z = Math.ceil(Math.log2((worldSpan * view.scale) / 512));
  z = Math.max(1, Math.min(19, z));
  const n = 2 ** z;
  const tileSpan = worldSpan / n;
  const txMin = Math.max(0, Math.floor((view.minX + MERC_HALF) / tileSpan));
  const txMax = Math.min(n - 1, Math.floor((view.maxX + MERC_HALF) / tileSpan));
  const tyMin = Math.max(0, Math.floor((MERC_HALF - view.maxY) / tileSpan));
  const tyMax = Math.min(n - 1, Math.floor((MERC_HALF - view.minY) / tileSpan));
  if ((txMax - txMin + 1) * (tyMax - tyMin + 1) > 400) return false; // sanity
  const jobs = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      // Retina tiles if the provider offers them (a print-size PNG wants the
      // density); otherwise the ordinary ones.
      const template = basemap.retinaUrl || basemap.url;
      jobs.push({ tx, ty, img: loadTile(template
        .replace("{z}", z).replace("{x}", tx).replace("{y}", ty)
        .replace("{s}", "a").replace("{r}", "")) });
    }
  }
  let drewAny = false;
  for (const job of jobs) {
    const img = await job.img;
    if (!img) continue;
    const mx = job.tx * tileSpan - MERC_HALF;
    const my = MERC_HALF - job.ty * tileSpan;
    const [x, y] = toPx(mx, my);
    const size = tileSpan * view.scale;
    ctx.drawImage(img, x, y, size + 0.5, size + 0.5);
    drewAny = true;
  }
  return drewAny;
}

// `s` scales line weights with the image size, so a small animation frame
// gets proportionally thin lines instead of the 250-dpi print weights.
function strokePolyline(ctx, seg, toPx, { color, lwPt, dashPt = null, alpha = 1, s = 1 }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = pt(lwPt) * s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashPt ? dashPt.map((d) => pt(d) * s) : []);
  ctx.beginPath();
  seg.forEach(([mx, my], i) => {
    const [x, y] = toPx(mx, my);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderPng(features, net, {
  boundary = null,
  colorMode = "treatment",
  basemap = true,
  // Which tiles to draw behind the map. Configuration, not a constant — see
  // place.js.
  basemapSource = null,
  title = null,
  // Long side of the image in pixels. Animation frames pass something small;
  // the extent comes from the boundary, so every frame lands on the same
  // canvas and the map does not jump as the GIF plays.
  figPx = FIG_IN * DPI,
  asImageData = false,
} = {}) {
  // Everything below is expressed in matplotlib points; shadow the module's
  // helpers with size-aware versions so a smaller image keeps its proportions
  // (fonts, halos and line weights all shrink together).
  const S = figPx / (FIG_IN * DPI);
  const pt = (v) => v * PX_PER_PT * S;
  const font = (sizePt, weight = "") =>
    `${weight ? weight + " " : ""}${Math.round(pt(sizePt))}px "Segoe UI", Arial, sans-serif`;
  const stroke = (c, seg, to, opts) => strokePolyline(c, seg, to, { ...opts, s: S });

  // ---- projection & canvas layout -------------------------------------- //
  const phaseNumberOf = (id) => {
    const p = net.phaseMap().get(id);
    return p ? p.number : null;
  };
  const mercByPath = new Map(features.map((f) => [f, mercSegments(f)]));
  const allPts = [...mercByPath.values()].flat(2);
  const boundaryMerc = (boundary || []).map(
    (ring) => ring.map(([lat, lon]) => lonlatToMercator(lat, lon)));
  for (const ring of boundaryMerc) allPts.push(...ring);
  if (!allPts.length) throw new Error("nothing to render");

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of allPts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // matplotlib pads data limits ~5% per side on autoscale.
  const padX = (maxX - minX) * 0.05 || 1;
  const padY = (maxY - minY) * 0.05 || 1;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;

  const spanX = maxX - minX, spanY = maxY - minY;
  const longSide = figPx;                      // 4000 px by default
  const scale = longSide / Math.max(spanX, spanY);
  // A caption may span several lines ("Phase 2: Connectors\nby ..."); the band
  // grows to fit, and callers that animate keep the line count constant so the
  // map below it stays exactly the same size from frame to frame.
  const titleLines = String(title || `${net.city} Bike Network Vision`).split("\n");
  const titleH = Math.round(pt(15) * 2.2 * titleLines.length);
  const W = Math.round(spanX * scale);
  const H = Math.round(spanY * scale) + titleH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const toPx = (mx, my) => [(mx - minX) * scale, titleH + (maxY - my) * scale];
  const view = { minX, maxX, minY, maxY, scale };

  // ---- background + basemap -------------------------------------------- //
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#eef0ef";
  ctx.fillRect(0, titleH, W, H - titleH);
  let drewTiles = false;
  if (basemap) {
    try {
      drewTiles = await drawBasemap(ctx, view, toPx,
        basemapSource || { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                           retinaUrl: "" });
    } catch { /* offline */ }
  }

  // ---- the network ------------------------------------------------------ //
  const seen = { phases: new Set(), types: new Set(), points: new Set(),
                 existing: false, under_construction: false, funded: false,
                 boundary: Boolean(boundaryMerc.length) };
  // A treatment drawn together with the upgrade that replaces it is completely
  // covered by it, so only its chevron would still show — an arrow claiming
  // the new lane is one-way. The replacement owns the direction now.
  const replaced = supersededIds({
    features,
    allTreatments: () => features.flatMap((f) => f.treatments.map((t) => [f, t])),
  });
  const arrowPts = [];    // mercator chevron positions (labels avoid them)
  const labelPick = new Map();
  const pointDraws = [];  // {mx, my, glyph, color}

  // Every treatment is drawn: STACKED STROKES on one geometry, widest first.
  // strokesByFeature preserves that order, and nothing reads treatments[0].
  const layersByFeature = new Map(features.map(
    (f) => [f, featureLayers(f, colorMode, { phaseNumberOf })]));
  const strokesByFeature = new Map(features.map(
    (f) => [f, layersByFeature.get(f).strokes]));

  for (const f of features) {
    for (const t of f.treatments) {
      if (t.status === "existing") seen.existing = true;
      else if (t.status === "under_construction") seen.under_construction = true;
      else if (t.status === "funded") seen.funded = true;
      else {
        const n = phaseNumberOf(t.phase);
        if (n !== null) seen.phases.add(n);
      }
      if (f.lines().length) {
        if (drawsAsGlyphs(t.type)) {
          // A row of street trees is a run of spots, not a corridor: it
          // belongs in the points legend and draws as repeated glyphs.
          seen.points.add(t.type);
          const run = layersByFeature.get(f).glyphRuns
            .find((g) => g.treatment === t);
          for (const part of f.lines()) {
            for (const pt of glyphRunPoints(part, EXPORT_GLYPH_KM,
                                            EXPORT_GLYPH_MAX)) {
              const [mx, my] = lonlatToMercator(pt[0], pt[1]);
              pointDraws.push({ mx, my, glyph: treatmentGlyph(t.type),
                                color: run ? run.color : pointColor(t) });
            }
          }
        } else {
          seen.types.add(t.type);
        }
      }
      if (f.points().length) {
        seen.points.add(t.type);
        for (const pt of f.points()) {
          const [mx, my] = lonlatToMercator(pt[0], pt[1]);
          pointDraws.push({ mx, my, glyph: treatmentGlyph(t.type),
                            color: pointColor(t) });
        }
      }
    }

    // Label candidates: skip very short features — their labels are clutter.
    const km = f.length_km || 0;
    const onlyExisting = f.treatments.every((t) => t.status === "existing");
    if (!onlyExisting && !(km > 0 && km < 0.32)) {
      const text = labelText(f);
      const prev = labelPick.get(text);
      if (text && (!prev || km > (prev.length_km || 0))) labelPick.set(text, f);
    }
  }

  // Pass 1: white halos under every non-existing stroke, so a line stays
  // readable over a busy basemap. Existing lines draw dashed in this pass —
  // they are context and sit underneath.
  for (const f of features) {
    for (const stroke_ of strokesByFeature.get(f)) {
      const t = stroke_.treatment;
      for (const seg of mercByPath.get(f)) {
        if (t.status === "existing") {
          stroke(ctx, seg, toPx, { color: stroke_.color, lwPt: 3.2,
                                   dashPt: EXISTING_DASH });
        } else {
          stroke(ctx, seg, toPx, { color: "#ffffff",
                                   lwPt: stroke_.weight + 2.0, alpha: 0.55 });
        }
      }
    }
  }
  // Pass 2: the strokes themselves, widest first so the highest-ranked
  // treatment ends up on top.
  for (const f of features) {
    const { spine, glyphRuns } = layersByFeature.get(f);
    // Nothing but counted treatments: lay a hairline so the run reads as one
    // object spanning a block rather than as unexplained scattered glyphs.
    if (spine && glyphRuns.length) {
      for (const seg of mercByPath.get(f)) {
        stroke(ctx, seg, toPx, { color: glyphRuns[0].color, lwPt: 1.2,
                                 dashPt: [1, 5], alpha: 0.55 });
      }
    }
    const strokes = strokesByFeature.get(f);
    for (const stroke_ of strokes) {
      const t = stroke_.treatment;
      if (t.status === "existing") continue;      // already drawn in pass 1
      const dashPt = t.status === "funded" ? FUNDED_DASH
        : t.status === "under_construction" ? [2, 6] : null;
      for (const seg of mercByPath.get(f)) {
        stroke(ctx, seg, toPx, { color: stroke_.color,
                                 lwPt: stroke_.weight * 0.8, dashPt });
        if (t.travel === "one_way" && seg.length >= 2 && !replaced.has(t.id)) {
          const k = Math.max(1, Math.floor(seg.length / 2));
          const [x0, y0] = seg[k - 1];
          const [x1, y1] = seg[k];
          if (x1 !== x0 || y1 !== y0) {
            arrowPts.push({ mx: (x0 + x1) / 2, my: (y0 + y1) / 2,
                            angle: Math.atan2(y1 - y0, x1 - x0) });
          }
        }
      }
    }
  }

  // City boundary outline.
  for (const ring of boundaryMerc) {
    stroke(ctx, ring, toPx,
      { color: BOUNDARY_COLOR, lwPt: 1.4, dashPt: BOUNDARY_DASH, alpha: 0.7 });
  }

  // One-way chevrons: rotated dark glyph with an even white outline (never an
  // arrow patch — its casing head blobs out behind the chevron).
  for (const a of arrowPts) {
    const [x, y] = toPx(a.mx, a.my);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-a.angle);          // canvas y grows downward; mercator y up
    ctx.font = font(9);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = pt(2.5);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText("▶", 0, 0);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText("▶", 0, 0);
    ctx.restore();
  }

  // Point treatments: the same glyph-with-a-white-outline idiom the chevrons
  // use, so every surface draws the same characters the same way.
  const spotPts = [];   // mercator, so route labels can steer around them
  for (const d of pointDraws) {
    const [x, y] = toPx(d.mx, d.my);
    ctx.save();
    ctx.font = font(9, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = pt(2.5);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(d.glyph, x, y);
    ctx.fillStyle = d.color;
    ctx.fillText(d.glyph, x, y);
    ctx.restore();
    spotPts.push({ mx: d.mx, my: d.my });
  }

  // ---- route labels (greedy declutter, drop rather than overlap) -------- //
  // Same box math as the desktop tool: an 8pt text box in data units.
  const charW = spanX * ((8 * 0.62) / 72) / FIG_IN;
  const boxH = spanX * ((8 * 1.9) / 72) / FIG_IN;
  const box = (mx, my, text) => {
    const w = Math.max(text.length, 4) * charW;
    return [mx - w / 2 - charW, my - boxH * 0.75, mx + w / 2 + charW, my + boxH * 0.75];
  };
  const overlaps = (a, b) =>
    !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
  const placed = [...arrowPts, ...spotPts].map((a) =>
    [a.mx - 2 * charW, a.my - boxH, a.mx + 2 * charW, a.my + boxH]);

  const ranked = [...labelPick.entries()]
    .sort((a, b) => (b[1].length_km || 0) - (a[1].length_km || 0));
  for (const [text, p] of ranked) {
    const own = mercByPath.get(p) || [];
    if (!own.length) continue;
    const seg = own.reduce((m, s) => (s.length > m.length ? s : m), own[0]);
    const others = features.filter((q) => q !== p)
      .flatMap((q) => mercByPath.get(q) || []).flat();
    let best = null;   // [crowd, box, [mx, my]]
    for (const t of [0.5, 0.38, 0.62, 0.25, 0.75, 0.12, 0.88]) {
      const [mx, my] = pointAtFraction(seg, t);
      const b = box(mx, my, text);
      if (placed.some((pb) => overlaps(b, pb))) continue;
      const crowd = others.reduce((c, [ox, oy]) =>
        c + (b[0] <= ox && ox <= b[2] && b[1] <= oy && oy <= b[3] ? 1 : 0), 0);
      if (!best || crowd < best[0]) best = [crowd, b, [mx, my]];
      if (crowd === 0) break;
    }
    if (!best || best[0] > 2) continue;
    placed.push(best[1]);
    const [x, y] = toPx(best[2][0], best[2][1]);
    ctx.font = font(8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width;
    const padPx = pt(8) * 0.35;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x - w / 2 - padPx, y - pt(8) * 0.75 - padPx / 2,
              w + 2 * padPx, pt(8) * 1.5 + padPx, pt(2));
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#000000";
    ctx.fillText(text, x, y);
  }

  // ---- map furniture ----------------------------------------------------- //
  const mapTop = titleH, mapH = H - titleH;
  // Scale bar (0.5 mi, corrected for mercator stretch at the mean latitude).
  const lats = features.flatMap((f) => f.geometry.flat()).map(([lat]) => lat);
  if (lats.length) {
    const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    const mercLen = (0.5 * 1609.344) / Math.cos((meanLat * Math.PI) / 180);
    const bx = 0.06 * W;
    const by = mapTop + mapH * 0.95;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = pt(3);
    ctx.lineCap = "butt";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + mercLen * scale, by);
    ctx.stroke();
    ctx.font = font(8);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#000000";
    ctx.fillText("0.5 mi", bx + (mercLen * scale) / 2, by - pt(2));
  }
  // North arrow.
  {
    const nx = 0.95 * W;
    const ny = mapTop + mapH * 0.90;
    const len = mapH * 0.05;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#000000";
    ctx.lineWidth = pt(1.5);
    ctx.beginPath();
    ctx.moveTo(nx, ny + len);
    ctx.lineTo(nx, ny + len * 0.35);
    ctx.stroke();
    ctx.beginPath();               // arrowhead
    ctx.moveTo(nx, ny);
    ctx.lineTo(nx - pt(4), ny + len * 0.45);
    ctx.lineTo(nx + pt(4), ny + len * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.font = font(11, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("N", nx, ny + len + pt(12));
  }
  // Legend (upper left).
  {
    const rows = legendRows(net, colorMode, seen);
    if (rows.length) {
      ctx.font = font(9);
      const sample = pt(22), gap = pt(6), rowH = pt(13), padBox = pt(8);
      const textW = Math.max(...rows.map((r) => ctx.measureText(r.label).width));
      const bw = padBox * 2 + sample + gap + textW;
      const bh = padBox * 2 + rows.length * rowH;
      const bx = pt(6), by = mapTop + pt(6);
      ctx.save();
      ctx.globalAlpha = 0.93;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#cccccc";
      ctx.lineWidth = pt(0.8);
      roundRect(ctx, bx, by, bw, bh, pt(3));
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      rows.forEach((r, i) => {
        const cy = by + padBox + i * rowH + rowH / 2;
        if (r.glyph) {                       // spot kinds show their glyph
          ctx.font = font(9, "bold");
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = r.color;
          ctx.fillText(r.glyph, bx + padBox + sample / 2, cy);
          ctx.font = font(9);
        } else {
          ctx.strokeStyle = r.color;
          ctx.lineWidth = pt(r.lw);
          ctx.lineCap = "round";
          ctx.setLineDash(r.dash ? r.dash.map(pt) : []);
          ctx.beginPath();
          ctx.moveTo(bx + padBox, cy);
          ctx.lineTo(bx + padBox + sample, cy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = "#000000";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(r.label, bx + padBox + sample + gap, cy);
      });
    }
  }
  // Tile attribution.
  if (drewTiles) {
    ctx.font = font(6);
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText("© OpenStreetMap contributors © CARTO", W - pt(3), H - pt(3));
  }
  // Title band.
  ctx.fillStyle = "#000000";
  ctx.font = font(15, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  {
    const lineH = titleH / titleLines.length;
    titleLines.forEach((line, i) => {
      ctx.fillText(line, W / 2, lineH * (i + 0.5));
    });
  }

  // Animation frames want raw pixels (to hand straight to the GIF encoder)
  // rather than a compressed PNG blob.
  if (asImageData) {
    return { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data };
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob)
      : reject(new Error("PNG export failed (canvas too large for this browser?)"))),
    "image/png");
  });
}
